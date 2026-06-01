// Phase 6.13 — Admin Users panel.
//
// Endpoints for the in-app Users management UI. All routes require an
// authenticated user with isAdmin=true. Every mutation writes an AuditLog
// entry so a separate admin can review what happened and when.
//
// API surface:
//   GET    /admin/users              List all users (sorted by createdAt desc)
//   POST   /admin/users              Invite a new user (creates DB row, awaits first SSO)
//   PATCH  /admin/users/:id          Promote / demote / activate / deactivate / edit
//   GET    /admin/audit-logs         Recent admin actions (paginated, default 100)
//   POST   /admin/users/bulk-import  Phase 5 — CSV bulk-import (#189)
//
// Safeguards (Phase 6.13 spec):
//   - Can't demote the LAST remaining active admin.
//   - Can't deactivate yourself (would brick the panel for you).
//   - Can't change your own admin flag — ask another admin.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@ace/db';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import * as telnyx from '../telnyx/numbers.js';
import { sendWelcomeEmail, sendLineAssignedEmail } from '../email/sendgrid.js';
import { sendLineAssignedCard } from '../lib/teamsNotify.js';
import { backfillMigratedDidHistory } from '../lib/migrationBackfill.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  storeInitialTokens,
  getConnectionStatus,
  disconnectGraph,
} from '../auth/microsoft.js';
import { recordAudit } from '../lib/audit.js';
import { ensureUserDid } from '../lib/userDid.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const u = request.user as JwtPayload | undefined;
  if (!u?.isAdmin) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}

function publicUser(u: {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isActive: boolean;
  provider: string;
  sipUsername: string | null;
  didNumber: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    provider: u.provider,
    sipUsername: u.sipUsername,
    didNumber: u.didNumber,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

// Audit helper — best-effort. We never want an audit-log write to fail the
// admin action itself, so log + swallow.
// v0.10.0 — `recordAudit` moved to ../lib/audit.ts so non-admin routes
// (specifically /me/active-did and friends) can write audit entries too.

const InviteSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  sipUsername: z.string().max(120).nullable().optional(),
  sipPassword: z.string().max(200).nullable().optional(),
  didNumber: z.string().max(20).nullable().optional(),
  isAdmin: z.boolean().optional(),
  localPassword: z.string().min(8).max(200).nullable().optional(),
});

const UpdateSchema = z.object({
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  sipUsername: z.string().max(120).nullable().optional(),
  sipPassword: z.string().max(200).nullable().optional(),
  didNumber: z.string().max(20).nullable().optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  localPassword: z.string().min(8).max(200).nullable().optional(),
});

// Phase 5 (#189) — bulk import schema. Each row mirrors the CSV column set.
// Rows without sipPassword are accepted; user gets created but can't register
// against Telnyx until an admin fills the password in later (staged rollout).
const BulkRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(80).optional().nullable(),
  lastName: z.string().max(80).optional().nullable(),
  sipUsername: z.string().max(120).optional().nullable(),
  sipPassword: z.string().max(200).optional().nullable(),
  didNumber: z.string().max(20).optional().nullable(),
  isAdmin: z.boolean().optional().nullable(),
  phoneExtension: z.string().max(20).optional().nullable(),
});
const BulkImportSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  rows: z.array(BulkRowSchema).min(1).max(500),
});

// Phase 8 (#216-220) — Pulse-to-ACE migration via PendingUser staging.
//
// PendingUser rows come from the new admin "Pending Users" tab CSV upload.
// Nothing on Telnyx changes until an admin clicks Invite + Confirm on a
// specific row. The invite endpoint then orchestrates Telnyx + DB + email
// per the 3 modal toggles (didMode / credsMode / repointWebhook).
const PendingUserRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(80).optional().nullable(),
  lastName: z.string().max(80).optional().nullable(),
  pulseVoipExt: z.string().min(1).max(120),
  pulseVoipNumber: z.string().min(1).max(20),
  pulseExtPassword: z.string().min(1).max(200),
  pulseConnectionName: z.string().max(120).optional().nullable(),
  pulseUserStatus: z.string().max(20).optional().nullable(),
});
const PendingUserImportSchema = z.object({
  rows: z.array(PendingUserRowSchema).min(1).max(500),
});

// v0.9.7 — PATCH /admin/pending-users/:id schema. All fields optional so the
// admin can edit one column at a time. Server-side restrictions block edits
// to Pulse credentials on already-invited rows (those values were already
// pushed to Telnyx; changing them in PendingUser would silently drift from
// reality, so we force a delete + re-invite for those changes instead).
const PendingUserPatchSchema = z.object({
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  email: z.string().email().optional(),
  pulseVoipExt: z.string().min(1).max(120).optional(),
  pulseVoipNumber: z.string().min(1).max(20).optional(),
  pulseExtPassword: z.string().min(1).max(200).optional(),
  pulseConnectionName: z.string().max(120).nullable().optional(),
  pulseUserStatus: z.string().max(20).nullable().optional(),
});

const InviteFromPendingSchema = z.object({
  // 'existing'   = keep the user's current Pulse DID
  // 'new'        = purchase a fresh local US DID from Telnyx
  // 'unassigned' = pick an existing ACE-owned DID that isn't routed anywhere
  didMode: z.enum(['existing', 'new', 'unassigned']),
  credsMode: z.enum(['existing', 'new']),
  repointWebhook: z.boolean(),
  sendEmail: z.boolean(),
  // Optional override for the area code when purchasing a new DID. Defaults
  // to extracting from pulseVoipNumber (so user keeps a local-feeling number).
  newDidAreaCode: z.string().regex(/^\d{3}$/).optional(),
  // E.164 of the unassigned DID the admin picked (required when didMode === 'unassigned').
  unassignedDidNumber: z.string().optional(),
});

