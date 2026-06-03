// v0.10.59 — Scheduled message worker.
//
// Polls the scheduled_messages table every ~30s for rows due to fire,
// claims them atomically (status: 'pending' → 'sending'), and dispatches
// each through the shared sendMessageImmediate helper. On Telnyx success,
// the row is flipped to 'sent' with sentAt + telnyxMessageId stamped.
// On failure, we bump attempts and either retry next tick or mark
// 'failed' after MAX_ATTEMPTS.
//
// Design notes:
//
// * Single instance assumed. Render hosts the API process; there's only
//   one. If we ever scale horizontally we'd need a leader-election or
//   move this to a separate worker service. The atomic UPDATE...RETURNING
//   pattern below would still prevent double-sending, but multiple
//   processes polling concurrently is wasteful.
//
// * No transaction needed between claim and send. The claim step writes
//   status='sending'. If the API process dies after claim but before send,
//   the row sits in 'sending' indefinitely and a future operator can
//   sweep it back to 'pending'. Acceptable trade-off vs. a long-running
//   transaction holding a row lock across an external HTTP call.
//
// * Poll cadence is intentionally coarse (30s) — users scheduling a
//   message rarely care about sub-minute precision, and we'd rather not
//   thrash the DB. The actual firing precision is therefore "anywhere
//   from on-time to ~30s late", which we document in the UI.
import { prisma } from '@ace/db';
import type { FastifyBaseLogger } from 'fastify';
import { sendMessageImmediate } from './sendMessage.js';

const POLL_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 5;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the periodic poll. Idempotent — calling twice is a no-op.
 * Wired up at API startup in apps/api/src/main.ts.
 */
export function startScheduledMessageWorker(log: FastifyBaseLogger): void {
  if (timer) return;
  log.info('[scheduled-msg] worker starting (poll every %dms)', POLL_INTERVAL_MS);
  // Fire one tick immediately so freshly-due messages don't wait 30s on boot.
  void tick(log).catch((e) => log.error({ err: e }, '[scheduled-msg] boot tick failed'));
  timer = setInterval(() => {
    void tick(log).catch((e) => log.error({ err: e }, '[scheduled-msg] tick failed'));
  }, POLL_INTERVAL_MS);
}

/** Cancel the poll. Currently only used by tests; kept for symmetry. */
export function stopScheduledMessageWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  // Re-entrancy guard. If a previous tick is still draining, skip this one.
  if (running) return;
  running = true;
  try {
    const now = new Date();
    // Pull due rows. We update in batches of up to 20 per tick to keep any
    // single Telnyx outage from stalling unrelated messages too long.
    const due = await prisma.scheduledMessage.findMany({
      where: {
        status: 'pending',
        scheduledFor: { lte: now },
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { scheduledFor: 'asc' },
      take: 20,
      select: {
        id: true,
        userId: true,
        toNumber: true,
        body: true,
        mediaUrls: true,
        userDidId: true,
        attempts: true,
      },
    });

    for (const row of due) {
      // Atomic claim: only proceed if we win the race against another
      // worker tick or an admin manually changing state. updateMany
      // returns count, so we know if we actually grabbed it.
      const claimed = await prisma.scheduledMessage.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'sending' },
      });
      if (claimed.count === 0) continue; // someone else got it (or it was canceled)

      const result = await sendMessageImmediate({
        userId: row.userId,
        toNumber: row.toNumber,
        body: row.body,
        mediaUrls: row.mediaUrls,
        forcedUserDidId: row.userDidId,
      });

      if (result.ok) {
        await prisma.scheduledMessage.update({
          where: { id: row.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            telnyxMessageId: result.message.telnyxMessageId,
            attempts: row.attempts + 1,
            lastError: null,
          },
        });
        log.info({ scheduledId: row.id, telnyxId: result.message.telnyxMessageId }, '[scheduled-msg] sent');
      } else {
        const nextAttempts = row.attempts + 1;
        const giveUp = nextAttempts >= MAX_ATTEMPTS || result.code === 'no_did_assigned';
        // 'no_did_assigned' is terminal — retrying won't conjure a DID,
        // so don't waste cycles. Other errors get retried until MAX_ATTEMPTS.
        await prisma.scheduledMessage.update({
          where: { id: row.id },
          data: {
            status: giveUp ? 'failed' : 'pending',
            attempts: nextAttempts,
            lastError: `${result.code}: ${result.message}`,
          },
        });
        log.warn(
          { scheduledId: row.id, code: result.code, attempts: nextAttempts, giveUp },
          '[scheduled-msg] send failed',
        );
      }
    }

    // Sweep any 'sending' rows older than 5 minutes back to 'pending' —
    // they're stuck (API crashed mid-send) and should retry.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const swept = await prisma.scheduledMessage.updateMany({
      where: { status: 'sending', updatedAt: { lt: fiveMinAgo } },
      data: { status: 'pending' },
    });
    if (swept.count > 0) {
      log.warn({ count: swept.count }, '[scheduled-msg] swept stuck sending rows back to pending');
    }
  } finally {
    running = false;
  }
}