// v0.10.22 — Small HTML page returned by the MS OAuth callback. Shows a
// success/error message and auto-closes the popup window after 3 seconds.
// Kept inline (not a template file) so deploys stay simple.
function buildCallbackHtml(success: boolean, message: string): string {
  const safeMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const color = success ? '#16a34a' : '#dc2626';
  const icon = success ? '✓' : '✕';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ACE Dialer — Teams Connection</title>
<style>
  body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #0f172a; background: #f1f5f9; margin: 0;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; padding: 32px 40px; border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08); max-width: 420px; text-align: center; }
  .icon { font-size: 48px; color: ${color}; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: ${color}; }
  p { margin: 0 0 12px; color: #475569; }
  .close { font-size: 13px; color: #94a3b8; margin-top: 24px; }
</style></head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <h1>${success ? 'Connected' : 'Connection failed'}</h1>
  <p>${safeMessage}</p>
  <div class="close">This window will close automatically.</div>
</div>
<script>
  // Notify opener (the dialer settings page) that the flow completed.
  try { window.opener && window.opener.postMessage(
    { type: 'ms-oauth-result', success: ${success} }, '*'); } catch (e) {}
  setTimeout(() => { try { window.close(); } catch (e) {} }, 3000);
</script>
</body></html>`;
}

// v0.10.27 — Minimal RFC 4180 CSV parser for Telnyx CDR/MDR uploads.
// Handles quoted fields, escaped quotes (""), trims whitespace, returns
// rows as { columnName: value } objects keyed by the header row.
//
// Limitations: doesn't support embedded newlines inside quoted fields.
// Telnyx CSV exports don't use them, so this is fine for our use case.
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Map a parsed Telnyx CDR CSV row to a Prisma Call.create input.
// Returns null if required fields are missing.
function mapTelnyxCdrCsvRow(
  row: Record<string, string>,
  userId: number,
  userDidId: number,
): {
  userId: number;
  telnyxCallId: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number;
  hangupCause: string | null;
  userDidId: number;
} | null {
  // Prefer "Call UUID" (Telnyx call_session_id-style UUID), fall back to
  // "Unique CDR ID". We need a stable telnyxCallId for dedup.
  const telnyxCallId = (row['Call UUID'] || row['Unique CDR ID'] || '').trim();
  const fromNumber = (row['Originating Number'] || '').trim();
  const toNumber = (row['Terminating number'] || row['Full Terminating number'] || '').trim();
  const startStr = (row['Start Timestamp(UTC)'] || row['Start Timestamp'] || '').trim();
  if (!telnyxCallId || !fromNumber || !toNumber || !startStr) return null;

  const direction = (row['Direction'] || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const startedAt = new Date(startStr.replace(' ', 'T') + 'Z');
  const answeredStr = (row['Answer Timestamp'] || '').trim();
  const answeredAt = answeredStr ? new Date(answeredStr.replace(' ', 'T') + 'Z') : null;
  const endedStr = (row['End Timestamp'] || '').trim();
  const endedAt = endedStr ? new Date(endedStr.replace(' ', 'T') + 'Z') : null;
  const durationSeconds = parseInt(row['Call duration'] || '0', 10) || 0;
  const hangupCause = (row['Hangup cause'] || '').trim() || null;

  // Status: completed if duration > 0; otherwise missed for inbound, failed for outbound.
  let status: string;
  if (durationSeconds > 0) status = 'completed';
  else if (direction === 'inbound') status = 'missed';
  else status = 'failed';

  return {
    userId,
    telnyxCallId,
    direction,
    fromNumber,
    toNumber,
    status,
    startedAt,
    answeredAt,
    endedAt,
    durationSeconds,
    hangupCause,
    userDidId,
  };
}

// Map a parsed Telnyx MDR CSV row to a Prisma Message.create input.
// Telnyx MDR CSV has columns: "Message ID", "From", "To", "Direction",
// "Body", "Created At", "Status" (or variations). We accept a few common
// header naming variants.
function mapTelnyxMdrCsvRow(
  row: Record<string, string>,
  userId: number,
  userDidId: number,
  ourDidE164: string,
): {
  userId: number;
  telnyxMessageId: string;
  threadKey: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  userDidId: number;
} | null {
  const telnyxMessageId = (
    row['Message ID'] || row['MessageID'] || row['ID'] || row['Unique MDR ID'] || ''
  ).trim();
  const fromNumber = (row['From'] || row['Originating Number'] || '').trim();
  const toNumber = (row['To'] || row['Terminating number'] || '').trim();
  const tsStr = (row['Created At'] || row['Start Timestamp'] || row['Sent At'] || '').trim();
  if (!telnyxMessageId || !fromNumber || !toNumber) return null;

  // Direction: trust the CSV's Direction column; otherwise infer from our DID.
  const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
  const ourLast10 = last10(ourDidE164);
  let direction = (row['Direction'] || '').toLowerCase();
  if (direction !== 'inbound' && direction !== 'outbound') {
    direction = last10(fromNumber) === ourLast10 ? 'outbound' : 'inbound';
  }

  const threadKey = direction === 'outbound' ? toNumber : fromNumber;
  const body = (row['Body'] || row['Text'] || '').trim();
  const statusRaw = (row['Status'] || '').toLowerCase().trim();
  const status = ['queued', 'sent', 'delivered', 'failed', 'received'].includes(statusRaw)
    ? statusRaw
    : direction === 'inbound'
      ? 'received'
      : 'delivered';
  const sentAt = tsStr ? new Date(tsStr.replace(' ', 'T') + 'Z') : null;

  return {
    userId,
    telnyxMessageId,
    threadKey,
    direction,
    fromNumber,
    toNumber,
    body,
    mediaUrls: [],
    status,
    sentAt,
    deliveredAt: status === 'delivered' && sentAt ? sentAt : null,
    userDidId,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  // ───────────────────────── GET /admin/users ─────────────────────────
  app.get(
    '/admin/users',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const rows = await prisma.user.findMany({
        // v0.9.12 — hide tombstoned rows from the admin Users list. When a
        // hard-delete falls back to anonymize (FK history), the email is
        // rewritten to `deleted-{id}@deleted.ace.local`. These rows only
        // exist to keep call/SMS/voicemail FK references valid for audit
        // history; they have no PII and there's nothing useful an admin
        // can do with them, so we exclude them from both the default view
        // and the "Show deactivated" toggle.
        where: { email: { not: { endsWith: '@deleted.ace.local' } } },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isAdmin: true,
          isActive: true,
          provider: true,
          sipUsername: true,
          didNumber: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
      return { items: rows.map(publicUser) };
    },
  );

  // ───────────────────────── POST /admin/users ────────────────────────
  app.post(
    '/admin/users',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const parsed = InviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { email, firstName, lastName, sipUsername, sipPassword, didNumber, isAdmin, localPassword } = parsed.data;
      const normEmail = email.trim().toLowerCase();

      const existing = await prisma.user.findUnique({ where: { email: normEmail }, select: { id: true } });
      if (existing) {
        return reply.code(409).send({ error: 'A user with this email already exists.' });
      }

      const passwordHash = localPassword ? await bcrypt.hash(localPassword, 10) : null;
      const created = await prisma.user.create({
        data: {
          email: normEmail,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          sipUsername: sipUsername ?? null,
          sipPassword: sipPassword ?? null,
          didNumber: didNumber ?? null,
          isAdmin: !!isAdmin,
          isActive: true,
          provider: localPassword ? 'local' : 'microsoft',
          passwordHash,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          isAdmin: true, isActive: true, provider: true,
          sipUsername: true, didNumber: true, lastLoginAt: true, createdAt: true,
        },
      });

      // v0.10.0 — Ensure UserDid row when the invite includes a DID.
      // Without this, the new user has User.didNumber populated but no
      // UserDid row, which breaks DidSwitcher + SMS + line badges. See
      // apps/api/src/lib/userDid.ts for the full rationale.
      if (didNumber) {
        await ensureUserDid({
          userId: created.id,
          didNumber,
          isDefault: true,
        });
      }

      await recordAudit(u.sub, 'user.invited', created.id, {
        email: normEmail,
        invitedAs: created.isAdmin ? 'admin' : 'user',
        provider: created.provider,
        hasLocalPassword: !!localPassword,
        hasSipCreds: !!(sipUsername && sipPassword),
        didNumber: didNumber ?? null,
      });

      return publicUser(created);
    },
  );

  // ───────────────────────── POST /admin/users/invite-new ─────────────
  // Brand-new hire: no Pulse history, no pre-provisioned Telnyx assets.
  // We do the full auto-provision in one shot:
  //   1. Create new Telnyx Credential Connection (returns sipUsername + sipPassword)
  //   2. Search available local DIDs in the area code
  //   3. Purchase one, route to the new connection
  //   4. Bind the DID to ACE's messaging profile (SMS routing)
  //   5. Create User row with all the captured values
  //   6. Send welcome email
  // Every step is logged into `steps`, same shape as the pending-users
  // invite endpoint, so the UI can show a per-step success/error table.
  app.post(
    '/admin/users/invite-new',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const InviteNewSchema = z.object({
        email: z.string().email(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        // 'new'        = purchase a fresh local US DID from Telnyx (~$0.45)
        // 'unassigned' = pick an existing ACE-owned DID not routed anywhere ($0)
        didMode: z.enum(['new', 'unassigned']).default('new'),
        newDidAreaCode: z.string().regex(/^\d{3}$/).optional(),
        // E.164 of the unassigned DID the admin picked. Required when
        // didMode === 'unassigned'.
        unassignedDidNumber: z.string().optional(),
        isAdmin: z.boolean().optional(),
        sendEmail: z.boolean().default(true),
      });
      const parsed = InviteNewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const {
        email, firstName, lastName,
        didMode, newDidAreaCode, unassignedDidNumber,
        isAdmin: makeAdmin, sendEmail,
      } = parsed.data;

      if (didMode === 'unassigned' && !unassignedDidNumber) {
        return reply.code(400).send({
          error: 'unassignedDidNumber is required when didMode=unassigned',
        });
      }
      const normEmail = email.trim().toLowerCase();

      // v0.9.10 — accept soft-deactivated rows as recyclable. After a hard-
      // delete that fell back to soft-deactivate (FK constraints kept the
      // row alive for history), the email is still taken. Without this we'd
      // refuse to re-invite and admin couldn't recover. If the existing row
      // is ACTIVE, refuse — that's a real collision.
      const dup = await prisma.user.findUnique({
        where: { email: normEmail },
        select: { id: true, isActive: true },
      });
      const recycleExistingUserId = dup && !dup.isActive ? dup.id : null;
      if (dup && dup.isActive) {
        return reply.code(409).send({
          error: 'A user with this email already exists and is active. Deactivate them first if you want to replace them.',
        });
      }

      const steps: Array<{ step: string; ok: boolean; error?: string }> = [];
      const step = (label: string, ok: boolean, error?: string) =>
        steps.push({ step: label, ok, ...(error ? { error } : {}) });

      // 1) Create Telnyx Credential Connection
      const slug = (firstName || normEmail.split('@')[0])
        .toLowerCase()
        .replace(/[^a-z0-9-]/gi, '');
      const connectionName = `${slug}-ace-${Date.now().toString(36).slice(-5)}`;
      // Telnyx user_name: letters + digits only — no underscores, hyphens,
      // or spaces (see Telnyx error code 10015).
      const userName = `ace${slug.replace(/[^a-z0-9]/gi, '').slice(0, 20)}${Date.now().toString(36).slice(-6)}`;

      // v0.9.7 — template-clone path. If the template DID/ID resolves, clone
      // its outbound voice profile + channel limits + codecs onto the new
      // connection so the user can actually PLACE calls from minute one.
      // Fall back to plain create if anything goes wrong. Initialize to
      // empty so TypeScript's flow analysis sees a definite assignment
      // (both branches below assign, but TS can't prove that across two
      // separate `if` blocks).
      let sipUsername = '';
      let sipPassword = '';
      let connectionId = '';
      const tplIdRes = await telnyx.resolveTemplateConnectionId();
      const tplId = tplIdRes.ok ? tplIdRes.data : null;
      let usedTemplate = false;
      if (tplId) {
        const cloneRes = await telnyx.createConnectionFromTemplate({
          connectionName,
          userName,
          templateConnectionId: tplId,
        });
        if (cloneRes.ok && cloneRes.connection) {
          sipUsername = cloneRes.connection.user_name;
          sipPassword = cloneRes.connection.password ?? '';
          connectionId = cloneRes.connection.id;
          usedTemplate = true;
          if (cloneRes.templateApplied) {
            step('clone Telnyx connection from template (outbound voice profile + limits)', true);
          } else {
            step('clone Telnyx connection from template — created but PATCH partial', true);
            for (const w of cloneRes.warnings) step(`template warning: ${w}`, false);
          }
        } else {
          step('clone Telnyx connection from template', false, JSON.stringify(cloneRes.error ?? cloneRes.warnings));
        }
      } else if (!tplIdRes.ok) {
        step('resolve template connection id', false, JSON.stringify(tplIdRes.error));
      } else {
        step('resolve template connection id', false, 'No TELNYX_TEMPLATE_CONNECTION_ID/DID configured');
      }

      if (!usedTemplate) {
        const conn = await telnyx.createCredentialConnection({ connectionName, userName });
        if (!conn.ok || !conn.data) {
          step('create Telnyx Credential Connection (fallback)', false, JSON.stringify(conn.error));
          return reply.code(502).send({ error: 'createCredentialConnection failed', steps });
        }
        sipUsername = conn.data.data.user_name;
        sipPassword = conn.data.data.password ?? '';
        connectionId = conn.data.data.id;
        step('create Telnyx Credential Connection (fallback — no template)', true);
      }

      // 2 + 3) Get a DID and route it to the new connection. Two paths:
      //   - 'unassigned': look up an already-owned DID, assign it (no purchase)
      //   - 'new':        search Telnyx inventory, purchase, route on order
      let targetDid: string;
      if (didMode === 'unassigned') {
        const picked = unassignedDidNumber!;
        const lookup = await telnyx.findNumberByE164(picked);
        if (!lookup.ok || !lookup.data) {
          step('look up unassigned DID in Telnyx', false, `Number not found: ${picked}`);
          return reply.code(502).send({ error: 'Unassigned DID lookup failed', steps });
        }
        const assign = await telnyx.assignDidToConnection(lookup.data.id, connectionId);
        if (!assign.ok) {
          step(`assign unassigned DID ${picked}`, false, JSON.stringify(assign.error));
          return reply.code(502).send({ error: 'Unassigned DID assignment failed', steps });
        }
        targetDid = picked;
        step(`assign unassigned DID ${picked} to new connection`, true);
      } else {
        // Search Telnyx inventory for a free local number in the area code.
        const areaCode = newDidAreaCode ?? '732';
        const search = await telnyx.searchAvailableLocal(areaCode, 5);
        if (!search.ok || !search.data?.data?.length) {
          step('search available DIDs', false, `No numbers available in area code ${areaCode}`);
          return reply.code(502).send({ error: 'No DIDs available', steps });
        }
        targetDid = search.data.data[0].phone_number;
        step(`found candidate DID ${targetDid} in area ${areaCode}`, true);

        // Purchase the DID and route to the new connection (billable Telnyx call).
        const purchase = await telnyx.purchaseDid(targetDid, connectionId);
        if (!purchase.ok || !purchase.data) {
          step(`purchase DID ${targetDid}`, false, JSON.stringify(purchase.error));
          return reply.code(502).send({ error: 'DID purchase failed', steps });
        }
        step(`purchase DID ${targetDid} (routed to new connection)`, true);
      }

      // 4) Bind the DID to ACE's messaging profile so SMS works
      if (config.telnyxMessagingProfileId) {
        const lookup = await telnyx.findNumberByE164(targetDid);
        if (!lookup.ok || !lookup.data) {
          step('look up DID to bind messaging profile', false, `Not found: ${targetDid}`);
        } else {
          const bind = await telnyx.assignNumberMessagingProfile(
            lookup.data.id,
            config.telnyxMessagingProfileId,
          );
          if (bind.ok) {
            step('bind DID to ACE messaging profile (SMS routing)', true);
          } else {
            step('bind DID to ACE messaging profile', false, JSON.stringify(bind.error));
          }
        }
      } else {
        step('bind messaging profile', false,
          'Skipped: TELNYX_MESSAGING_PROFILE_ID env var not set');
      }

      // 4.5) v0.9.11 — Set Caller ID Override = the user's OWN DID so calls
      // placed from the WebRTC dialer present THIS user's number as the
      // caller ID (not the template's). Maps to outbound.ani_override on
      // the Credential Connection with ani_override_type="always".
      // Done AFTER DID purchase/assign so we have a real E.164 to set.
      if (connectionId && targetDid) {
        const didDigits = targetDid.replace(/[^\d]/g, '');
        const didE164ForOverride = targetDid.startsWith('+')
          ? targetDid
          : didDigits.length === 11 && didDigits.startsWith('1')
            ? `+${didDigits}`
            : didDigits.length === 10
              ? `+1${didDigits}`
              : `+${didDigits}`;
        const override = await telnyx.setConnectionCallerIdOverride(
          connectionId,
          didE164ForOverride,
        );
        if (override.ok) {
          step(`set Caller ID Override = ${didE164ForOverride}`, true);
        } else {
          step(`set Caller ID Override = ${didE164ForOverride}`, false,
            JSON.stringify(override.error));
        }
      }

      // 5) Create OR recycle the User row.
      // v0.9.10 — if recycleExistingUserId is set (a soft-deactivated row
      // exists for this email), UPDATE that row instead of failing on the
      // unique-email constraint. This lets admins re-invite users whose
      // history blocked the hard delete (Postgres FK on calls/messages/etc).
      const userSelect = {
        id: true, email: true, firstName: true, lastName: true,
        isAdmin: true, isActive: true, provider: true,
        sipUsername: true, didNumber: true, lastLoginAt: true, createdAt: true,
      };
      const created = recycleExistingUserId
        ? await prisma.user.update({
            where: { id: recycleExistingUserId },
            data: {
              firstName: firstName ?? null,
              lastName: lastName ?? null,
              sipUsername,
              sipPassword,
              didNumber: targetDid,
              isAdmin: !!makeAdmin,
              isActive: true,
              provider: 'microsoft',
              // Clear lastLoginAt so the "Accepted" status only triggers
              // when the recycled user actually signs in again.
              lastLoginAt: null,
            },
            select: userSelect,
          })
        : await prisma.user.create({
            data: {
              email: normEmail,
              firstName: firstName ?? null,
              lastName: lastName ?? null,
              sipUsername,
              sipPassword,
              didNumber: targetDid,
              isAdmin: !!makeAdmin,
              isActive: true,
              provider: 'microsoft',
            },
            select: userSelect,
          });
      step(
        recycleExistingUserId
          ? `recycle deactivated User row #${recycleExistingUserId} (re-activated)`
          : 'create User row in database',
        true,
      );

      // v0.10.0 — ALSO create a matching UserDid row + point the user's
      // activeUserDidId at it. See apps/api/src/lib/userDid.ts for why —
      // without this, new users have User.didNumber populated but no
      // UserDid row, which breaks DidSwitcher / SMS / line badges.
      const linked = await ensureUserDid({
        userId: created.id,
        didNumber: targetDid,
        connectionId,
        isDefault: true,
      });
      if (linked.ok) {
        step('create UserDid row + set as default outbound line', true);
      } else {
        step('create UserDid row', false, linked.error ?? 'unknown error');
      }

      await recordAudit(actor.sub, 'user.auto_provisioned', created.id, {
        email: normEmail,
        didNumber: targetDid,
        sipUsername,
        didMode,
        // For 'new', record the area code we used; for 'unassigned' it'd
        // just be derived from the DID, so log undefined.
        areaCode: didMode === 'new' ? (newDidAreaCode ?? '732') : undefined,
      });

      // 6) Send welcome email
      let emailSent = false;
      if (sendEmail) {
        const mail = await sendWelcomeEmail({
          toEmail: normEmail,
          firstName: firstName ?? null,
          didNumber: targetDid,
        });
        if (mail.ok) {
          emailSent = true;
          step('send welcome email', true);
        } else {
          step('send welcome email', false, typeof mail.error === 'string' ? mail.error : `HTTP ${mail.status}`);
        }
      } else {
        step('send welcome email', true);   // skipped per request
      }

      return {
        ok: true,
        user: publicUser(created),
        didNumber: targetDid,
        sipUsername,
        emailSent,
        steps,
      };
    },
  );

  // ───────────────────────── PATCH /admin/users/:id ───────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/users/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = UpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      const data: Record<string, unknown> = {};
      const auditMeta: Record<string, unknown> = {};

      const set = (field: string, prev: unknown, next: unknown) => {
        if (next === undefined) return;
        if (prev === next) return;
        data[field] = next;
        auditMeta[field] = { from: prev, to: next };
      };

      set('firstName', target.firstName, parsed.data.firstName ?? undefined);
      set('lastName', target.lastName, parsed.data.lastName ?? undefined);
      set('sipUsername', target.sipUsername, parsed.data.sipUsername ?? undefined);
      if (parsed.data.sipPassword !== undefined) {
        data.sipPassword = parsed.data.sipPassword;
        auditMeta.sipPassword = { changed: true };
      }
      set('didNumber', target.didNumber, parsed.data.didNumber ?? undefined);

      if (parsed.data.isActive !== undefined && parsed.data.isActive !== target.isActive) {
        if (id === actor.sub && parsed.data.isActive === false) {
          return reply
            .code(400)
            .send({ error: "You can't deactivate your own account." });
        }
        data.isActive = parsed.data.isActive;
        auditMeta.isActive = { from: target.isActive, to: parsed.data.isActive };
      }

      if (parsed.data.isAdmin !== undefined && parsed.data.isAdmin !== target.isAdmin) {
        if (id === actor.sub) {
          return reply.code(400).send({
            error: "You can't change your own admin status. Ask another admin to do it.",
          });
        }
        if (parsed.data.isAdmin === false) {
          const remaining = await prisma.user.count({
            where: { isAdmin: true, isActive: true, id: { not: id } },
          });
          if (remaining < 1) {
            return reply.code(400).send({
              error:
                "Can't demote the last admin. Promote someone else first or this account would be the only admin gone.",
            });
          }
        }
        data.isAdmin = parsed.data.isAdmin;
        auditMeta.isAdmin = { from: target.isAdmin, to: parsed.data.isAdmin };
      }

      if (parsed.data.localPassword !== undefined) {
        const newHash = parsed.data.localPassword
          ? await bcrypt.hash(parsed.data.localPassword, 10)
          : null;
        data.passwordHash = newHash;
        if (newHash) data.provider = 'local';
        auditMeta.passwordHash = newHash ? { reset: true } : { cleared: true };
      }

      if (Object.keys(data).length === 0) {
        return publicUser(target);
      }

      const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true, email: true, firstName: true, lastName: true,
          isAdmin: true, isActive: true, provider: true,
          sipUsername: true, didNumber: true, lastLoginAt: true, createdAt: true,
        },
      });

      let action = 'user.updated';
      if (auditMeta.isAdmin) {
        action = (auditMeta.isAdmin as { to: boolean }).to ? 'user.promoted' : 'user.demoted';
      } else if (auditMeta.isActive) {
        action = (auditMeta.isActive as { to: boolean }).to ? 'user.activated' : 'user.deactivated';
      } else if (auditMeta.passwordHash) {
        action = 'user.password_reset';
      }
      await recordAudit(actor.sub, action, id, { email: target.email, changes: auditMeta });

      return publicUser(updated);
    },
  );

  // ───────────────────────── DELETE /admin/users/:id (v0.9.8) ─────────
  // Hard-delete a user with full Telnyx cleanup. Mirrors the pending-users
  // cleanup pipeline (un-assign DID → delete Credential Connection → delete
  // User row → cascade-delete linked PendingUser).
  //
  // Safeguards:
  //  - 403 if target is the only active admin (would lock everyone out).
  //  - 403 if target is the actor (don't let admins nuke themselves).
  //
  // FK-failure path: if Postgres refuses the User delete because of call/SMS/
  // voicemail history, we soft-deactivate instead (isActive=false; clear
  // sipUsername/didNumber/sipPassword so the row stops being usable). Returns
  // 200 with deletedHard=false so the UI can show a warning.
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const target = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true, email: true, isAdmin: true, isActive: true,
          sipUsername: true, didNumber: true,
        },
      });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      // Self-protection.
      if (id === actor.sub) {
        return reply.code(403).send({
          error: "You can't delete your own account. Ask another admin.",
        });
      }

      // Last-admin protection: don't leave the system with zero active admins.
      if (target.isAdmin && target.isActive) {
        const remainingAdmins = await prisma.user.count({
          where: { isAdmin: true, isActive: true, id: { not: id } },
        });
        if (remainingAdmins < 1) {
          return reply.code(403).send({
            error:
              "Can't delete the last active admin. Promote someone else first.",
          });
        }
      }

      type StepLog = { step: string; ok: boolean; error?: string };
      const steps: StepLog[] = [];
      const step = (name: string, ok: boolean, error?: string) => {
        steps.push({ step: name, ok, ...(error ? { error } : {}) });
      };

      let didReleased: string | null = null;
      let connectionDeleted: string | null = null;
      let pendingDeleted: number | null = null;

      // 1) Un-assign DID (clears voice connection_id + messaging_profile_id)
      //    and capture connection_id for step 2.
      let connIdFromDid: string | null = null;
      if (target.didNumber) {
        const lookup = await telnyx.findNumberByE164(target.didNumber);
        if (!lookup.ok) {
          step(`look up DID ${target.didNumber}`, false, JSON.stringify(lookup.error));
        } else if (!lookup.data) {
          step(`look up DID ${target.didNumber}`, false, 'Number not found (already released?)');
        } else {
          connIdFromDid = lookup.data.connection_id ?? null;
          const un = await telnyx.unassignNumber(lookup.data.id);
          if (un.ok) {
            didReleased = target.didNumber;
            step(`un-assign DID ${target.didNumber} (back to inventory)`, true);
          } else {
            step(`un-assign DID ${target.didNumber}`, false, JSON.stringify(un.error));
          }
        }
      } else {
        step('un-assign DID (none on user)', true);
      }

      // 2) Delete Credential Connection. Preferred: connection_id from DID.
      //    Fallback: paginated scan by user_name (Telnyx filter[user_name]
      //    on /credential_connections is broken — it returns everything).
      let connToDelete: string | null = connIdFromDid;
      if (!connToDelete && target.sipUsername) {
        const MAX_PAGES = 5;
        const PAGE_SIZE = 250;
        for (let pageNum = 1; pageNum <= MAX_PAGES && !connToDelete; pageNum += 1) {
          const qs = new URLSearchParams({
            'page[number]': String(pageNum),
            'page[size]': String(PAGE_SIZE),
          });
          const listRes = await fetch(
            `https://api.telnyx.com/v2/credential_connections?${qs.toString()}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${config.telnyxApiKey}`,
                'Content-Type': 'application/json',
              },
            },
          );
          const listBody = (await listRes.json().catch(() => ({}))) as {
            data?: Array<{ id: string; user_name: string }>;
            meta?: { total_pages?: number };
          };
          const items = listBody.data ?? [];
          const match = items.find((c) => c.user_name === target.sipUsername);
          if (match) {
            connToDelete = match.id;
            step(`find user's Telnyx connection via paginated scan (page ${pageNum})`, true);
            break;
          }
          const totalPages = listBody.meta?.total_pages ?? pageNum;
          if (items.length < PAGE_SIZE || pageNum >= totalPages) break;
        }
      }

      if (connToDelete) {
        const del = await telnyx.deleteCredentialConnection(connToDelete);
        if (del.ok) {
          connectionDeleted = connToDelete;
          step(`delete Credential Connection ${connToDelete}`, true);
        } else {
          step(`delete Credential Connection ${connToDelete}`, false, JSON.stringify(del.error));
        }
      } else if (target.sipUsername) {
        step(`find connection for sipUsername ${target.sipUsername}`, false,
          'No matching connection via DID + paginated scan');
      } else {
        step('delete Credential Connection (no sipUsername on user)', true);
      }

      // 3) Best-effort: drop any linked PendingUser row first so the staging
      //    table stays consistent with the actual user list. PendingUser.
      //    invitedUserId is a plain Int? (no relation), so this isn't strictly
      //    required for the User.delete below to succeed — but it stops the
      //    Pending Users tab from showing a "ghost" staged row pointing at a
      //    user that no longer exists.
      const linkedPending = await prisma.pendingUser.findFirst({
        where: { invitedUserId: id },
        select: { id: true },
      });
      if (linkedPending) {
        try {
          await prisma.pendingUser.delete({ where: { id: linkedPending.id } });
          pendingDeleted = linkedPending.id;
          step(`delete linked PendingUser row #${linkedPending.id}`, true);
        } catch (e) {
          step(`delete linked PendingUser row #${linkedPending.id}`, false,
            e instanceof Error ? e.message : String(e));
        }
      }

      // 4) Try the hard delete on the User row. On FK failure, ANONYMIZE
      //    in place. v0.9.12 — the user explicitly asked: "i want the user
      //    details to be deleted so that next time i send them an email
      //    there is no confusion or wont be used. you can keep the other
      //    history for integrity." So when the FK constraint keeps the row
      //    alive (call/SMS/voicemail history), we strip every piece of PII
      //    that could collide on re-invite (email, azureOid) and every
      //    piece that could leak who this once was (firstName, lastName,
      //    didNumber, sipUsername, sipPassword, passwordHash, telnyxNumberId,
      //    phoneExtension, jobDivaUserId, forwarding settings, voicemail
      //    greeting). Keep id + createdAt + updatedAt so the FK rows stay
      //    valid for audit/history but point at a tombstone.
      let deletedHard = false;
      try {
        await prisma.user.delete({ where: { id } });
        deletedHard = true;
        step(`delete User row #${id}`, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        step(`delete User row #${id}`, false, msg);
        try {
          await prisma.user.update({
            where: { id },
            data: {
              // Tombstone the email so the unique constraint frees the
              // original — admin can re-invite the same person and we'll
              // create a fresh User row (no recycle hit because the email
              // no longer maps to this row).
              email: `deleted-${id}@deleted.ace.local`,
              // Wipe PII.
              firstName: null,
              lastName: null,
              phoneExtension: null,
              jobDivaUserId: null,
              // Wipe SIP + Telnyx identifiers.
              sipUsername: null,
              sipPassword: null,
              didNumber: null,
              telnyxNumberId: null,
              // Wipe call-routing prefs.
              forwardingEnabled: false,
              forwardingNumber: null,
              forwardingMode: null,
              voicemailGreetingUrl: null,
              voicemailGreetingFilename: null,
              // Break the SSO link so signing in with the same Microsoft
              // account doesn't resurrect this row — re-invite path will
              // create a fresh User instead.
              azureOid: null,
              passwordHash: null,
              // Mark inactive (login + dialer registration both refuse).
              isActive: false,
              isAdmin: false,
            },
          });
          step(
            `User #${id} had history — anonymized (email tombstoned, PII + SIP creds + DID + SSO link cleared; history rows retained)`,
            true,
          );
        } catch (e2) {
          step(`anonymize User #${id} (fallback)`, false,
            e2 instanceof Error ? e2.message : String(e2));
        }
      }

      await recordAudit(
        actor.sub,
        deletedHard ? 'user.hard_deleted' : 'user.anonymized',
        // Don't reference the User row in the audit log if we just deleted it
        // (would FK-fail). For anonymize it's safe to point at it — the row
        // still exists, just stripped of PII.
        deletedHard ? null : id,
        {
          originalEmail: target.email,
          deletedHard,
          didReleased,
          connectionDeleted,
          pendingDeleted,
          steps,
        },
      );

      return {
        ok: true,
        deletedHard,
        status: deletedHard ? 'deleted' : 'anonymized',
        message: deletedHard
          ? 'User and Telnyx resources fully removed.'
          : "User had call/SMS history — anonymized instead of deleted. Personal details (email, name, SIP creds, DID, SSO link) were cleared. The empty row stays attached to the historical call/SMS records for audit integrity, but the email is now free to re-invite.",
        didReleased,
        connectionDeleted,
        pendingDeleted,
        steps,
      };
    },
  );

  // ───────────────────────── GET /admin/audit-logs ────────────────────
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/admin/audit-logs',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
      const cursor = Number(request.query.cursor);
      const rows = await prisma.auditLog.findMany({
        take: limit + 1,
        orderBy: { id: 'desc' },
        ...(Number.isFinite(cursor) ? { skip: 1, cursor: { id: cursor } } : {}),
        include: {
          actor: { select: { id: true, email: true, firstName: true, lastName: true } },
          target: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, -1) : rows).map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor
          ? {
              id: r.actor.id,
              email: r.actor.email,
              firstName: r.actor.firstName,
              lastName: r.actor.lastName,
            }
          : null,
        target: r.target
          ? {
              id: r.target.id,
              email: r.target.email,
              firstName: r.target.firstName,
              lastName: r.target.lastName,
            }
          : null,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      }));
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    },
  );

  // ───────────────────── POST /admin/users/bulk-import (#189) ─────────
  // Per-row upsert by email. dryRun=true validates + returns the preview
  // without writing. Returns per-row { status, error?, missingPassword }
  // so the frontend can show a result table.
  app.post(
    '/admin/users/bulk-import',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const parsed = BulkImportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { dryRun, rows } = parsed.data;

      const inputEmails = rows.map((r) => r.email.trim().toLowerCase());
      const existing = await prisma.user.findMany({
        where: { email: { in: inputEmails } },
        select: { id: true, email: true },
      });
      const existingByEmail = new Map(existing.map((u) => [u.email, u.id]));

      type ItemResult = {
        row: number;
        email: string;
        status: 'created' | 'updated' | 'error' | 'skipped';
        missingPassword: boolean;
        error?: string;
        userId?: number;
      };
      const results: ItemResult[] = [];
      const seenEmails = new Set<string>();

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const rowNum = i + 1;
        const email = row.email.trim().toLowerCase();

        if (seenEmails.has(email)) {
          results.push({
            row: rowNum,
            email,
            status: 'error',
            missingPassword: false,
            error: 'Duplicate email in CSV',
          });
          continue;
        }
        seenEmails.add(email);

        const hasPassword = !!(row.sipPassword && row.sipPassword.trim());
        const existingId = existingByEmail.get(email);

        try {
          if (dryRun) {
            results.push({
              row: rowNum,
              email,
              status: existingId ? 'updated' : 'created',
              missingPassword: !hasPassword,
              userId: existingId,
            });
            continue;
          }

          if (existingId) {
            const data: Record<string, unknown> = {};
            if (row.firstName !== undefined && row.firstName !== null) data.firstName = row.firstName;
            if (row.lastName !== undefined && row.lastName !== null) data.lastName = row.lastName;
            if (row.sipUsername !== undefined && row.sipUsername !== null && row.sipUsername.trim()) data.sipUsername = row.sipUsername.trim();
            if (hasPassword) data.sipPassword = (row.sipPassword as string).trim();
            if (row.didNumber !== undefined && row.didNumber !== null && row.didNumber.trim()) data.didNumber = row.didNumber.trim();
            if (row.isAdmin === true || row.isAdmin === false) data.isAdmin = row.isAdmin;
            if (row.phoneExtension !== undefined && row.phoneExtension !== null) data.phoneExtension = row.phoneExtension;

            const updated = await prisma.user.update({
              where: { id: existingId },
              data,
              select: { id: true },
            });
            results.push({
              row: rowNum,
              email,
              status: 'updated',
              missingPassword: !hasPassword,
              userId: updated.id,
            });
          } else {
            const created = await prisma.user.create({
              data: {
                email,
                firstName: row.firstName ?? null,
                lastName: row.lastName ?? null,
                sipUsername: row.sipUsername?.trim() || null,
                sipPassword: hasPassword ? (row.sipPassword as string).trim() : null,
                didNumber: row.didNumber?.trim() || null,
                phoneExtension: row.phoneExtension ?? null,
                isAdmin: row.isAdmin === true,
                isActive: true,
                provider: 'microsoft',
                passwordHash: null,
              },
              select: { id: true },
            });
            // v0.10.0 — Ensure matching UserDid row (see lib/userDid.ts).
            const bulkDid = row.didNumber?.trim();
            if (bulkDid) {
              await ensureUserDid({
                userId: created.id,
                didNumber: bulkDid,
                isDefault: true,
              });
            }
            results.push({
              row: rowNum,
              email,
              status: 'created',
              missingPassword: !hasPassword,
              userId: created.id,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            row: rowNum,
            email,
            status: 'error',
            missingPassword: !hasPassword,
            error: msg.includes('Unique constraint')
              ? 'sipUsername or didNumber is already assigned to another user'
              : msg.slice(0, 240),
          });
        }
      }

      const summary = {
        total: rows.length,
        created: results.filter((r) => r.status === 'created').length,
        updated: results.filter((r) => r.status === 'updated').length,
        errors: results.filter((r) => r.status === 'error').length,
        missingPasswords: results.filter((r) => r.missingPassword && r.status !== 'error').length,
        dryRun,
      };

      if (!dryRun) {
        await recordAudit(actor.sub, 'users.bulk_imported', null, {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          errors: summary.errors,
          missingPasswords: summary.missingPasswords,
        });
      }

      return { summary, items: results };
    },
  );

  // ───────────────────── GET /admin/reports/live (Phase 8 — #204) ─────
  // P0 reporting slice — at-a-glance numbers for an admin dashboard.
  // Designed to be cheap: 6 separate queries that all hit indexed columns
  // and return small aggregates, no per-call full scans.
  // Refresh budget on the client: 15s. Each call is < 100ms in practice.
  app.get(
    '/admin/reports/live',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const startOfYesterday = new Date(startOfDay);
      startOfYesterday.setUTCDate(startOfDay.getUTCDate() - 1);
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

      // 1. Active calls right now: started but not ended yet, with a 4h
      //    sanity-cap so a stuck/dropped call doesn't show as active forever.
      const activeCallsNow = await prisma.call.count({
        where: {
          endedAt: null,
          startedAt: { gte: fourHoursAgo },
          status: { in: ['ringing', 'answered', 'initiated', 'connected'] },
        },
      });

      // 2. Today's calls — grouped by direction + status for an in/out/missed split.
      const todaysCallsRaw = await prisma.call.groupBy({
        by: ['direction', 'status'],
        where: { startedAt: { gte: startOfDay } },
        _count: { _all: true },
      });
      let inbound = 0, outbound = 0, missed = 0;
      for (const r of todaysCallsRaw) {
        const c = r._count._all;
        if (r.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(r.status)) missed += c;
          else inbound += c;
        } else if (r.direction === 'outbound') {
          outbound += c;
        }
      }
      const todaysCallsTotal = inbound + outbound + missed;

      // 3. Yesterday's count for delta arrow.
      const yesterdayTotal = await prisma.call.count({
        where: {
          startedAt: { gte: startOfYesterday, lt: startOfDay },
        },
      });

      // 4. Today's SMS (inbound + outbound).
      const todaysSmsRaw = await prisma.message.groupBy({
        by: ['direction'],
        where: { createdAt: { gte: startOfDay } },
        _count: { _all: true },
      });
      const todaysSms = {
        sent: todaysSmsRaw.find((r) => r.direction === 'outbound')?._count._all ?? 0,
        received: todaysSmsRaw.find((r) => r.direction === 'inbound')?._count._all ?? 0,
      };

      // 5. Active users in the last 24h — anyone who's made a call OR sent/
      //    received a message. Best proxy for "online" without server-side
      //    SIP-presence tracking (which we'd need Telnyx Status webhooks for).
      const activeCallers = await prisma.call.findMany({
        where: { startedAt: { gte: last24h } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const activeMessagers = await prisma.message.findMany({
        where: { createdAt: { gte: last24h } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const activeUserIds = new Set<number>([
        ...activeCallers.map((c) => c.userId),
        ...activeMessagers.map((m) => m.userId),
      ]);

      // 6. Top callers today (top 5 by call count).
      const topCallersRaw = await prisma.call.groupBy({
        by: ['userId'],
        where: { startedAt: { gte: startOfDay } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      });
      const topCallerIds = topCallersRaw.map((r) => r.userId);
      const topCallerUsers =
        topCallerIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: topCallerIds } },
              select: { id: true, email: true, firstName: true, lastName: true },
            })
          : [];
      const topCallerById = new Map(topCallerUsers.map((u) => [u.id, u]));
      const topCallers = topCallersRaw.map((r) => {
        const u = topCallerById.get(r.userId);
        return {
          userId: r.userId,
          email: u?.email ?? '(unknown)',
          name:
            ([u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
              u?.email) ?? '(unknown)',
          callCount: r._count._all,
        };
      });

      // 7. Recent missed calls (last 10, with the user who missed them).
      const missedRows = await prisma.call.findMany({
        where: {
          direction: 'inbound',
          status: { in: ['missed', 'no_answer'] },
          startedAt: { gte: last24h },
        },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          fromNumber: true,
          startedAt: true,
          status: true,
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      const recentMissed = missedRows.map((c) => ({
        id: c.id,
        fromNumber: c.fromNumber,
        startedAt: c.startedAt.toISOString(),
        status: c.status,
        userEmail: c.user.email,
        userName:
          [c.user.firstName, c.user.lastName].filter(Boolean).join(' ').trim() ||
          c.user.email,
      }));

      // 8. Hourly call buckets for today (24 buckets, indexed 0–23 UTC).
      const todaysCallsForChart = await prisma.call.findMany({
        where: { startedAt: { gte: startOfDay } },
        select: { startedAt: true, direction: true, status: true },
      });
      const hourly = Array.from({ length: 24 }, () => ({ inbound: 0, outbound: 0, missed: 0 }));
      for (const c of todaysCallsForChart) {
        const h = c.startedAt.getUTCHours();
        if (c.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(c.status)) hourly[h].missed += 1;
          else hourly[h].inbound += 1;
        } else if (c.direction === 'outbound') {
          hourly[h].outbound += 1;
        }
      }

      // 9. Total user counts for context.
      const [totalUsers, activeUsers, adminUsers] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: true } }),
        prisma.user.count({ where: { isAdmin: true, isActive: true } }),
      ]);

      return {
        generatedAt: now.toISOString(),
        users: {
          total: totalUsers,
          active: activeUsers,
          admins: adminUsers,
          activeLast24h: activeUserIds.size,
        },
        calls: {
          activeNow: activeCallsNow,
          today: {
            total: todaysCallsTotal,
            inbound,
            outbound,
            missed,
          },
          yesterdayTotal,
          hourlyToday: hourly,
        },
        sms: {
          today: todaysSms,
        },
        topCallers,
        recentMissed,
      };
    },
  );

  // ───────────────────── GET /admin/reports/presence (#211) ───────────
  // Per-user real-time presence: who's on a call, who's active, who's idle.
  // No true SIP-presence tracking (would need Telnyx Status webhooks); we
  // proxy via open Call rows + recent activity timestamps. Good enough.
  app.get(
    '/admin/reports/presence',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const now = new Date();
      const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

      const users = await prisma.user.findMany({
        where: { isActive: true },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          didNumber: true, sipUsername: true, isAdmin: true,
        },
        orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
      });

      const openCalls = await prisma.call.findMany({
        where: {
          endedAt: null,
          startedAt: { gte: fourHoursAgo },
          status: { in: ['ringing', 'answered', 'initiated', 'connected'] },
        },
        select: {
          userId: true, fromNumber: true, toNumber: true, direction: true,
          startedAt: true, status: true,
        },
      });
      const openCallByUser = new Map<number, typeof openCalls[number]>();
      for (const c of openCalls) {
        if (!openCallByUser.has(c.userId)) openCallByUser.set(c.userId, c);
      }

      const lastCallPerUser = await prisma.call.groupBy({
        by: ['userId'],
        _max: { startedAt: true },
        where: { startedAt: { gte: last24h } },
      });
      const lastMsgPerUser = await prisma.message.groupBy({
        by: ['userId'],
        _max: { createdAt: true },
        where: { createdAt: { gte: last24h } },
      });
      const lastByUser = new Map<number, Date>();
      for (const r of lastCallPerUser) {
        if (r._max.startedAt) lastByUser.set(r.userId, r._max.startedAt);
      }
      for (const r of lastMsgPerUser) {
        if (!r._max.createdAt) continue;
        const prev = lastByUser.get(r.userId);
        if (!prev || r._max.createdAt > prev) lastByUser.set(r.userId, r._max.createdAt);
      }

      const todayCallsPerUser = await prisma.call.groupBy({
        by: ['userId', 'direction', 'status'],
        where: { startedAt: { gte: startOfDay } },
        _count: { _all: true },
      });
      const todayByUser = new Map<number, { inbound: number; outbound: number; missed: number }>();
      for (const r of todayCallsPerUser) {
        const cur = todayByUser.get(r.userId) ?? { inbound: 0, outbound: 0, missed: 0 };
        const c = r._count._all;
        if (r.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(r.status)) cur.missed += c;
          else cur.inbound += c;
        } else if (r.direction === 'outbound') {
          cur.outbound += c;
        }
        todayByUser.set(r.userId, cur);
      }

      const items = users.map((u) => {
        const open = openCallByUser.get(u.id);
        const last = lastByUser.get(u.id);
        let status: 'on_call' | 'active' | 'recent' | 'idle' = 'idle';
        if (open) status = 'on_call';
        else if (last && last >= tenMinAgo) status = 'active';
        else if (last && last >= oneHourAgo) status = 'recent';
        const today = todayByUser.get(u.id) ?? { inbound: 0, outbound: 0, missed: 0 };
        return {
          id: u.id,
          email: u.email,
          name:
            ([u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
              u.email),
          didNumber: u.didNumber,
          isAdmin: u.isAdmin,
          status,
          lastActivity: last ? last.toISOString() : null,
          currentCall: open
            ? {
                fromNumber: open.fromNumber,
                toNumber: open.toNumber,
                direction: open.direction,
                startedAt: open.startedAt.toISOString(),
                status: open.status,
              }
            : null,
          todayCalls: today.inbound + today.outbound + today.missed,
          todayBreakdown: today,
        };
      });

      const counts = {
        on_call: items.filter((i) => i.status === 'on_call').length,
        active: items.filter((i) => i.status === 'active').length,
        recent: items.filter((i) => i.status === 'recent').length,
        idle: items.filter((i) => i.status === 'idle').length,
      };

      return { generatedAt: now.toISOString(), counts, items };
    },
  );

  // ───────────────────── GET /admin/reports/usage (#205) ──────────────
  app.get<{ Querystring: { range?: string } }>(
    '/admin/reports/usage',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const range = request.query.range ?? '7d';
      const now = new Date();
      let since: Date;
      if (range === 'today') {
        since = new Date(now); since.setUTCHours(0, 0, 0, 0);
      } else if (range === '30d') {
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      } else {
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }

      const callsByUser = await prisma.call.groupBy({
        by: ['userId', 'direction', 'status'],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
        _sum: { durationSeconds: true },
      });
      type Agg = { userId: number; inbound: number; outbound: number; missed: number; talkSec: number };
      const aggMap = new Map<number, Agg>();
      for (const r of callsByUser) {
        const cur = aggMap.get(r.userId) ?? { userId: r.userId, inbound: 0, outbound: 0, missed: 0, talkSec: 0 };
        const c = r._count._all;
        const t = r._sum.durationSeconds ?? 0;
        if (r.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(r.status)) cur.missed += c;
          else cur.inbound += c;
        } else if (r.direction === 'outbound') {
          cur.outbound += c;
        }
        cur.talkSec += t;
        aggMap.set(r.userId, cur);
      }

      const smsByUser = await prisma.message.groupBy({
        by: ['userId', 'direction'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      });
      const smsMap = new Map<number, { sent: number; received: number }>();
      for (const r of smsByUser) {
        const cur = smsMap.get(r.userId) ?? { sent: 0, received: 0 };
        if (r.direction === 'outbound') cur.sent += r._count._all;
        else cur.received += r._count._all;
        smsMap.set(r.userId, cur);
      }

      const allUserIds = new Set<number>([...aggMap.keys(), ...smsMap.keys()]);
      const userDetails = allUserIds.size === 0 ? [] : await prisma.user.findMany({
        where: { id: { in: Array.from(allUserIds) } },
        select: { id: true, email: true, firstName: true, lastName: true, didNumber: true },
      });
      const userById = new Map(userDetails.map((u) => [u.id, u]));

      const byUser = Array.from(allUserIds).map((id) => {
        const agg = aggMap.get(id) ?? { userId: id, inbound: 0, outbound: 0, missed: 0, talkSec: 0 };
        const sms = smsMap.get(id) ?? { sent: 0, received: 0 };
        const u = userById.get(id);
        const total = agg.inbound + agg.outbound + agg.missed;
        return {
          userId: id,
          email: u?.email ?? '(unknown)',
          name:
            ([u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
              u?.email) ?? '(unknown)',
          didNumber: u?.didNumber ?? null,
          totalCalls: total,
          inbound: agg.inbound,
          outbound: agg.outbound,
          missed: agg.missed,
          talkSeconds: agg.talkSec,
          smsSent: sms.sent,
          smsReceived: sms.received,
        };
      }).sort((a, b) => b.totalCalls - a.totalCalls);

      const allCallsInWindow = await prisma.call.findMany({
        where: { startedAt: { gte: since } },
        select: { startedAt: true, direction: true, status: true },
      });
      const days = range === 'today' ? 1 : range === '30d' ? 30 : 7;
      const byDay: Array<{ date: string; inbound: number; outbound: number; missed: number }> = [];
      for (let i = 0; i < days; i += 1) {
        const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
        dayStart.setUTCDate(dayStart.getUTCDate() - (days - 1 - i));
        const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        let inb = 0, out = 0, mis = 0;
        for (const c of allCallsInWindow) {
          if (c.startedAt < dayStart || c.startedAt >= dayEnd) continue;
          if (c.direction === 'inbound') {
            if (['missed', 'no_answer', 'rejected'].includes(c.status)) mis += 1;
            else inb += 1;
          } else if (c.direction === 'outbound') {
            out += 1;
          }
        }
        byDay.push({ date: dayStart.toISOString().slice(0, 10), inbound: inb, outbound: out, missed: mis });
      }

      return { range, generatedAt: now.toISOString(), byUser, byDay };
    },
  );

  // ───────────────────── GET /admin/reports/quality (#206) ────────────
  app.get<{ Querystring: { range?: string } }>(
    '/admin/reports/quality',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const range = request.query.range ?? '7d';
      const now = new Date();
      const since = range === '30d'
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const calls = await prisma.call.findMany({
        where: { startedAt: { gte: since } },
        select: {
          userId: true, direction: true, status: true,
          durationSeconds: true, hangupCause: true, startedAt: true,
        },
      });

      type UA = { userId: number; missed: number; answered: number; short: number };
      const ua = new Map<number, UA>();
      const hangupCauses = new Map<string, number>();
      const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

      for (const c of calls) {
        const u = ua.get(c.userId) ?? { userId: c.userId, missed: 0, answered: 0, short: 0 };
        if (c.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(c.status)) u.missed += 1;
          else u.answered += 1;
        }
        if (c.durationSeconds > 0 && c.durationSeconds < 10) u.short += 1;
        ua.set(c.userId, u);

        if (c.hangupCause) {
          hangupCauses.set(c.hangupCause, (hangupCauses.get(c.hangupCause) ?? 0) + 1);
        }
        const dow = c.startedAt.getUTCDay();
        const hr = c.startedAt.getUTCHours();
        heatmap[dow][hr] += 1;
      }

      const userIds = Array.from(ua.keys());
      const users = userIds.length > 0 ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, firstName: true, lastName: true },
      }) : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      const missedRateByUser = userIds.map((id) => {
        const u = ua.get(id)!;
        const detail = userById.get(id);
        const totalInbound = u.missed + u.answered;
        const rate = totalInbound > 0 ? u.missed / totalInbound : 0;
        return {
          userId: id,
          email: detail?.email ?? '(unknown)',
          name:
            ([detail?.firstName, detail?.lastName].filter(Boolean).join(' ').trim() ||
              detail?.email) ?? '(unknown)',
          missed: u.missed,
          answered: u.answered,
          shortCalls: u.short,
          missedRate: rate,
        };
      }).filter((r) => r.missed + r.answered >= 3)
        .sort((a, b) => b.missedRate - a.missedRate)
        .slice(0, 25);

      const hangupCausesArr = Array.from(hangupCauses.entries())
        .map(([cause, count]) => ({ cause, count }))
        .sort((a, b) => b.count - a.count);

      const totalShort = Array.from(ua.values()).reduce((sum, u) => sum + u.short, 0);

      return {
        range,
        generatedAt: now.toISOString(),
        missedRateByUser,
        hangupCauses: hangupCausesArr,
        totals: { shortCalls: totalShort, totalCalls: calls.length },
        heatmap,
      };
    },
  );

  // ───────────────────── GET /admin/reports/cost (#207) ───────────────
  // Telnyx cost reporting. Pricing constants come from env vars (with
  // sane defaults) so an admin can tune them in one place if Telnyx
  // pricing changes.
  app.get<{ Querystring: { range?: string } }>(
    '/admin/reports/cost',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const range = request.query.range ?? '30d';
      const now = new Date();
      const since = range === '7d'
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const days = range === '7d' ? 7 : 30;

      // Pricing — Telnyx US defaults. Override via env if your plan differs.
      const COST_INBOUND_PER_MIN = parseFloat(process.env.TELNYX_COST_INBOUND_PER_MIN ?? '0.005');
      const COST_OUTBOUND_PER_MIN = parseFloat(process.env.TELNYX_COST_OUTBOUND_PER_MIN ?? '0.007');
      const COST_PER_SMS = parseFloat(process.env.TELNYX_COST_PER_SMS ?? '0.004');
      const COST_PER_DID_MONTHLY = parseFloat(process.env.TELNYX_COST_PER_DID_MONTHLY ?? '1.00');

      // Per-user voice spend.
      const calls = await prisma.call.findMany({
        where: { startedAt: { gte: since }, durationSeconds: { gt: 0 } },
        select: { userId: true, direction: true, durationSeconds: true },
      });
      const byUser = new Map<number, { inboundSec: number; outboundSec: number }>();
      for (const c of calls) {
        const cur = byUser.get(c.userId) ?? { inboundSec: 0, outboundSec: 0 };
        if (c.direction === 'inbound') cur.inboundSec += c.durationSeconds;
        else cur.outboundSec += c.durationSeconds;
        byUser.set(c.userId, cur);
      }

      // SMS spend.
      const smsByUser = await prisma.message.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      });
      const smsMap = new Map(smsByUser.map((r) => [r.userId, r._count._all]));

      // Per-DID minutes.
      const callsByDid = await prisma.call.groupBy({
        by: ['toNumber'],
        where: {
          startedAt: { gte: since },
          direction: 'inbound',
          durationSeconds: { gt: 0 },
        },
        _sum: { durationSeconds: true },
      });
      const didMinutes = callsByDid
        .map((r) => ({ did: r.toNumber, minutes: Math.round((r._sum.durationSeconds ?? 0) / 60) }))
        .filter((r) => r.did)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 25);

      const userIds = Array.from(byUser.keys()).concat(Array.from(smsMap.keys()));
      const uniqUserIds = Array.from(new Set(userIds));
      const userDetails = uniqUserIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: uniqUserIds } },
            select: { id: true, email: true, firstName: true, lastName: true, didNumber: true },
          })
        : [];
      const userById = new Map(userDetails.map((u) => [u.id, u]));

      const byUserArr = uniqUserIds.map((id) => {
        const voice = byUser.get(id) ?? { inboundSec: 0, outboundSec: 0 };
        const smsCount = smsMap.get(id) ?? 0;
        const u = userById.get(id);
        const inboundCost = (voice.inboundSec / 60) * COST_INBOUND_PER_MIN;
        const outboundCost = (voice.outboundSec / 60) * COST_OUTBOUND_PER_MIN;
        const smsCost = smsCount * COST_PER_SMS;
        const total = inboundCost + outboundCost + smsCost;
        return {
          userId: id,
          email: u?.email ?? '(unknown)',
          name:
            ([u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
              u?.email) ?? '(unknown)',
          didNumber: u?.didNumber ?? null,
          inboundMinutes: Math.round(voice.inboundSec / 60),
          outboundMinutes: Math.round(voice.outboundSec / 60),
          smsCount,
          inboundCost,
          outboundCost,
          smsCost,
          totalCost: total,
        };
      }).sort((a, b) => b.totalCost - a.totalCost);

      // Active DID count for the rental projection.
      const activeUsers = await prisma.user.count({ where: { isActive: true, didNumber: { not: null } } });

      const voiceTotal = byUserArr.reduce((s, u) => s + u.inboundCost + u.outboundCost, 0);
      const smsTotal = byUserArr.reduce((s, u) => s + u.smsCost, 0);
      const didRentalMonthly = activeUsers * COST_PER_DID_MONTHLY;

      // Projected monthly = (voice + sms over `days`) / days * 30 + DID rental.
      const usageProjection = ((voiceTotal + smsTotal) / Math.max(days, 1)) * 30;
      const projectedMonthly = usageProjection + didRentalMonthly;

      return {
        range,
        generatedAt: now.toISOString(),
        pricing: {
          inboundPerMin: COST_INBOUND_PER_MIN,
          outboundPerMin: COST_OUTBOUND_PER_MIN,
          perSms: COST_PER_SMS,
          didMonthly: COST_PER_DID_MONTHLY,
        },
        totals: {
          voiceCost: voiceTotal,
          smsCost: smsTotal,
          didRentalMonthly,
          projectedMonthly,
          activeDids: activeUsers,
        },
        byUser: byUserArr,
        didMinutes,
      };
    },
  );

  // ───────────────────── GET /admin/reports/recruiter (#208) ──────────
  // ApTask-specific recruiter metrics.
  //   - candidateReach: unique outbound numbers dialed per user per day (avg)
  //   - conversationRate: % of outbound calls that connected > 30s
  app.get<{ Querystring: { range?: string } }>(
    '/admin/reports/recruiter',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const range = request.query.range ?? '7d';
      const now = new Date();
      const since = range === '30d'
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const days = range === '30d' ? 30 : 7;

      const outboundCalls = await prisma.call.findMany({
        where: {
          startedAt: { gte: since },
          direction: 'outbound',
        },
        select: { userId: true, toNumber: true, durationSeconds: true, startedAt: true },
      });

      type Row = {
        userId: number;
        totalDialed: number;
        connectedOver30s: number;
        uniqueNumbers: Set<string>;
        uniqueDays: Set<string>;
      };
      const rows = new Map<number, Row>();
      for (const c of outboundCalls) {
        const row = rows.get(c.userId) ?? {
          userId: c.userId,
          totalDialed: 0,
          connectedOver30s: 0,
          uniqueNumbers: new Set<string>(),
          uniqueDays: new Set<string>(),
        };
        row.totalDialed += 1;
        if (c.durationSeconds >= 30) row.connectedOver30s += 1;
        if (c.toNumber) row.uniqueNumbers.add(c.toNumber.replace(/[^\d]/g, '').slice(-10));
        row.uniqueDays.add(c.startedAt.toISOString().slice(0, 10));
        rows.set(c.userId, row);
      }

      const userIds = Array.from(rows.keys());
      const users = userIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      const byUser = userIds.map((id) => {
        const r = rows.get(id)!;
        const u = userById.get(id);
        const activeDays = Math.max(r.uniqueDays.size, 1);
        const conversationRate = r.totalDialed > 0 ? r.connectedOver30s / r.totalDialed : 0;
        return {
          userId: id,
          email: u?.email ?? '(unknown)',
          name:
            ([u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
              u?.email) ?? '(unknown)',
          totalDialed: r.totalDialed,
          uniqueNumbers: r.uniqueNumbers.size,
          activeDays,
          avgUniquePerDay: Math.round((r.uniqueNumbers.size / activeDays) * 10) / 10,
          connectedOver30s: r.connectedOver30s,
          conversationRate,
        };
      }).sort((a, b) => b.totalDialed - a.totalDialed);

      // Team averages for benchmarking.
      const totalDialed = byUser.reduce((s, r) => s + r.totalDialed, 0);
      const totalConnected = byUser.reduce((s, r) => s + r.connectedOver30s, 0);
      const totalUnique = byUser.reduce((s, r) => s + r.uniqueNumbers, 0);
      const teamConversationRate = totalDialed > 0 ? totalConnected / totalDialed : 0;
      const teamAvgUniquePerUser = byUser.length > 0
        ? Math.round((totalUnique / byUser.length) * 10) / 10
        : 0;

      return {
        range,
        generatedAt: now.toISOString(),
        days,
        team: {
          totalDialed,
          totalConnected,
          totalUnique,
          conversationRate: teamConversationRate,
          avgUniquePerUser: teamAvgUniquePerUser,
          activeRecruiters: byUser.length,
        },
        byUser,
      };
    },
  );

  // ───────────────────── GET /admin/reports/alerts (#210) ─────────────
  // Surfaces anomalies the admin should know about. No cron yet — admin
  // refreshes to recompute. Cheap enough to run on demand.
  app.get(
    '/admin/reports/alerts',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);

      type Alert = {
        severity: 'info' | 'warn' | 'critical';
        type: string;
        message: string;
        userId?: number;
        userEmail?: string;
        userName?: string;
      };
      const alerts: Alert[] = [];

      // 1. Active users with NO call/SMS activity in the last 7 days.
      const activeUsers = await prisma.user.findMany({
        where: { isActive: true, sipUsername: { not: null }, didNumber: { not: null } },
        select: { id: true, email: true, firstName: true, lastName: true, createdAt: true },
      });

      const recentlyActiveCallerIds = new Set(
        (await prisma.call.findMany({
          where: { startedAt: { gte: sevenDaysAgo } },
          distinct: ['userId'],
          select: { userId: true },
        })).map((r) => r.userId)
      );
      const recentlyActiveMessagerIds = new Set(
        (await prisma.message.findMany({
          where: { createdAt: { gte: sevenDaysAgo } },
          distinct: ['userId'],
          select: { userId: true },
        })).map((r) => r.userId)
      );

      for (const u of activeUsers) {
        // Don't alert on accounts created within the last 7 days — they're new.
        if (u.createdAt >= sevenDaysAgo) continue;
        if (recentlyActiveCallerIds.has(u.id) || recentlyActiveMessagerIds.has(u.id)) continue;
        alerts.push({
          severity: 'warn',
          type: 'user.idle_7d',
          message: 'No calls or messages in 7 days',
          userId: u.id,
          userEmail: u.email,
          userName:
            ([u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
              u.email),
        });
      }

      // 2. Spike in today's missed calls vs 7-day average.
      const missedToday = await prisma.call.count({
        where: {
          startedAt: { gte: startOfDay },
          direction: 'inbound',
          status: { in: ['missed', 'no_answer', 'rejected'] },
        },
      });
      const missedLast7d = await prisma.call.count({
        where: {
          startedAt: { gte: sevenDaysAgo, lt: startOfDay },
          direction: 'inbound',
          status: { in: ['missed', 'no_answer', 'rejected'] },
        },
      });
      const missedAvgPerDay = missedLast7d / 7;
      if (missedAvgPerDay > 0 && missedToday > missedAvgPerDay * 1.5 && missedToday >= 3) {
        alerts.push({
          severity: 'critical',
          type: 'missed.spike',
          message: `${missedToday} missed today vs ${Math.round(missedAvgPerDay)}/day 7-day avg`,
        });
      }

      // 3. DIDs (numbers we own) with no inbound activity in 14 days.
      const allDids = activeUsers.map((u) => ({ id: u.id, email: u.email, did: '' as string }));
      const recentInboundToNumbers = new Set(
        (await prisma.call.findMany({
          where: {
            startedAt: { gte: fourteenDaysAgo },
            direction: 'inbound',
          },
          distinct: ['toNumber'],
          select: { toNumber: true },
        })).map((r) => r.toNumber)
      );
      const usersWithDids = await prisma.user.findMany({
        where: { isActive: true, didNumber: { not: null } },
        select: { id: true, email: true, firstName: true, lastName: true, didNumber: true },
      });
      for (const u of usersWithDids) {
        if (!u.didNumber) continue;
        if (recentInboundToNumbers.has(u.didNumber)) continue;
        alerts.push({
          severity: 'info',
          type: 'did.inactive_14d',
          message: `DID ${u.didNumber} has received no calls in 14 days`,
          userId: u.id,
          userEmail: u.email,
          userName:
            ([u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
              u.email),
        });
      }

      return {
        generatedAt: now.toISOString(),
        counts: {
          critical: alerts.filter((a) => a.severity === 'critical').length,
          warn: alerts.filter((a) => a.severity === 'warn').length,
          info: alerts.filter((a) => a.severity === 'info').length,
        },
        alerts,
      };
    },
  );
  // ───────────────────── Pulse-to-ACE migration (#216-220) ─────────────────
  //
  // POST /admin/pending-users/import  — bulk staging upload from CSV
  // GET  /admin/pending-users         — list with status filter
  // POST /admin/pending-users/:id/invite — orchestrate per-user provisioning
  // DELETE /admin/pending-users/:id   — clean up a wrong CSV row
  //
  // The invite endpoint is the only place that touches Telnyx in this
  // feature. All others are pure DB reads/writes. See InviteFromPendingSchema
  // for the per-row choices (didMode / credsMode / repointWebhook / sendEmail).

  // ── GET /admin/telnyx/unassigned-numbers ────────────────────────────────
  // Returns the list of Telnyx numbers we own that aren't currently routed
  // to any voice connection AND not bound to any messaging profile. Powers
  // the invite-modal "Use an ACE number you already own" picker — letting
  // admins re-use leftover inventory instead of buying a new DID.
  app.get(
    '/admin/telnyx/unassigned-numbers',
    { onRequest: [app.authenticate, requireAdmin] },
    async (_request, reply) => {
      const res = await telnyx.listUnassignedNumbers();
      if (!res.ok) {
        return reply.code(502).send({
          error: 'Failed to fetch unassigned numbers from Telnyx',
          detail: res.error,
        });
      }
      return { items: res.data };
    },
  );

  // ── GET /admin/telnyx/migration-candidates ──────────────────────────────
  // v0.10.20 — Powers the "Migrate Existing User to New Dialer" picker.
  // Returns Telnyx DIDs that ARE currently bound to a connection (usually
  // Pulse) but NOT yet in ACE's UserDid table. Admin picks one and we
  // re-bind it to the target user's ACE connection.
  //
  // Enrichment: each candidate's sourceConnectionId is resolved to
  // connectionName + sipUsername via fetchCredentialConnection so the
  // picker can show "(732) 555-1234 — Pulse: jdoe@aptask (SIP user:
  // aptask123)" instead of a raw UUID. We dedupe by connectionId so a
  // user with 50 DIDs on one Pulse connection only triggers ONE lookup.
  app.get(
    '/admin/telnyx/migration-candidates',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const res = await telnyx.listMigrationCandidates();
      if (!res.ok) {
        return reply.code(502).send({
          error: 'Failed to fetch migration candidates from Telnyx',
          detail: res.error,
        });
      }
      // Strip any DIDs that ACE already owns (by last-10 match against
      // the local UserDid table). Migrating an already-claimed DID would
      // just re-bind it to itself and confuse the audit log.
      const aceOwnedDids = await prisma.userDid.findMany({
        select: { didNumber: true },
      });
      const aceOwnedLast10 = new Set(
        aceOwnedDids.map((d) => d.didNumber.replace(/\D/g, '').slice(-10)),
      );
      const filtered = (res.data ?? []).filter((c) => {
        const last10 = c.phoneNumber.replace(/\D/g, '').slice(-10);
        return !aceOwnedLast10.has(last10);
      });

      // Dedupe connection IDs and fetch each once. Map to { name, sipUser }.
      // v0.10.21 — Use the GENERIC /connections/{id} endpoint instead of
      // /credential_connections/{id}. The credential-only endpoint returned
      // 404 for non-credential connections (FQDN/IP/SIP types), which made
      // the picker show "Unknown connection" for any Pulse DID bound to a
      // non-credential connection. Generic endpoint works for all types.
      // SIP username (user_name) is only populated on credential connections;
      // null for other types — that's fine.
      const connIds = Array.from(new Set(filtered.map((c) => c.sourceConnectionId)));
      const connMeta: Record<string, { name: string | null; sipUser: string | null }> = {};
      let failedLookups = 0;
      await Promise.all(
        connIds.map(async (cid) => {
          const cr = await telnyx.fetchAnyConnection(cid);
          if (cr.ok && cr.data?.data) {
            connMeta[cid] = {
              name: cr.data.data.connection_name ?? null,
              sipUser: cr.data.data.user_name ?? null,
            };
          } else {
            connMeta[cid] = { name: null, sipUser: null };
            failedLookups += 1;
            // v0.10.26 — Log the FIRST failure of each batch so we can
            // diagnose "all candidates show Unknown connection". Common
            // cause: Telnyx /v2/connections/{id} returns 404 because the
            // connection was deleted out-of-band but the DID still
            // references it. Less common: account doesn't have the
            // /v2/connections endpoint enabled.
            if (failedLookups <= 3) {
              request.log.warn(
                { connectionId: cid, status: cr.status, error: cr.error },
                '[admin/migration-candidates] connection name lookup failed',
              );
            }
          }
        }),
      );
      if (failedLookups > 0) {
        request.log.info(
          { total: connIds.length, failed: failedLookups },
          '[admin/migration-candidates] some connection lookups failed (will render as "Unknown connection")',
        );
      }

      const items = filtered.map((c) => ({
        ...c,
        connectionName: connMeta[c.sourceConnectionId]?.name ?? null,
        sipUsername: connMeta[c.sourceConnectionId]?.sipUser ?? null,
      }));
      return { items };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // v0.10.0 Task 27 — Per-user DID management (additional lines).
  //
  // Lets admins add/remove/edit DIDs on an existing user without going
  // through the full invite flow. Needed because the invite flow only
  // assigns ONE DID per new user; multi-DID users need lines added
  // after-the-fact.
  //
  // Endpoints:
  //   GET    /admin/users/:id/dids                  list user's DIDs
  //   POST   /admin/users/:id/dids                  add a DID
  //   PATCH  /admin/users/:id/dids/:didId           edit label/color/default
  //   DELETE /admin/users/:id/dids/:didId           remove a DID
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /admin/users/:id/dids ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/admin/users/:id/dids',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const userId = Number(request.params.id);
      if (!Number.isFinite(userId)) {
        return reply.code(400).send({ error: 'Invalid user id' });
      }
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      const dids = await prisma.userDid.findMany({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          didNumber: true,
          telnyxNumberId: true,
          connectionId: true,
          label: true,
          colorHex: true,
          isDefault: true,
          createdAt: true,
        },
      });
      return { dids };
    },
  );

  // ── POST /admin/users/:id/dids ──────────────────────────────────────────
  // Adds an additional DID to an existing user. Two modes (mutually exclusive):
  //
  //   Mode A — UNASSIGNED inventory pick
  //     { source: 'unassigned', didNumber: '+19735551234', ... }
  //     The admin picked a DID we already own that's not currently
  //     assigned to anyone. We just route it to the user's connection.
  //
  //   Mode B — PURCHASE a fresh DID
  //     { source: 'purchase', purchaseAreaCode: '732', ... }
  //     The admin wants a brand-new number. We search Telnyx availability
  //     in the requested area code, pick the first hit, order it (billable),
  //     then route to the user's connection same as Mode A.
  //
  // Both modes then:
  //   1. Validate the user has an existing Credential Connection (from
  //      their default UserDid). If not, we refuse — admin should
  //      complete the invite flow first which creates the connection.
  //   2. Assign the DID to that connection on Telnyx (voice routing).
  //   3. Bind the DID to ACE's messaging profile (SMS routing).
  //   4. Insert the UserDid row.
  //   5. If isDefault=true, unset isDefault on the user's other UserDids.
  const AddDidSchema = z.object({
    source: z.enum(['unassigned', 'purchase']),
    // unassigned mode: required
    didNumber: z.string().min(8).max(20).optional(),
    // purchase mode: required (3-digit US area code)
    purchaseAreaCode: z.string().regex(/^\d{3}$/).optional(),
    label: z.string().min(1).max(40).default('Line'),
    colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
    isDefault: z.boolean().optional().default(false),
  }).refine(
    (d) => (d.source === 'unassigned' ? !!d.didNumber : !!d.purchaseAreaCode),
    {
      message:
        "source='unassigned' requires didNumber; source='purchase' requires purchaseAreaCode",
    },
  );
  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/dids',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      if (!Number.isFinite(userId)) {
        return reply.code(400).send({ error: 'Invalid user id' });
      }
      const parsed = AddDidSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { source, label, colorHex, isDefault } = parsed.data;

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          userDids: {
            select: { id: true, didNumber: true, connectionId: true, isDefault: true },
          },
        },
      });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      // Find the user's Credential Connection — needed for routing the
      // new DID. We pull it from the user's default UserDid.
      //
      // v0.10.7 fix — the v0.10.0 migration backfilled UserDid rows from
      // the legacy User.didNumber column but didn't populate
      // connection_id (the legacy User row never tracked it locally).
      // Result: every pre-v0.10.0 user has a default UserDid with
      // connectionId=NULL, and "Add line" hard-errored 409 with a
      // misleading "Complete the invite flow first" message even
      // though the user IS using the dialer fine. Fix: when local
      // connectionId is NULL, look it up via Telnyx's findNumberByE164.
      // If found, patch the UserDid row so future lookups are local.
      const defaultDid = target.userDids.find((d) => d.isDefault) ?? target.userDids[0];
      if (!defaultDid) {
        return reply.code(409).send({
          error: 'User has no DIDs assigned yet. Complete the invite flow first.',
        });
      }
      let connectionId = defaultDid.connectionId;
      if (!connectionId) {
        const probe = await telnyx.findNumberByE164(defaultDid.didNumber);
        if (probe.ok && probe.data?.connection_id) {
          connectionId = probe.data.connection_id;
          // Backfill the local row so subsequent calls don't need
          // to round-trip Telnyx.
          await prisma.userDid.update({
            where: { id: defaultDid.id },
            data: { connectionId },
          });
          request.log.info(
            { userId: target.id, userDidId: defaultDid.id, connectionId },
            '[admin/manage-lines] backfilled connectionId from Telnyx',
          );
        }
      }
      if (!connectionId) {
        return reply.code(409).send({
          error: 'Cannot resolve user\'s Telnyx connection. Their default DID has no connection_id in Telnyx either — check that the number is bound to a Credential Connection in the Telnyx portal.',
        });
      }

      // Resolve { e164, telnyxNumberId } based on which mode we're in.
      let e164: string;
      let telnyxNumberId: string;
      let purchased = false;
      let purchasedNumber: string | null = null;

      if (source === 'unassigned') {
        // Mode A — admin picked an existing inventory number.
        const didNumber = parsed.data.didNumber!;
        const digits = didNumber.replace(/\D/g, '');
        e164 = digits.startsWith('1') && digits.length === 11
          ? `+${digits}`
          : digits.length === 10
            ? `+1${digits}`
            : didNumber.startsWith('+') ? didNumber : `+${digits}`;

        // Refuse if this DID is already in our UserDid table.
        const existing = await prisma.userDid.findUnique({
          where: { didNumber: e164 },
          select: { id: true, userId: true },
        });
        if (existing) {
          const isMine = existing.userId === userId;
          return reply.code(409).send({
            error: isMine
              ? 'This DID is already assigned to this user.'
              : 'This DID is already assigned to another user. Remove it from them first.',
          });
        }

        const tn = await telnyx.findNumberByE164(e164);
        if (!tn.ok) {
          return reply.code(502).send({
            error: 'Telnyx lookup failed', detail: tn.error,
          });
        }
        if (!tn.data) {
          return reply.code(404).send({
            error: `Telnyx doesn't recognize ${e164}. Confirm we own this number in Numbers → My Numbers.`,
          });
        }
        telnyxNumberId = tn.data.id;
      } else {
        // Mode B — purchase a fresh DID from Telnyx.
        const areaCode = parsed.data.purchaseAreaCode!;

        // 1. Search availability.
        const search = await telnyx.searchAvailableLocal(areaCode, 5);
        if (!search.ok) {
          return reply.code(502).send({
            error: 'Telnyx number search failed', detail: search.error,
          });
        }
        const candidate = search.data?.data?.[0];
        if (!candidate?.phone_number) {
          return reply.code(404).send({
            error: `No available local numbers in area code ${areaCode}. Try a different area code.`,
          });
        }

        // 2. Place the order. This is BILLABLE.
        const order = await telnyx.purchaseDid(candidate.phone_number, connectionId);
        if (!order.ok) {
          return reply.code(502).send({
            error: 'Telnyx number purchase failed', detail: order.error,
          });
        }
        const ordered = order.data?.data?.phone_numbers?.[0];
        if (!ordered) {
          return reply.code(502).send({
            error: 'Telnyx returned no phone_numbers in the order response',
            detail: order.data,
          });
        }
        e164 = ordered.phone_number;
        telnyxNumberId = ordered.id;
        purchased = true;
        purchasedNumber = e164;

        request.log.info(
          { userId, e164, telnyxNumberId, areaCode },
          '[admin.user_dids.add] purchased new DID',
        );
        // Note: purchaseDid() above already passed connection_id at order
        // time so the assignDidToConnection call below is a confirmatory
        // PATCH (idempotent — Telnyx tolerates re-setting the same value).
      }

      // Assign the DID to the user's connection (voice routing).
      // For purchase-mode this is a confirmation; for unassigned-mode it's
      // the actual binding step.
      const assign = await telnyx.assignDidToConnection(telnyxNumberId, connectionId);
      if (!assign.ok) {
        return reply.code(502).send({
          error: 'Failed to assign DID to user\'s connection on Telnyx',
          detail: assign.error,
          purchased,
          purchasedNumber,
        });
      }

      // Bind to ACE's messaging profile (inbound SMS routing).
      if (config.telnyxMessagingProfileId) {
        const msg = await telnyx.assignNumberMessagingProfile(
          telnyxNumberId,
          config.telnyxMessagingProfileId,
        );
        if (!msg.ok) {
          // Non-fatal — voice is wired; SMS may need manual portal fix.
          // Log + continue.
          request.log.warn(
            { numberId: telnyxNumberId, error: msg.error },
            '[admin.user_dids.add] messaging profile assignment failed',
          );
        }
      }

      // If admin marked this as the new default, unset isDefault on all
      // existing UserDids for this user. Then insert the new row.
      if (isDefault) {
        await prisma.userDid.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      }
      const created = await prisma.userDid.create({
        data: {
          userId,
          didNumber: e164,
          telnyxNumberId,
          connectionId,
          label,
          colorHex,
          isDefault,
        },
        select: {
          id: true,
          didNumber: true,
          label: true,
          colorHex: true,
          isDefault: true,
        },
      });

      // If this is now the user's default AND nothing was their default
      // before, point activeUserDidId at the new row.
      if (isDefault) {
        await prisma.user.update({
          where: { id: userId },
          data: { activeUserDidId: created.id },
        });
      }

      await recordAudit(actor.sub, 'user_did.added', userId, {
        source,                  // 'unassigned' or 'purchase' (audit signal for billing review)
        didNumber: e164,
        label,
        colorHex,
        isDefault,
        userDidId: created.id,
        purchased,               // true if we billed Telnyx for a new DID
        purchasedNumber,
      });

      // v0.10.20 — Notify the user that they've been assigned a new line.
      // Both channels are fire-and-forget so the admin response stays fast.
      // Failures are logged but never bubble up — adding a line shouldn't
      // 5xx because SendGrid/Teams was temporarily unreachable.
      const userForNotify = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, isActive: true },
      });
      if (userForNotify?.email && userForNotify.isActive) {
        void sendLineAssignedCard({
          userId,
          didNumber: e164,
          label,
          isDefault: !!isDefault,
          mode: 'added',
        }).then((r) => {
          if (!r.ok) {
            request.log.warn(
              { userId, didNumber: e164, reason: r.skippedReason ?? r.error },
              '[admin.user_dids.add] teams notify failed',
            );
          }
        });
        void sendLineAssignedEmail({
          toEmail: userForNotify.email,
          firstName: userForNotify.firstName,
          didNumber: e164,
          label,
          isDefault: !!isDefault,
          mode: 'added',
        }).then((r) => {
          if (!r.ok) {
            request.log.warn(
              { userId, didNumber: e164, status: r.status, error: r.error },
              '[admin.user_dids.add] email notify failed',
            );
          }
        });
      }

      return {
        ok: true,
        userDid: created,
        purchased,
        purchasedNumber,
      };
    },
  );

  // ── POST /admin/users/:id/dids/migrate ──────────────────────────────────
  // v0.10.20 — "Migrate Existing User to New Dialer".
  //
  // Takes a Telnyx DID that's currently bound to ANOTHER connection (likely
  // Pulse) and re-binds it to THIS user's ACE Credential Connection. The
  // phone number stays the same — only the SIP routing changes. After this
  // call:
  //   • The old connection (Pulse) stops receiving calls/SMS for the DID
  //   • The new connection (this user's ACE creds) starts receiving them
  //   • A UserDid row exists locally so ACE recognises the DID
  //
  // This is a DESTRUCTIVE operation for the old dialer. Audited.
  const MigrateDidSchema = z.object({
    didNumber: z.string().min(8).max(20),
    label: z.string().min(1).max(40).default('Migrated'),
    colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#a855f7'),
    isDefault: z.boolean().optional().default(false),
  });
  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/dids/migrate',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      if (!Number.isFinite(userId)) {
        return reply.code(400).send({ error: 'Invalid user id' });
      }
      const parsed = MigrateDidSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { didNumber, label, colorHex, isDefault } = parsed.data;

      // 1. Verify user exists and has a connection we can re-bind TO.
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          userDids: {
            select: { id: true, didNumber: true, connectionId: true, isDefault: true },
          },
        },
      });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      const defaultDid = target.userDids.find((d) => d.isDefault) ?? target.userDids[0];
      if (!defaultDid) {
        return reply.code(409).send({
          error: 'User has no existing DIDs to inherit a connection from. Complete the invite flow first.',
        });
      }
      let connectionId = defaultDid.connectionId;
      if (!connectionId) {
        const probe = await telnyx.findNumberByE164(defaultDid.didNumber);
        if (probe.ok && probe.data?.connection_id) {
          connectionId = probe.data.connection_id;
          await prisma.userDid.update({
            where: { id: defaultDid.id },
            data: { connectionId },
          });
        }
      }
      if (!connectionId) {
        return reply.code(409).send({
          error: 'Cannot resolve target user\'s ACE connection. Their default DID has no connection_id in Telnyx either.',
        });
      }

      // 2. Normalise E.164.
      const digits = didNumber.replace(/\D/g, '');
      const e164 = digits.startsWith('1') && digits.length === 11
        ? `+${digits}`
        : digits.length === 10
          ? `+1${digits}`
          : didNumber.startsWith('+') ? didNumber : `+${digits}`;

      // 3. Refuse if already in ACE.
      const existing = await prisma.userDid.findUnique({
        where: { didNumber: e164 },
        select: { id: true, userId: true },
      });
      if (existing) {
        return reply.code(409).send({
          error: existing.userId === userId
            ? 'This DID is already assigned to this user.'
            : 'This DID is already assigned to another user in ACE.',
        });
      }

      // 4. Look up the DID on Telnyx.
      const tn = await telnyx.findNumberByE164(e164);
      if (!tn.ok) {
        return reply.code(502).send({ error: 'Telnyx lookup failed', detail: tn.error });
      }
      if (!tn.data) {
        return reply.code(404).send({
          error: `Telnyx doesn't recognize ${e164}. Confirm we own this number.`,
        });
      }
      if (!tn.data.connection_id) {
        return reply.code(409).send({
          error: 'This DID has no current connection on Telnyx — it\'s already unassigned, so use the regular "Add an available number from Telnyx" flow instead.',
        });
      }

      const previousConnectionId = tn.data.connection_id;
      const previousMessagingProfileId = tn.data.messaging_profile_id ?? null;
      const telnyxNumberId = tn.data.id;

      // 5. Re-bind voice to the user's ACE connection.
      const assign = await telnyx.assignDidToConnection(telnyxNumberId, connectionId);
      if (!assign.ok) {
        return reply.code(502).send({
          error: 'Failed to re-bind DID to user\'s ACE connection on Telnyx',
          detail: assign.error,
        });
      }

      // 6. Bind to ACE's messaging profile (inbound SMS routing).
      if (config.telnyxMessagingProfileId) {
        const msg = await telnyx.assignNumberMessagingProfile(
          telnyxNumberId,
          config.telnyxMessagingProfileId,
        );
        if (!msg.ok) {
          request.log.warn(
            { numberId: telnyxNumberId, error: msg.error },
            '[admin.user_dids.migrate] messaging profile assignment failed',
          );
        }
      }

      // 7. If this is now the user's default, unset isDefault on others.
      if (isDefault) {
        await prisma.userDid.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      }
      const created = await prisma.userDid.create({
        data: {
          userId,
          didNumber: e164,
          telnyxNumberId,
          connectionId,
          label,
          colorHex,
          isDefault,
        },
        select: {
          id: true, didNumber: true, label: true, colorHex: true, isDefault: true,
        },
      });
      if (isDefault) {
        await prisma.user.update({
          where: { id: userId },
          data: { activeUserDidId: created.id },
        });
      }

      await recordAudit(actor.sub, 'user_did.migrated', userId, {
        didNumber: e164,
        label,
        colorHex,
        isDefault,
        userDidId: created.id,
        previousConnectionId,                  // Pulse connection we took the DID from
        previousMessagingProfileId,
        newConnectionId: connectionId,         // ACE connection we re-bound to
      });

      // v0.10.22 — Fire-and-forget 30d history backfill from Telnyx.
      // Pulls all voice CDRs + SMS detail records where the migrated number
      // appears as from OR to in the last 30 days, deduped against existing
      // rows, inserted into Call + Message tables. Response returns
      // immediately; backfill streams in over the next minute. Migration
      // never fails because of backfill issues — best-effort only.
      void backfillMigratedDidHistory(
        {
          userId,
          userDidId: created.id,
          didNumber: e164,
          daysBack: 30,
        },
        (obj, msg) => request.log.info(obj, msg),
      ).then((bf) => {
        request.log.info({ userId, didNumber: e164, ...bf }, '[admin.user_dids.migrate] backfill complete');
      }).catch((e) => {
        request.log.warn(
          { userId, didNumber: e164, err: e instanceof Error ? e.message : String(e) },
          '[admin.user_dids.migrate] backfill threw (best-effort, ignored)',
        );
      });

      // v0.10.20 — Notify the user that their number was migrated.
      // Fire-and-forget; failures logged, not surfaced to the admin API
      // response since the actual migration already succeeded.
      const userForNotify = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, isActive: true },
      });
      if (userForNotify?.email && userForNotify.isActive) {
        void sendLineAssignedCard({
          userId,
          didNumber: e164,
          label,
          isDefault: !!isDefault,
          mode: 'migrated',
        }).then((r) => {
          if (!r.ok) {
            request.log.warn(
              { userId, didNumber: e164, reason: r.skippedReason ?? r.error },
              '[admin.user_dids.migrate] teams notify failed',
            );
          }
        });
        void sendLineAssignedEmail({
          toEmail: userForNotify.email,
          firstName: userForNotify.firstName,
          didNumber: e164,
          label,
          isDefault: !!isDefault,
          mode: 'migrated',
        }).then((r) => {
          if (!r.ok) {
            request.log.warn(
              { userId, didNumber: e164, status: r.status, error: r.error },
              '[admin.user_dids.migrate] email notify failed',
            );
          }
        });
      }

      return { ok: true, userDid: created, previousConnectionId };
    },
  );

  // ── POST /admin/telnyx/connections/:id/cleanup ──────────────────────────
  // v0.10.21 — Used by the "what to do with the old SIP connection?" prompt
  // that appears after a successful migration. Two actions:
  //
  //   action: 'deactivate'  → PATCH /credential_connections/{id} active=false
  //                            (reversible — flip back later via Telnyx portal)
  //   action: 'delete'      → DELETE /credential_connections/{id}
  //                            (IRREVERSIBLE — the cred is gone, SIP creds
  //                             on Pulse stop working entirely)
  //
  // Both audited. Both require admin role.
  const ConnectionCleanupSchema = z.object({
    action: z.enum(['deactivate', 'delete']),
    /** Optional context for audit log (e.g. which DID's migration triggered this). */
    reason: z.string().max(200).optional(),
  });
  app.post<{ Params: { id: string } }>(
    '/admin/telnyx/connections/:id/cleanup',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const connectionId = request.params.id;
      if (!connectionId || connectionId.length < 4) {
        return reply.code(400).send({ error: 'Invalid connection id' });
      }
      const parsed = ConnectionCleanupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { action, reason } = parsed.data;

      // Refuse if this connection still backs ANY UserDid in our local DB —
      // would orphan the user immediately. Admin must remove/reassign the
      // user's lines first.
      const usedBy = await prisma.userDid.findFirst({
        where: { connectionId },
        select: { id: true, userId: true, didNumber: true },
      });
      if (usedBy) {
        return reply.code(409).send({
          error: `Refusing to ${action} — connection is still bound to UserDid id=${usedBy.id} (user ${usedBy.userId}, ${usedBy.didNumber}) in ACE. Remove that line first.`,
        });
      }

      // Fetch the connection so the audit record can capture its identity
      // (name + user_name) before we mutate / delete it.
      const before = await telnyx.fetchCredentialConnection(connectionId);
      const beforeName = before.ok ? before.data?.data?.connection_name ?? null : null;
      const beforeUser = before.ok ? before.data?.data?.user_name ?? null : null;

      if (action === 'deactivate') {
        const res = await telnyx.deactivateCredentialConnection(connectionId);
        if (!res.ok) {
          return reply.code(502).send({
            error: 'Telnyx deactivate failed',
            detail: res.error,
          });
        }
        await recordAudit(actor.sub, 'telnyx.connection.deactivated', null, {
          connectionId,
          connectionName: beforeName,
          sipUser: beforeUser,
          reason,
        });
        return { ok: true, action: 'deactivate' };
      }

      // action === 'delete' — IRREVERSIBLE.
      const res = await telnyx.deleteCredentialConnection(connectionId);
      if (!res.ok) {
        return reply.code(502).send({
          error: 'Telnyx delete failed',
          detail: res.error,
        });
      }
      await recordAudit(actor.sub, 'telnyx.connection.deleted', null, {
        connectionId,
        connectionName: beforeName,
        sipUser: beforeUser,
        reason,
      });
      return { ok: true, action: 'delete' };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // v0.10.22 — Microsoft Graph OAuth for Teams notifications.
  //
  // Admin signs in ONCE as acebot@aptask.com via the initiate→callback
  // flow. Refresh token gets stored in MsServiceToken. From then on,
  // Teams DMs (line_assigned, missed_call, voicemail, SMS) flow through
  // sendLineAssignedCard which uses the token to talk to Graph API.
  // ═══════════════════════════════════════════════════════════════════════

  // In-memory state map for CSRF protection across the OAuth round-trip.
  // Keys: random nonce. Values: timestamp expiring after 10 minutes.
  // Single-process is fine — the OAuth flow only takes ~30s for the user.
  const oauthStateMap = new Map<string, number>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of oauthStateMap.entries()) {
      if (exp < now) oauthStateMap.delete(k);
    }
  }, 60_000).unref();

  // GET /admin/microsoft/oauth/initiate
  // Returns { redirectUrl } — frontend opens this in a popup or full
  // navigation. The admin will be prompted to sign in as acebot.
  app.get(
    '/admin/microsoft/oauth/initiate',
    { onRequest: [app.authenticate, requireAdmin] },
    async (_request, reply) => {
      const state = randomUUID();
      oauthStateMap.set(state, Date.now() + 10 * 60 * 1000);
      try {
        const url = buildAuthorizeUrl(state);
        return { redirectUrl: url };
      } catch (e) {
        return reply.code(503).send({
          error: e instanceof Error ? e.message : 'MS Graph config missing',
        });
      }
    },
  );

  // GET /admin/microsoft/oauth/callback
  // Hit by Microsoft after the admin signs in. Exchanges the code for
  // tokens, stores them, then returns a small HTML page the popup window
  // shows briefly before closing itself.
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/admin/microsoft/oauth/callback',
    async (request, reply) => {
      const { code, state, error, error_description } = request.query;

      if (error) {
        return reply.code(400).type('text/html').send(
          buildCallbackHtml(false, `Microsoft returned error: ${error_description || error}`),
        );
      }
      if (!code || !state) {
        return reply.code(400).type('text/html').send(
          buildCallbackHtml(false, 'Missing code or state parameter'),
        );
      }
      // Verify state nonce (CSRF protection).
      if (!oauthStateMap.has(state)) {
        return reply.code(400).type('text/html').send(
          buildCallbackHtml(false, 'OAuth state expired or invalid — please retry from the dialer'),
        );
      }
      oauthStateMap.delete(state);

      try {
        const tokens = await exchangeCodeForTokens(code);
        await storeInitialTokens(tokens);
        return reply.type('text/html').send(
          buildCallbackHtml(true, 'Connected — you can close this window.'),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        request.log.error({ err: msg }, '[ms-oauth] token exchange failed');
        return reply.code(500).type('text/html').send(
          buildCallbackHtml(false, `Token exchange failed: ${msg}`),
        );
      }
    },
  );

  // GET /admin/microsoft/oauth/status — used by the admin UI.
  app.get(
    '/admin/microsoft/oauth/status',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      return getConnectionStatus();
    },
  );

  // POST /admin/microsoft/oauth/disconnect — wipes the stored tokens.
  app.post(
    '/admin/microsoft/oauth/disconnect',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const actor = request.user as JwtPayload;
      await disconnectGraph();
      await recordAudit(actor.sub, 'ms_graph.disconnected', null, {});
      return { ok: true };
    },
  );

  // ── POST /admin/users/:id/dids/:didId/backfill-from-csv ────────────────
  //
  // v0.10.27 — Critical workaround. Telnyx's /v2/detail_records sync API
  // doesn't actually support filter[from]/filter[to] — it silently returns
  // empty when those filters are applied. This means the automatic backfill
  // never finds anything. As an immediate fix, admin can manually export
  // the CSV from Telnyx Portal → Reports and upload it here.
  //
  // Body: { csvText: string, type: 'voice' | 'sms' }
  //
  // Voice CSV columns expected (from Telnyx CDR export):
  //   "Originating Number", "Terminating number", "Start Timestamp(UTC)",
  //   "Answer Timestamp", "End Timestamp", "Call duration", "Direction",
  //   "Hangup cause", "Call UUID"
  //
  // SMS CSV columns expected (from Telnyx MDR export):
  //   "Message ID", "From", "To", "Direction", "Body", "Created At",
  //   "Status", "Carrier"
  //
  // Dedupes via Call.telnyxCallId / Message.telnyxMessageId unique constraint.
  const BackfillCsvSchema = z.object({
    csvText: z.string().min(10),
    type: z.enum(['voice', 'sms']),
  });
  app.post<{ Params: { id: string; didId: string } }>(
    '/admin/users/:id/dids/:didId/backfill-from-csv',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      const didId = Number(request.params.didId);
      if (!Number.isFinite(userId) || !Number.isFinite(didId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = BackfillCsvSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const userDid = await prisma.userDid.findFirst({
        where: { id: didId, userId },
        select: { id: true, didNumber: true },
      });
      if (!userDid) {
        return reply.code(404).send({ error: 'UserDid not found for this user' });
      }

      const rows = parseCsv(parsed.data.csvText);
      if (rows.length === 0) {
        return { ok: true, inserted: 0, skipped: 0, parsed: 0 };
      }

      if (parsed.data.type === 'voice') {
        const callRows = rows
          .map((r) => mapTelnyxCdrCsvRow(r, userId, userDid.id))
          .filter((x): x is NonNullable<typeof x> => x !== null);
        const result = await prisma.call.createMany({
          data: callRows,
          skipDuplicates: true,
        });
        await recordAudit(actor.sub, 'user_did.backfill_csv', userId, {
          userDidId: didId,
          didNumber: userDid.didNumber,
          type: 'voice',
          parsed: rows.length,
          mapped: callRows.length,
          inserted: result.count,
        });
        return {
          ok: true,
          type: 'voice',
          parsed: rows.length,
          mapped: callRows.length,
          inserted: result.count,
          skipped: callRows.length - result.count,
        };
      }

      // type === 'sms'
      const msgRows = rows
        .map((r) => mapTelnyxMdrCsvRow(r, userId, userDid.id, userDid.didNumber))
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const result = await prisma.message.createMany({
        data: msgRows,
        skipDuplicates: true,
      });
      await recordAudit(actor.sub, 'user_did.backfill_csv', userId, {
        userDidId: didId,
        didNumber: userDid.didNumber,
        type: 'sms',
        parsed: rows.length,
        mapped: msgRows.length,
        inserted: result.count,
      });
      return {
        ok: true,
        type: 'sms',
        parsed: rows.length,
        mapped: msgRows.length,
        inserted: result.count,
        skipped: msgRows.length - result.count,
      };
    },
  );

  // ── POST /admin/users/:id/dids/:didId/backfill ──────────────────────────
  //
  // v0.10.26 — Manually re-trigger the 30-day call+SMS history backfill for
  // an already-migrated UserDid. Used when the original migration's
  // backfill didn't run (e.g. migration happened before the backfill code
  // was deployed) or when the admin wants to retry after fixing a Telnyx
  // API access issue.
  //
  // Synchronous (not fire-and-forget) so the admin sees real counts in the
  // response. Same dedup-via-unique-constraint pattern means retrying is safe.
  const BackfillSchema = z.object({
    daysBack: z.number().int().min(1).max(90).optional().default(30),
  });
  app.post<{ Params: { id: string; didId: string } }>(
    '/admin/users/:id/dids/:didId/backfill',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      const didId = Number(request.params.didId);
      if (!Number.isFinite(userId) || !Number.isFinite(didId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = BackfillSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const userDid = await prisma.userDid.findFirst({
        where: { id: didId, userId },
        select: { id: true, didNumber: true },
      });
      if (!userDid) {
        return reply.code(404).send({ error: 'UserDid not found for this user' });
      }

      const result = await backfillMigratedDidHistory(
        {
          userId,
          userDidId: userDid.id,
          didNumber: userDid.didNumber,
          daysBack: parsed.data.daysBack,
        },
        (obj, msg) => request.log.info(obj, msg),
      );

      await recordAudit(actor.sub, 'user_did.backfill_rerun', userId, {
        userDidId: didId,
        didNumber: userDid.didNumber,
        daysBack: parsed.data.daysBack,
        result,
      });

      return { ok: true, ...result };
    },
  );

  // ── PATCH /admin/users/:id/dids/:didId ──────────────────────────────────
  const PatchDidSchema = z.object({
    label: z.string().min(1).max(40).optional(),
    colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    isDefault: z.boolean().optional(),
  });
  app.patch<{ Params: { id: string; didId: string } }>(
    '/admin/users/:id/dids/:didId',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      const didId = Number(request.params.didId);
      if (!Number.isFinite(userId) || !Number.isFinite(didId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = PatchDidSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const existing = await prisma.userDid.findFirst({
        where: { id: didId, userId },
        select: { id: true, didNumber: true, isDefault: true },
      });
      if (!existing) {
        return reply.code(404).send({ error: 'UserDid not found for this user' });
      }

      // If we're flipping isDefault to true, unset the others first.
      if (parsed.data.isDefault === true && !existing.isDefault) {
        await prisma.userDid.updateMany({
          where: { userId, id: { not: didId } },
          data: { isDefault: false },
        });
        await prisma.user.update({
          where: { id: userId },
          data: { activeUserDidId: didId },
        });
      }

      const updated = await prisma.userDid.update({
        where: { id: didId },
        data: parsed.data,
        select: {
          id: true, didNumber: true, label: true, colorHex: true, isDefault: true,
        },
      });

      await recordAudit(actor.sub, 'user_did.updated', userId, {
        userDidId: didId,
        changes: parsed.data,
      });

      return { ok: true, userDid: updated };
    },
  );

  // ── DELETE /admin/users/:id/dids/:didId ─────────────────────────────────
  // Removes a DID from a user. Refuses if it's the user's only DID
  // (would leave them un-callable). Also unassigns the DID on Telnyx so
  // it returns to the pool — admin can re-use it on another user via
  // the unassigned-numbers picker.
  app.delete<{ Params: { id: string; didId: string } }>(
    '/admin/users/:id/dids/:didId',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const userId = Number(request.params.id);
      const didId = Number(request.params.didId);
      if (!Number.isFinite(userId) || !Number.isFinite(didId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const target = await prisma.userDid.findFirst({
        where: { id: didId, userId },
        select: {
          id: true, didNumber: true, telnyxNumberId: true, isDefault: true,
        },
      });
      if (!target) {
        return reply.code(404).send({ error: 'UserDid not found for this user' });
      }

      const total = await prisma.userDid.count({ where: { userId } });
      if (total <= 1) {
        return reply.code(409).send({
          error: 'Cannot remove the user\'s only DID. Assign another line first, or hard-delete the user from the Users tab.',
        });
      }

      // Telnyx side: unassign so the number returns to the pool.
      // Non-fatal — if Telnyx rejects, we still drop the UserDid row
      // (admin can fix the Telnyx side later).
      let telnyxUnassigned = false;
      if (target.telnyxNumberId) {
        const un = await telnyx.unassignNumber(target.telnyxNumberId);
        telnyxUnassigned = un.ok;
        if (!un.ok) {
          request.log.warn(
            { numberId: target.telnyxNumberId, error: un.error },
            '[admin.user_dids.delete] Telnyx unassign failed',
          );
        }
      }

      // If we're removing the default, promote another UserDid to default.
      // Pick the oldest remaining (most established line).
      if (target.isDefault) {
        const next = await prisma.userDid.findFirst({
          where: { userId, id: { not: didId } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) {
          await prisma.userDid.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
          await prisma.user.update({
            where: { id: userId },
            data: { activeUserDidId: next.id },
          });
        }
      }

      await prisma.userDid.delete({ where: { id: didId } });

      await recordAudit(actor.sub, 'user_did.removed', userId, {
        userDidId: didId,
        didNumber: target.didNumber,
        wasDefault: target.isDefault,
        telnyxUnassigned,
      });

      return { ok: true, telnyxUnassigned };
    },
  );

  // ── POST /admin/pending-users/import ────────────────────────────────────
  app.post(
    '/admin/pending-users/import',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const parsed = PendingUserImportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const batchId = randomUUID();
      let inserted = 0;
      let updated = 0;
      const errors: Array<{ row: number; email: string; error: string }> = [];

      for (let i = 0; i < parsed.data.rows.length; i += 1) {
        const row = parsed.data.rows[i];
        const email = row.email.trim().toLowerCase();
        try {
          const existing = await prisma.pendingUser.findUnique({
            where: { email },
            select: { id: true },
          });
          const data = {
            firstName: row.firstName ?? null,
            lastName: row.lastName ?? null,
            pulseVoipExt: row.pulseVoipExt,
            pulseVoipNumber: row.pulseVoipNumber,
            pulseExtPassword: row.pulseExtPassword,
            pulseConnectionName: row.pulseConnectionName ?? null,
            pulseUserStatus: row.pulseUserStatus ?? null,
            importBatchId: batchId,
          };
          if (existing) {
            await prisma.pendingUser.update({
              where: { email },
              data: { ...data, importedAt: new Date() },
            });
            updated += 1;
          } else {
            await prisma.pendingUser.create({ data: { email, ...data } });
            inserted += 1;
          }
        } catch (e) {
          errors.push({
            row: i + 1,
            email,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      await recordAudit(actor.sub, 'pending_users.imported', null, {
        batchId,
        total: parsed.data.rows.length,
        inserted,
        updated,
        errorCount: errors.length,
      });

      return { batchId, inserted, updated, errors };
    },
  );

  // ── GET /admin/pending-users ────────────────────────────────────────────
  app.get(
    '/admin/pending-users',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const q = request.query as { status?: string; batch?: string };
      const where: Record<string, unknown> = {};
      if (q.status === 'invited' || q.status === 'pending' || q.status === 'skipped') {
        where.status = q.status;
      }
      if (q.batch) where.importBatchId = q.batch;

      const rows = await prisma.pendingUser.findMany({
        where,
        orderBy: [{ status: 'asc' }, { importedAt: 'desc' }],
      });

      // PendingUser.invitedUserId is a plain Int column, NOT a Prisma
      // relation (intentional — avoids cascade-delete weirdness if a
      // User row is removed). So we can't `include` the User; instead
      // we bulk-fetch the lastLoginAt for every invitedUserId we saw
      // and build a lookup map.
      const invitedIds = rows
        .map((r) => r.invitedUserId)
        .filter((v): v is number => typeof v === 'number');
      const loginMap = new Map<number, Date | null>();
      if (invitedIds.length > 0) {
        const users = await prisma.user.findMany({
          where: { id: { in: invitedIds } },
          select: { id: true, lastLoginAt: true },
        });
        for (const u of users) loginMap.set(u.id, u.lastLoginAt);
      }

      const groups = await prisma.pendingUser.groupBy({
        by: ['status'],
        _count: { id: true },
      });
      // Counts: pending / invited / skipped come from the raw status
      // column; `accepted` is a derived bucket = status='invited' AND
      // the linked User has logged in at least once. We then subtract
      // the accepted slice from `invited` so the UI's "Invited" chip
      // shows only people who haven't logged in yet.
      const counts: Record<string, number> = {
        pending: 0,
        invited: 0,
        skipped: 0,
        accepted: 0,
      };
      for (const g of groups) counts[g.status] = g._count.id;
      let acceptedCount = 0;
      for (const r of rows) {
        if (r.status === 'invited' && r.invitedUserId != null) {
          if (loginMap.get(r.invitedUserId)) acceptedCount += 1;
        }
      }
      // The findMany result is filtered by `where`, so the raw groupBy
      // is the source of truth for total invited; only the accepted
      // count uses the filtered rows. Compute global accepted via a
      // separate count to keep the chip totals consistent across
      // status filters.
      const globalAcceptedRows = await prisma.pendingUser.findMany({
        where: { status: 'invited', invitedUserId: { not: null } },
        select: { invitedUserId: true },
      });
      const globalInvitedIds = globalAcceptedRows
        .map((r) => r.invitedUserId)
        .filter((v): v is number => typeof v === 'number');
      if (globalInvitedIds.length > 0) {
        const globalUsers = await prisma.user.findMany({
          where: { id: { in: globalInvitedIds }, lastLoginAt: { not: null } },
          select: { id: true },
        });
        acceptedCount = globalUsers.length;
      } else {
        acceptedCount = 0;
      }
      counts.accepted = acceptedCount;
      counts.invited = Math.max(0, counts.invited - acceptedCount);

      return {
        items: rows.map((r) => ({
          ...r,
          // Don't leak the SIP password to the client in the LIST view —
          // only the invite endpoint needs to know it server-side. Show a
          // boolean indicator instead.
          pulseExtPassword: undefined,
          hasPassword: !!r.pulseExtPassword,
          // True when the linked User row has logged in at least once.
          // Lets the client compute the derived "Accepted" status without
          // a second round-trip.
          hasLoggedIn:
            r.invitedUserId != null && !!loginMap.get(r.invitedUserId),
          importedAt: r.importedAt.toISOString(),
          invitedAt: r.invitedAt ? r.invitedAt.toISOString() : null,
        })),
        counts,
      };
    },
  );

  // ── POST /admin/pending-users/:id/invite ───────────────────────────────
  // The actual provisioning. Reads PendingUser + the 4 modal toggles, then
  // orchestrates: (Telnyx work?) → create User row → (welcome email?) →
  // mark PendingUser.status=invited. Every step is logged into the returned
  // `steps` array so the UI can show a per-step success/error table.
  app.post<{ Params: { id: string } }>(
    '/admin/pending-users/:id/invite',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const parsed = InviteFromPendingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { didMode, credsMode, repointWebhook, sendEmail, newDidAreaCode } = parsed.data;

      const pending = await prisma.pendingUser.findUnique({ where: { id } });
      if (!pending) return reply.code(404).send({ error: 'Pending user not found' });
      if (pending.status === 'invited') {
        return reply.code(409).send({
          error: 'Already invited',
          invitedAt: pending.invitedAt?.toISOString() ?? null,
          invitedUserId: pending.invitedUserId,
        });
      }

      // Pre-flight: refuse to start the Telnyx orchestration if this email is
      // already a User row (e.g. the admin themselves, or someone added via
      // Admin → Users). Otherwise we'd touch Telnyx and then fail on the
      // Prisma unique constraint at the very end. Same check for sipUsername
      // when credsMode=existing, since reusing the Pulse extension as the
      // sipUsername would collide too.
      // v0.9.10 — allow recycling soft-deactivated rows so admins can
      // re-invite users whose history blocked the hard delete.
      const dupEmail = await prisma.user.findUnique({
        where: { email: pending.email.toLowerCase() },
        select: { id: true, email: true, didNumber: true, isActive: true },
      });
      const recyclePendingUserId = dupEmail && !dupEmail.isActive ? dupEmail.id : null;
      if (dupEmail && dupEmail.isActive) {
        return reply.code(409).send({
          error:
            `A User row already exists for ${pending.email} ` +
            `(id ${dupEmail.id}) and is active. Delete that user first, or skip this row.`,
          existingUserId: dupEmail.id,
        });
      }
      if (parsed.data.credsMode === 'existing' && pending.pulseVoipExt) {
        const dupSip = await prisma.user.findUnique({
          where: { sipUsername: pending.pulseVoipExt },
          select: { id: true, email: true },
        });
        if (dupSip) {
          return reply.code(409).send({
            error:
              `SIP username "${pending.pulseVoipExt}" is already in use by ` +
              `User id ${dupSip.id} (${dupSip.email}). Pick "Generate new ACE credentials" instead.`,
            existingUserId: dupSip.id,
          });
        }
      }

      type StepLog = { step: string; ok: boolean; error?: string };
      const steps: StepLog[] = [];
      const step = (name: string, ok: boolean, error?: string) => {
        steps.push({ step: name, ok, ...(error ? { error } : {}) });
      };

      // Resolved values we'll write into the User row at the end.
      let sipUsername: string = pending.pulseVoipExt;
      let sipPassword: string = pending.pulseExtPassword;
      let didNumber: string = pending.pulseVoipNumber;
      let newConnectionId: string | null = null;
      let credsCreated = false;
      let didPurchased = false;
      let webhookRepointed = false;
      let emailSent = false;

      // ── Step 1: SIP credentials ──────────────────────────────────────
      if (credsMode === 'existing') {
        step('use existing SIP credentials (from CSV)', true);
      } else {
        const connectionName =
          `${(pending.firstName || pending.email.split('@')[0]).toLowerCase()}-ace`.replace(/[^a-z0-9-]/gi, '');
        // Telnyx user_name: letters + digits only. No underscores, hyphens,
        // or spaces (see Telnyx error code 10015).
        const userName =
          `ace${pending.pulseVoipExt.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}${Date.now().toString(36).slice(-6)}`;

        // v0.9.7 — Try template-clone first so the new connection inherits the
        // proven-working outbound voice profile + channel limits + codecs from
        // the +17322001305 connection. If we can't resolve the template or the
        // clone fails, fall back to a plain create — NEVER block the invite.
        const tplIdRes = await telnyx.resolveTemplateConnectionId();
        const tplId = tplIdRes.ok ? tplIdRes.data : null;
        let usedTemplate = false;
        if (tplId) {
          const cloneRes = await telnyx.createConnectionFromTemplate({
            connectionName,
            userName,
            templateConnectionId: tplId,
          });
          if (cloneRes.ok && cloneRes.connection) {
            sipUsername = cloneRes.connection.user_name;
            sipPassword = cloneRes.connection.password ?? '';
            newConnectionId = cloneRes.connection.id;
            credsCreated = true;
            usedTemplate = true;
            if (cloneRes.templateApplied) {
              step('clone Telnyx connection from template (outbound voice profile + limits)', true);
            } else {
              step('clone Telnyx connection from template — created but PATCH partial', true);
              for (const w of cloneRes.warnings) step(`template warning: ${w}`, false);
            }
          } else {
            step('clone Telnyx connection from template', false, JSON.stringify(cloneRes.error ?? cloneRes.warnings));
          }
        } else if (!tplIdRes.ok) {
          step('resolve template connection id', false, JSON.stringify(tplIdRes.error));
        } else {
          step('resolve template connection id', false, 'No TELNYX_TEMPLATE_CONNECTION_ID/DID configured');
        }

        if (!usedTemplate) {
          // Fallback: plain create without template clone.
          const res = await telnyx.createCredentialConnection({ connectionName, userName });
          if (!res.ok || !res.data) {
            step('create new Telnyx Credential Connection (fallback)', false, JSON.stringify(res.error));
            return reply.code(502).send({
              error: 'Telnyx createCredentialConnection failed',
              steps,
            });
          }
          sipUsername = res.data.data.user_name;
          sipPassword = res.data.data.password ?? '';
          newConnectionId = res.data.data.id;
          credsCreated = true;
          step('create new Telnyx Credential Connection (fallback — no template)', true);
        }
      }

      // ── Step 2: DID number ──────────────────────────────────────────
      if (didMode === 'existing') {
        // Use the user's existing Pulse DID as-is. If we ALSO created new
        // credentials above, we need to reroute the DID from the Pulse
        // connection to the new ACE connection.
        if (credsMode === 'new' && newConnectionId) {
          const digits = pending.pulseVoipNumber.replace(/[^\d]/g, '');
          const e164 = digits.length === 10 ? `+1${digits}` : digits.startsWith('1') ? `+${digits}` : `+${digits}`;
          const lookup = await telnyx.findNumberByE164(e164);
          if (!lookup.ok || !lookup.data) {
            step('look up existing DID in Telnyx', false, `Number not found: ${e164}`);
            return reply.code(502).send({ error: 'Existing DID lookup failed', steps });
          }
          const assign = await telnyx.assignDidToConnection(lookup.data.id, newConnectionId);
          if (!assign.ok) {
            step('assign existing DID to new connection', false, JSON.stringify(assign.error));
            return reply.code(502).send({ error: 'DID assignment failed', steps });
          }
          step('reroute existing DID to new ACE connection', true);
        } else {
          step('use existing DID (from CSV)', true);
        }
      } else if (didMode === 'unassigned') {
        // Admin picked an already-owned-but-unassigned ACE number from the
        // dropdown. Skip the purchase and just route it to their connection.
        // Saves the per-DID monthly cost of buying a new one.
        const picked = parsed.data.unassignedDidNumber;
        if (!picked) {
          step('use unassigned ACE number', false, 'No number was picked');
          return reply.code(400).send({ error: 'unassignedDidNumber required', steps });
        }
        const lookup = await telnyx.findNumberByE164(picked);
        if (!lookup.ok || !lookup.data) {
          step('look up unassigned DID in Telnyx', false, `Number not found: ${picked}`);
          return reply.code(502).send({ error: 'Unassigned DID lookup failed', steps });
        }

        // Decide which connection to route it to: the freshly-created ACE
        // connection (credsMode=new) or the user's Pulse connection from
        // the CSV (credsMode=existing).
        let targetConnId: string | undefined = newConnectionId ?? undefined;
        if (!targetConnId && pending.pulseConnectionName) {
          const c = await telnyx.findConnectionByName(pending.pulseConnectionName);
          if (c.ok && c.data) targetConnId = c.data.id;
        }
        if (!targetConnId) {
          step('assign unassigned DID', false, 'No target connection could be resolved');
          return reply.code(502).send({ error: 'No target connection for unassigned DID', steps });
        }

        const assign = await telnyx.assignDidToConnection(lookup.data.id, targetConnId);
        if (!assign.ok) {
          step(`assign unassigned DID ${picked}`, false, JSON.stringify(assign.error));
          return reply.code(502).send({ error: 'Unassigned DID assignment failed', steps });
        }
        didNumber = picked;
        step(`assign unassigned DID ${picked} to user connection`, true);
      } else {
        // Purchase a new DID. Match the area code of the user's existing
        // Pulse number unless the admin overrode it.
        const areaCode = newDidAreaCode ?? telnyx.extractUsAreaCode(pending.pulseVoipNumber) ?? '732';
        const search = await telnyx.searchAvailableLocal(areaCode, 5);
        if (!search.ok || !search.data?.data?.length) {
          step('search available DIDs', false, `No numbers available in area code ${areaCode}`);
          return reply.code(502).send({ error: 'No DIDs available', steps });
        }
        const target = search.data.data[0].phone_number;
        step(`found candidate DID ${target} in area ${areaCode}`, true);

        // Pick which connection to route the new DID to.
        let targetConnId: string | undefined = newConnectionId ?? undefined;
        if (!targetConnId && pending.pulseConnectionName) {
          const lookup = await telnyx.findConnectionByName(pending.pulseConnectionName);
          if (lookup.ok && lookup.data) {
            targetConnId = lookup.data.id;
          }
        }

        const purchase = await telnyx.purchaseDid(target, targetConnId);
        if (!purchase.ok || !purchase.data) {
          step(`purchase DID ${target}`, false, JSON.stringify(purchase.error));
          return reply.code(502).send({ error: 'DID purchase failed', steps });
        }
        didNumber = target;
        didPurchased = true;
        step(`purchase DID ${target}` + (targetConnId ? ' (routed to connection)' : ''), true);
      }

      // ── Step 2.5: Auto-flip messaging profile to ACE ─────────────────
      // Regardless of which DID mode the admin picked, the user's number
      // should route inbound SMS to ACE's messaging webhook (not Pulse).
      // This runs every time so users are SMS-ready the moment they log in
      // — no manual portal config, no "valuable time" wasted.
      // Skipped only if TELNYX_MESSAGING_PROFILE_ID isn't configured in env.
      if (didNumber && config.telnyxMessagingProfileId) {
        const digits = didNumber.replace(/[^\d]/g, '');
        const e164 = digits.length === 10
          ? `+1${digits}`
          : digits.startsWith('1') ? `+${digits}` : `+${digits}`;
        const lookup = await telnyx.findNumberByE164(e164);
        if (!lookup.ok || !lookup.data) {
          step('look up DID to bind messaging profile', false, `Number not found: ${e164}`);
          // Non-fatal — user can still receive calls; we just won't get SMS
          // until an admin binds the messaging profile manually.
        } else {
          const bind = await telnyx.assignNumberMessagingProfile(
            lookup.data.id,
            config.telnyxMessagingProfileId,
          );
          if (bind.ok) {
            step('bind DID to ACE messaging profile (SMS routing)', true);
          } else {
            step('bind DID to ACE messaging profile (SMS routing)', false, JSON.stringify(bind.error));
            // Also non-fatal — voice still works.
          }
        }
      } else if (didNumber && !config.telnyxMessagingProfileId) {
        step('bind messaging profile', false,
          'Skipped: TELNYX_MESSAGING_PROFILE_ID env var not set');
      }

      // ── Step 2.75: Caller ID Override (v0.9.11) ─────────────────────
      // Set outbound.ani_override on the user's connection to their OWN DID
      // so outbound calls from the WebRTC dialer present THIS user's number
      // (not the template's +17322001305). Without this, the previous
      // "template clone" was inheriting Abdulla's DID as the caller ID for
      // every new user — wrong number on every call.
      //
      // Target connection:
      //   - credsMode === 'new'      → the freshly-created connection
      //   - credsMode === 'existing' → the user's existing Pulse connection
      //     (resolved via the DID's connection_id since the DID is bound to
      //     it after step 2)
      if (didNumber) {
        const didDigits = didNumber.replace(/[^\d]/g, '');
        const didE164ForOverride = didNumber.startsWith('+')
          ? didNumber
          : didDigits.length === 11 && didDigits.startsWith('1')
            ? `+${didDigits}`
            : didDigits.length === 10
              ? `+1${didDigits}`
              : `+${didDigits}`;
        let overrideConnId: string | null = newConnectionId;
        if (!overrideConnId) {
          // Resolve via the DID for the credsMode=existing path.
          const probe = await telnyx.findNumberByE164(didE164ForOverride);
          if (probe.ok && probe.data?.connection_id) {
            overrideConnId = probe.data.connection_id;
          }
        }
        if (overrideConnId) {
          const override = await telnyx.setConnectionCallerIdOverride(
            overrideConnId,
            didE164ForOverride,
          );
          if (override.ok) {
            step(`set Caller ID Override = ${didE164ForOverride}`, true);
          } else {
            step(`set Caller ID Override = ${didE164ForOverride}`, false,
              JSON.stringify(override.error));
          }
        } else {
          step('set Caller ID Override', false,
            'Could not resolve a target connection id (no newConnectionId and DID has no connection_id)');
        }
      }

      // ── Step 3: Repoint webhook ─────────────────────────────────────
      // Only meaningful when we're keeping the user's existing Pulse
      // connection (credsMode=existing). If credsMode=new, the new
      // connection already has the ACE webhook from createCredentialConnection.
      //
      // v0.9.10 — "Pulse connection not found" is NOT a real failure here.
      // The user's calls + SMS already route to ACE via the DID's
      // connection_id + messaging_profile_id (set in Step 2 / 2.5). The
      // webhook repoint is only relevant if the OLD Pulse connection is
      // still listed in Telnyx and stealing events. If it's not there,
      // nothing to do — log as a clean success ("skipped — no stale
      // Pulse connection") instead of a scary red X.
      if (repointWebhook) {
        if (credsMode === 'new') {
          step('webhook already on ACE (new connection)', true);
          webhookRepointed = true;
        } else if (!pending.pulseConnectionName) {
          step(
            'webhook repoint skipped — no Pulse connection name in CSV row (calls + SMS still route to ACE)',
            true,
          );
        } else {
          const conn = await telnyx.findConnectionByName(pending.pulseConnectionName);
          if (!conn.ok || !conn.data) {
            // Pulse connection isn't in Telnyx — probably already removed,
            // renamed, or the CSV name was a placeholder. Either way, no
            // repoint needed because there's no stale webhook to flip.
            step(
              `webhook repoint skipped — Pulse connection "${pending.pulseConnectionName}" not in Telnyx (likely already migrated; calls + SMS still route to ACE)`,
              true,
            );
          } else {
            const patch = await telnyx.patchConnectionWebhook(conn.data.id, config.telnyxWebhookUrl);
            if (patch.ok) {
              webhookRepointed = true;
              step('repoint webhook to ACE', true);
            } else {
              step('repoint webhook to ACE', false, JSON.stringify(patch.error));
            }
          }
        }
      }

      // ── Step 4: Create the User row ─────────────────────────────────
      // Normalize the DID to +E.164 so it matches the rest of the system.
      const digits = didNumber.replace(/[^\d]/g, '');
      const didE164 = didNumber.startsWith('+')
        ? didNumber
        : digits.length === 11 && digits.startsWith('1')
          ? `+${digits}`
          : digits.length === 10
            ? `+1${digits}`
            : `+${digits}`;

      let createdUser: { id: number; email: string; firstName: string | null; didNumber: string | null };
      try {
        // v0.9.10 — recycle the soft-deactivated row if we found one earlier.
        // Lets admins re-invite users whose history blocked hard delete.
        createdUser = recyclePendingUserId
          ? await prisma.user.update({
              where: { id: recyclePendingUserId },
              data: {
                firstName: pending.firstName,
                lastName: pending.lastName,
                sipUsername,
                sipPassword,
                didNumber: didE164,
                isActive: true,
                provider: 'microsoft',
                lastLoginAt: null,
              },
              select: { id: true, email: true, firstName: true, didNumber: true },
            })
          : await prisma.user.create({
              data: {
                email: pending.email.toLowerCase(),
                firstName: pending.firstName,
                lastName: pending.lastName,
                sipUsername,
                sipPassword,
                didNumber: didE164,
                isAdmin: false,
                isActive: true,
                provider: 'microsoft',
                passwordHash: null,
              },
              select: { id: true, email: true, firstName: true, didNumber: true },
            });
        step(
          recyclePendingUserId
            ? `recycle deactivated User row #${recyclePendingUserId} (re-activated)`
            : 'create User row',
          true,
        );
      } catch (e) {
        step('create/recycle User row', false, e instanceof Error ? e.message : String(e));
        return reply.code(500).send({
          error: 'User creation failed (likely duplicate email or sipUsername)',
          steps,
        });
      }

      // v0.10.0 — Ensure matching UserDid row (see lib/userDid.ts). Done
      // here regardless of recycle vs create so the activeUserDidId
      // pointer and UserDid row exist for the SMS path + DidSwitcher.
      //
      // The variable holding the Telnyx connection id in this scope is
      // `newConnectionId` (set when we cloned a Credential Connection in
      // Step 1 with credsMode='new'). For credsMode='existing' it stays
      // null — that's fine; ensureUserDid tolerates a null connectionId
      // and the DID itself is still routed correctly via Telnyx-side
      // connection_id binding. Hot-fix: this previously referenced an
      // unscoped `connectionId` and broke the Render build.
      const pendingInviteLinked = await ensureUserDid({
        userId: createdUser.id,
        didNumber: didE164,
        connectionId: newConnectionId,
        isDefault: true,
      });
      if (pendingInviteLinked.ok) {
        step('link UserDid row + set as default outbound line', true);
      } else {
        step('link UserDid row', false, pendingInviteLinked.error ?? 'unknown error');
      }

      // ── Step 5: Mark PendingUser as invited ─────────────────────────
      await prisma.pendingUser.update({
        where: { id },
        data: {
          status: 'invited',
          invitedAt: new Date(),
          invitedUserId: createdUser.id,
        },
      });
      step('mark PendingUser as invited', true);

      // ── Step 6: Send welcome email (optional) ──────────────────────
      if (sendEmail) {
        const sendRes = await sendWelcomeEmail({
          toEmail: createdUser.email,
          firstName: createdUser.firstName,
          didNumber: createdUser.didNumber,
        });
        if (sendRes.ok) {
          emailSent = true;
          step('send welcome email', true);
        } else {
          step('send welcome email', false,
            typeof sendRes.error === 'string' ? sendRes.error : JSON.stringify(sendRes.error));
        }
      } else {
        step('skip welcome email (admin opted out)', true);
      }

      // ── Audit ───────────────────────────────────────────────────────
      await recordAudit(actor.sub, 'pending_user.invited', createdUser.id, {
        pendingUserId: pending.id,
        pendingEmail: pending.email,
        didMode,
        credsMode,
        repointWebhook,
        sendEmail,
        didNumber: didE164,
        credsCreated,
        didPurchased,
        webhookRepointed,
        emailSent,
      });

      return {
        ok: true,
        userId: createdUser.id,
        didNumber: didE164,
        sipUsername,
        credsCreated,
        didPurchased,
        webhookRepointed,
        emailSent,
        steps,
      };
    },
  );

  // ── DELETE /admin/pending-users/:id (v0.9.7) ────────────────────────────
  // For PENDING rows: drops the staging row only.
  // For INVITED rows: cleans up Telnyx (unassign DID + delete Credential
  // Connection), deletes the linked User row, then drops the PendingUser row.
  // Returns a per-step log so the UI can show exactly what was cleaned up.
  app.delete<{ Params: { id: string } }>(
    '/admin/pending-users/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const pending = await prisma.pendingUser.findUnique({
        where: { id },
        select: { id: true, email: true, status: true, invitedUserId: true },
      });
      if (!pending) return reply.code(404).send({ error: 'Not found' });

      type StepLog = { step: string; ok: boolean; error?: string };
      const steps: StepLog[] = [];
      const step = (name: string, ok: boolean, error?: string) => {
        steps.push({ step: name, ok, ...(error ? { error } : {}) });
      };

      // PENDING — easy case: just drop the row.
      if (pending.status !== 'invited') {
        await prisma.pendingUser.delete({ where: { id } });
        await recordAudit(actor.sub, 'pending_user.deleted', null, {
          pendingUserId: id,
          email: pending.email,
        });
        step('delete PendingUser row', true);
        return { ok: true, steps };
      }

      // INVITED — clean up Telnyx + the linked User row.
      let didReleased: string | null = null;
      let connectionDeleted: string | null = null;
      let deletedUserId: number | null = null;

      const user = pending.invitedUserId
        ? await prisma.user.findUnique({
            where: { id: pending.invitedUserId },
            select: { id: true, email: true, didNumber: true, sipUsername: true },
          })
        : null;

      if (user) {
        // We use the DID-based lookup pattern (same as the verify endpoint):
        //  - DID → number record → connection_id → connection
        // This avoids Telnyx's broken filter[user_name] (it ignores it and
        // returns all connections), and gives us a connection_id we can
        // confidently delete.
        let connIdFromDid: string | null = null;

        // 1) Un-assign DID → returns it to the unassigned pool (clears both
        //    connection_id + messaging_profile_id).
        if (user.didNumber) {
          const lookup = await telnyx.findNumberByE164(user.didNumber);
          if (!lookup.ok) {
            step(`look up DID ${user.didNumber}`, false, JSON.stringify(lookup.error));
          } else if (!lookup.data) {
            step(`look up DID ${user.didNumber}`, false, 'Number not found (already released?)');
          } else {
            // Capture the connection_id BEFORE we unassign — once we unassign,
            // the number's connection_id will be null and we'd lose the trail
            // to the credential connection.
            connIdFromDid = lookup.data.connection_id ?? null;
            const un = await telnyx.unassignNumber(lookup.data.id);
            if (un.ok) {
              didReleased = user.didNumber;
              step(`un-assign DID ${user.didNumber} (back to inventory)`, true);
            } else {
              step(`un-assign DID ${user.didNumber}`, false, JSON.stringify(un.error));
            }
          }
        } else {
          step('un-assign DID', true, undefined);
        }

        // 2) Delete the Credential Connection. Telnyx requires the DID to be
        //    unassigned first (done in step 1).
        //    Preferred lookup: connection_id from the DID record.
        //    Fallback: paginated scan filtered client-side by user_name
        //    (since /credential_connections does NOT support filter[user_name]).
        let connToDelete: string | null = connIdFromDid;
        if (!connToDelete && user.sipUsername) {
          const MAX_PAGES = 5;
          const PAGE_SIZE = 250;
          for (let pageNum = 1; pageNum <= MAX_PAGES && !connToDelete; pageNum += 1) {
            const qs = new URLSearchParams({
              'page[number]': String(pageNum),
              'page[size]': String(PAGE_SIZE),
            });
            const listRes = await fetch(
              `https://api.telnyx.com/v2/credential_connections?${qs.toString()}`,
              {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${config.telnyxApiKey}`,
                  'Content-Type': 'application/json',
                },
              },
            );
            const listBody = (await listRes.json().catch(() => ({}))) as {
              data?: Array<{ id: string; user_name: string }>;
              meta?: { total_pages?: number };
            };
            const items = listBody.data ?? [];
            const match = items.find((c) => c.user_name === user.sipUsername);
            if (match) {
              connToDelete = match.id;
              step(`find user's Telnyx connection via paginated scan (page ${pageNum})`, true);
              break;
            }
            const totalPages = listBody.meta?.total_pages ?? pageNum;
            if (items.length < PAGE_SIZE || pageNum >= totalPages) break;
          }
        }

        if (connToDelete) {
          const del = await telnyx.deleteCredentialConnection(connToDelete);
          if (del.ok) {
            connectionDeleted = connToDelete;
            step(`delete Credential Connection ${connToDelete}`, true);
          } else {
            step(`delete Credential Connection ${connToDelete}`, false, JSON.stringify(del.error));
          }
        } else if (user.sipUsername) {
          step(`find connection for sipUsername ${user.sipUsername}`, false,
            'No matching connection via DID + paginated scan');
        } else {
          step('delete Credential Connection', true, undefined);
        }

        // 3) Delete the User row. Schema relations like Call/Message/Voicemail
        //    are plain (no cascade) and will block delete with an FK error.
        //    Behaviour:
        //      - Try the hard delete first.
        //      - On FK failure: ANONYMIZE the User in place. v0.9.12 — admin
        //        explicitly asked that deletes free the email for re-invite
        //        and strip every piece of PII while keeping FK-bound history
        //        rows (calls/SMS/voicemails) for audit integrity. The
        //        tombstoned email also frees the unique-constraint slot so
        //        a fresh re-invite creates a brand-new User row instead of
        //        recycling this one.
        //    Either way we still drop the PendingUser row below so admin can
        //    re-import + re-invite cleanly.
        try {
          await prisma.user.delete({ where: { id: user.id } });
          deletedUserId = user.id;
          step(`delete User row #${user.id}`, true);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          step(`delete User row #${user.id}`, false, msg);
          // Anonymize fallback so admin doesn't see a ghost user AND can
          // re-invite the same email later without a unique-constraint hit.
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: {
                email: `deleted-${user.id}@deleted.ace.local`,
                firstName: null,
                lastName: null,
                phoneExtension: null,
                jobDivaUserId: null,
                sipUsername: null,
                sipPassword: null,
                didNumber: null,
                telnyxNumberId: null,
                forwardingEnabled: false,
                forwardingNumber: null,
                forwardingMode: null,
                voicemailGreetingUrl: null,
                voicemailGreetingFilename: null,
                azureOid: null,
                passwordHash: null,
                isActive: false,
                isAdmin: false,
              },
            });
            step(
              `User #${user.id} had history — anonymized (email tombstoned, PII + SIP creds + DID + SSO link cleared; history rows retained)`,
              true,
            );
          } catch (e2) {
            step(`anonymize User #${user.id} (fallback)`, false,
              e2 instanceof Error ? e2.message : String(e2));
          }
        }
      } else if (pending.invitedUserId) {
        step(`look up User #${pending.invitedUserId}`, false, 'Linked User not found (already deleted?)');
      }

      // 4) Always drop the PendingUser row at the end.
      try {
        await prisma.pendingUser.delete({ where: { id } });
        step('delete PendingUser row', true);
      } catch (e) {
        step('delete PendingUser row', false, e instanceof Error ? e.message : String(e));
      }

      await recordAudit(actor.sub, 'pending_user.deleted_invited', deletedUserId, {
        pendingUserId: id,
        email: pending.email,
        deletedUserId,
        didReleased,
        connectionDeleted,
      });

      return {
        ok: true,
        didReleased,
        connectionDeleted,
        deletedUserId,
        steps,
      };
    },
  );

  // ── PATCH /admin/pending-users/:id (v0.9.7) ─────────────────────────────
  // Edit any column on a staging row. For PENDING rows: free edit. For
  // INVITED/ACCEPTED rows: name+email also mirror onto the linked User row,
  // but Pulse credentials (ext, number, password) are frozen — those values
  // were already pushed to Telnyx so changing them in PendingUser would
  // silently drift from reality. Admin must delete + re-invite to change them.
  app.patch<{ Params: { id: string } }>(
    '/admin/pending-users/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = PendingUserPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const target = await prisma.pendingUser.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: 'Not found' });

      const patch = parsed.data;
      const isInvited = target.status === 'invited';

      // Block credential edits on already-invited rows.
      if (isInvited) {
        const blockedFields = ['pulseVoipExt', 'pulseVoipNumber', 'pulseExtPassword'] as const;
        for (const f of blockedFields) {
          if (patch[f] !== undefined && patch[f] !== target[f]) {
            return reply.code(400).send({
              error: "DID and SIP creds can't be edited after invite — delete + re-invite to change them",
              field: f,
            });
          }
        }
      }

      // Email uniqueness: among pending_users AND (for invited) users.
      if (patch.email !== undefined && patch.email.toLowerCase() !== target.email.toLowerCase()) {
        const newEmail = patch.email.toLowerCase();
        const dupPending = await prisma.pendingUser.findFirst({
          where: { email: newEmail, NOT: { id } },
          select: { id: true },
        });
        if (dupPending) {
          return reply.code(409).send({
            error: `Another pending row already uses ${newEmail}`,
          });
        }
        if (isInvited) {
          const dupUser = await prisma.user.findUnique({
            where: { email: newEmail },
            select: { id: true },
          });
          // Allow if the dup is the same linked user (shouldn't happen since
          // we're changing email, but defensive).
          if (dupUser && dupUser.id !== target.invitedUserId) {
            return reply.code(409).send({
              error: `Another user already uses ${newEmail}`,
            });
          }
        }
      }

      // Build the update.
      const data: Record<string, unknown> = {};
      const changes: Record<string, unknown> = {};
      const set = <K extends keyof typeof patch>(k: K) => {
        const next = patch[k];
        if (next === undefined) return;
        const prev = target[k as keyof typeof target] as unknown;
        if (next === prev) return;
        const writeVal = k === 'email' && typeof next === 'string' ? next.toLowerCase() : next;
        data[k] = writeVal;
        changes[k] = { from: prev, to: writeVal };
      };
      set('firstName');
      set('lastName');
      set('email');
      set('pulseVoipExt');
      set('pulseVoipNumber');
      set('pulseExtPassword');
      set('pulseConnectionName');
      set('pulseUserStatus');

      if (Object.keys(data).length === 0) {
        // No-op — return current row so the UI doesn't have to re-fetch.
        return {
          ok: true,
          row: { ...target, pulseExtPassword: undefined, hasPassword: !!target.pulseExtPassword,
            importedAt: target.importedAt.toISOString(),
            invitedAt: target.invitedAt ? target.invitedAt.toISOString() : null },
          mirroredToUser: false,
        };
      }

      const updated = await prisma.pendingUser.update({ where: { id }, data });

      // Mirror name/email onto the linked User row for INVITED.
      let mirroredToUser = false;
      if (isInvited && target.invitedUserId) {
        const userPatch: Record<string, unknown> = {};
        if (data.firstName !== undefined) userPatch.firstName = data.firstName;
        if (data.lastName !== undefined) userPatch.lastName = data.lastName;
        if (data.email !== undefined) userPatch.email = data.email;
        if (Object.keys(userPatch).length > 0) {
          try {
            await prisma.user.update({ where: { id: target.invitedUserId }, data: userPatch });
            mirroredToUser = true;
          } catch (e) {
            // Don't fail the whole patch — log and continue.
            console.warn('[pending.patch] mirror to User failed', { id: target.invitedUserId, e });
          }
        }
      }

      await recordAudit(actor.sub, 'pending_user.updated', target.invitedUserId ?? null, {
        pendingUserId: id,
        email: target.email,
        status: target.status,
        changes,
        mirroredToUser,
      });

      return {
        ok: true,
        row: {
          ...updated,
          pulseExtPassword: undefined,
          hasPassword: !!updated.pulseExtPassword,
          importedAt: updated.importedAt.toISOString(),
          invitedAt: updated.invitedAt ? updated.invitedAt.toISOString() : null,
        },
        mirroredToUser,
      };
    },
  );

  // ── POST /admin/pending-users/:id/verify (v0.9.7) ───────────────────────
  // Re-runs the Telnyx config for an already-invited user. Idempotent. Fixes
  // broken invites (wrong outbound voice profile, missing messaging binding,
  // etc.) without delete+re-invite. Returns the same step-log shape as the
  // invite endpoint so the UI can reuse ResultModal.
  app.post<{ Params: { id: string } }>(
    '/admin/pending-users/:id/verify',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const pending = await prisma.pendingUser.findUnique({ where: { id } });
      if (!pending) return reply.code(404).send({ error: 'Not found' });

      const user = pending.invitedUserId
        ? await prisma.user.findUnique({
            where: { id: pending.invitedUserId },
            select: { id: true, email: true, didNumber: true, sipUsername: true },
          })
        : null;

      if (!user || !user.didNumber || !user.sipUsername) {
        return reply.code(400).send({
          error: 'Must be invited first (no linked User, didNumber, or sipUsername)',
        });
      }

      type StepLog = { step: string; ok: boolean; error?: string };
      const steps: StepLog[] = [];
      const step = (name: string, ok: boolean, error?: string) => {
        steps.push({ step: name, ok, ...(error ? { error } : {}) });
      };

      // 1) Resolve template.
      const tplIdRes = await telnyx.resolveTemplateConnectionId();
      const tplId = tplIdRes.ok ? tplIdRes.data : null;
      if (!tplId) {
        step('resolve template connection id', false,
          tplIdRes.ok
            ? 'No TELNYX_TEMPLATE_CONNECTION_ID/DID configured'
            : JSON.stringify(tplIdRes.error));
        return reply.code(502).send({ error: 'No template configured', steps });
      }
      step(`resolve template connection (${tplId})`, true);

      // 2) Fetch template + find the user's existing connection.
      const tplRes = await telnyx.fetchCredentialConnection(tplId);
      if (!tplRes.ok || !tplRes.data) {
        step('fetch template connection', false, JSON.stringify(tplRes.error));
        return reply.code(502).send({ error: 'Template fetch failed', steps });
      }
      const tpl = tplRes.data.data;
      step('fetch template connection config', true);

      // Normalize DID up-front (used both for connection lookup and re-bind below).
      const userDidDigits = user.didNumber.replace(/[^\d]/g, '');
      const didE164 = user.didNumber.startsWith('+')
        ? user.didNumber
        : userDidDigits.length === 11 && userDidDigits.startsWith('1')
          ? `+${userDidDigits}`
          : userDidDigits.length === 10
            ? `+1${userDidDigits}`
            : `+${userDidDigits}`;

      // Find user's connection. Telnyx /v2/credential_connections does NOT
      // support filter[user_name]; it only supports filter[connection_name].
      // Strategy: look up the DID → read its connection_id → fetch that
      // connection. Fall back to a paginated scan filtered client-side by
      // user_name if the DID can't tell us.
      //
      // Reusable lookup for the cleanup paths below too.
      let userConn: { id: string; user_name?: string } | null = null;
      let preFetchedFullConn: telnyx.FullCredentialConnection | null = null;

      // ── Preferred path: via the DID ──
      const didProbe = await telnyx.findNumberByE164(didE164);
      if (!didProbe.ok) {
        step(`find user's Telnyx connection via DID ${didE164}`, false,
          JSON.stringify(didProbe.error));
      } else if (!didProbe.data) {
        step(`find user's Telnyx connection via DID ${didE164}`, false,
          'DID not in Telnyx account');
      } else if (!didProbe.data.connection_id) {
        step(`find user's Telnyx connection via DID ${didE164}`, false,
          'Number has no connection_id');
      } else {
        const connId = didProbe.data.connection_id;
        const fullRes = await telnyx.fetchCredentialConnection(connId);
        if (!fullRes.ok || !fullRes.data) {
          step(`fetch user's connection ${connId}`, false, JSON.stringify(fullRes.error));
        } else {
          preFetchedFullConn = fullRes.data.data;
          userConn = { id: preFetchedFullConn.id, user_name: preFetchedFullConn.user_name };
          step(`find user's Telnyx connection via DID ${didE164} (${connId})`, true);
          if (preFetchedFullConn.user_name !== user.sipUsername) {
            step(
              `sanity-check: connection.user_name=${preFetchedFullConn.user_name} ≠ sipUsername=${user.sipUsername} (proceeding)`,
              true,
            );
          }
        }
      }

      // ── Fallback: paginated scan of /credential_connections ──
      // Used only if the DID path didn't yield a connection.
      if (!userConn) {
        const MAX_PAGES = 5;
        const PAGE_SIZE = 250;
        for (let pageNum = 1; pageNum <= MAX_PAGES && !userConn; pageNum += 1) {
          const qs = new URLSearchParams({
            'page[number]': String(pageNum),
            'page[size]': String(PAGE_SIZE),
          });
          const listRes = await fetch(
            `https://api.telnyx.com/v2/credential_connections?${qs.toString()}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${config.telnyxApiKey}`,
                'Content-Type': 'application/json',
              },
            },
          );
          const listBody = (await listRes.json().catch(() => ({}))) as {
            data?: Array<{ id: string; user_name: string }>;
            meta?: { total_pages?: number };
          };
          const items = listBody.data ?? [];
          const match = items.find((c) => c.user_name === user.sipUsername);
          if (match) {
            userConn = match;
            step(`find user's Telnyx connection via paginated scan (page ${pageNum}, ${match.id})`, true);
            break;
          }
          const totalPages = listBody.meta?.total_pages ?? pageNum;
          if (items.length < PAGE_SIZE || pageNum >= totalPages) break;
        }
      }

      if (!userConn) {
        step(`find user's Telnyx connection (sipUsername=${user.sipUsername})`, false,
          'No matching connection in DID + paginated scan');
        return reply.code(502).send({
          error: "Couldn't locate user's Telnyx credential connection",
          steps,
        });
      }

      // 3) PATCH the user's connection to mirror EVERY template setting
      // (v0.9.11). Previously this only copied anchorsite + encrypted_media +
      // outbound_voice_profile_id + a couple of channel limits — silently
      // skipping sip_uri_calling_preference, outbound.encrypted_media,
      // outbound.localization, rtcp_settings, dtmf_type, and a dozen others.
      // Use the shared buildTemplateCloneBody helper so verify ↔ invite
      // stay in sync: anything new added to the helper applies to BOTH paths.
      //
      // We pass aniOverride = didE164 so the user's OWN DID is set as the
      // Caller ID Override (instead of inheriting the template's DID).
      const patchBody = telnyx.buildTemplateCloneBody(tpl, { aniOverride: didE164 });

      if (Object.keys(patchBody).length > 0) {
        const patchRes = await telnyx.patchCredentialConnection(userConn.id, patchBody);
        if (patchRes.ok) {
          step('PATCH user connection to match template (full clone — every field)', true);
        } else {
          step('PATCH user connection to match template', false, JSON.stringify(patchRes.error));
        }
      } else {
        step('PATCH user connection — nothing to apply', true);
      }

      // 3.5) Explicit Caller ID Override step (v0.9.11). Even if the
      // template-clone PATCH above already wrote outbound.ani_override,
      // we re-stamp it here so (a) the step log shows it as a distinct
      // success line and (b) we have a fallback if a future change to
      // buildTemplateCloneBody ever drops that field.
      const overrideRes = await telnyx.setConnectionCallerIdOverride(userConn.id, didE164);
      if (overrideRes.ok) {
        step(`set Caller ID Override = ${didE164}`, true);
      } else {
        step(`set Caller ID Override = ${didE164}`, false, JSON.stringify(overrideRes.error));
      }

      // 4) Re-bind DID's connection_id to user's connection.
      // Reuse the lookup from step 2 if it succeeded; otherwise re-probe.
      const numLookup = (didProbe.ok && didProbe.data)
        ? didProbe
        : await telnyx.findNumberByE164(didE164);
      if (!numLookup.ok || !numLookup.data) {
        step(`look up DID ${didE164}`, false,
          numLookup.ok ? 'Not found' : JSON.stringify(numLookup.error));
      } else {
        if (numLookup.data.connection_id !== userConn.id) {
          const assign = await telnyx.assignDidToConnection(numLookup.data.id, userConn.id);
          if (assign.ok) {
            step(`re-bind DID ${didE164} → connection ${userConn.id}`, true);
          } else {
            step(`re-bind DID ${didE164} → connection ${userConn.id}`, false, JSON.stringify(assign.error));
          }
        } else {
          step(`DID ${didE164} already bound to user connection`, true);
        }

        // 5) Re-bind messaging profile.
        if (config.telnyxMessagingProfileId) {
          if (numLookup.data.messaging_profile_id !== config.telnyxMessagingProfileId) {
            const bind = await telnyx.assignNumberMessagingProfile(
              numLookup.data.id,
              config.telnyxMessagingProfileId,
            );
            if (bind.ok) {
              step('bind DID to ACE messaging profile (SMS routing)', true);
            } else {
              step('bind DID to ACE messaging profile', false, JSON.stringify(bind.error));
            }
          } else {
            step('DID already bound to ACE messaging profile', true);
          }
        } else {
          step('bind messaging profile', false,
            'Skipped: TELNYX_MESSAGING_PROFILE_ID env var not set');
        }
      }

      await recordAudit(actor.sub, 'pending_user.verified', user.id, {
        pendingUserId: id,
        email: pending.email,
        userId: user.id,
        connectionId: userConn.id,
        didNumber: didE164,
        templateConnectionId: tplId,
      });

      return {
        ok: true,
        userId: user.id,
        didNumber: didE164,
        sipUsername: user.sipUsername,
        steps,
      };
    },
  );

  // ── GET /admin/pending-users/:id/credentials ────────────────────────────
  // Returns the unredacted SIP credentials for one staged row. Admin-only
  // and audited — every reveal is logged so we can see who looked.
  // The general LIST endpoint strips the password (returns `hasPassword`
  // boolean instead); this endpoint is the only way to recover the raw
  // value, intended for the invite-modal "Reveal credentials" button.
  app.get<{ Params: { id: string } }>(
    '/admin/pending-users/:id/credentials',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const pending = await prisma.pendingUser.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          pulseVoipExt: true,
          pulseVoipNumber: true,
          pulseExtPassword: true,
          pulseConnectionName: true,
        },
      });
      if (!pending) return reply.code(404).send({ error: 'Not found' });

      await recordAudit(actor.sub, 'pending_user.credentials_viewed', null, {
        pendingUserId: id,
        email: pending.email,
      });

      return {
        email: pending.email,
        pulseVoipExt: pending.pulseVoipExt,
        pulseVoipNumber: pending.pulseVoipNumber,
        pulseExtPassword: pending.pulseExtPassword,
        pulseConnectionName: pending.pulseConnectionName,
      };
    },
  );

}
