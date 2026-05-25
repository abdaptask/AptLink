// Phase 8 (#216-220) — Pulse-to-ACE migration UI.
//
// Admin-only Settings tab. Workflow:
//   1. Upload a CSV of Pulse users (one-time per batch). Rows land in the
//      `PendingUser` staging table.
//   2. Table shows pending rows with filter chips (Pending / Invited / All).
//   3. Per-row Invite button opens a modal with 3 toggles:
//        a. DID:    Use existing pulse number  /  Purchase new
//        b. Creds:  Use existing pulse creds   /  Generate new
//        c. Repoint webhook to ACE? (default ON)
//      + a "Send welcome email" checkbox (default ON).
//   4. Clicking Confirm executes the per-user Telnyx + DB + email orchestration
//      via POST /admin/pending-users/:id/invite. The result modal shows the
//      per-step success/error list.
//
// NOTHING on Telnyx changes until the admin clicks Confirm on a specific row.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Upload,
  Mail,
  RefreshCw,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  listPendingUsers,
  importPendingUsers,
  invitePendingUser,
  deletePendingUser,
  getPendingUserCredentials,
  listUnassignedTelnyxNumbers,
  type PendingUser,
  type PendingUserList,
  type PendingUserRow,
  type InvitePendingResult,
  type PendingUserCredentials,
  type UnassignedTelnyxNumber,
} from '../api';

type StatusFilter = 'pending' | 'invited' | 'accepted';

// Derived row status used for both the per-row pill and the client-side
// filter. "Invited" means invited-but-not-yet-logged-in; "Accepted" is
// the same row after the user has signed in at least once.
type DerivedStatus = 'pending' | 'invited' | 'accepted' | 'skipped';

function deriveStatus(row: PendingUser): DerivedStatus {
  if (row.status === 'invited') {
    return row.hasLoggedIn ? 'accepted' : 'invited';
  }
  return row.status;
}

// One-letter abbreviations used in the chip + row pill.
const STATUS_LETTER: Record<DerivedStatus, string> = {
  pending: 'P',
  invited: 'I',
  accepted: 'A',
  skipped: 'S',
};

export default function PendingUsersSection() {
  const token = sessionStorage.getItem('ace_token');
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [data, setData] = useState<PendingUserList | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<PendingUser | null>(null);
  const [resultOf, setResultOf] = useState<InvitePendingResult | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const d = await listPendingUsers(token, filter);
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [token, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!token) {
    return <p className="settings-empty">Sign in to view this section.</p>;
  }

  const counts = data?.counts ?? {
    pending: 0,
    invited: 0,
    skipped: 0,
    accepted: 0,
  };

  // Client-side filter: when the server returns all invited rows (because
  // we asked for status='accepted' or 'invited'), narrow down to the
  // derived bucket the user actually picked.
  const visibleItems = (data?.items ?? []).filter((r) => {
    const d = deriveStatus(r);
    return d === filter;
  });

  return (
    <div className="settings-section pending-users-section">
      <header className="settings-section-header">
        <div>
          <h2>Pending Users</h2>
          <p className="settings-section-blurb">
            Stage Pulse users from a CSV, then invite them to ACE Dialer one at a time.
            Nothing on Telnyx changes until you click <strong>Confirm</strong> on a specific row.
          </p>
        </div>
        <div className="settings-section-actions">
          <button
            type="button"
            className="settings-btn"
            onClick={() => setUploadOpen(true)}
            title="Upload CSV of Pulse users"
          >
            <Upload size={14} /> Upload CSV
          </button>
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={() => void refresh()}
            disabled={loading}
            title="Reload list"
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {/* Legend explaining the one-letter status chips below */}
      <div className="pending-filter-legend">
        <span><strong>P</strong> Pending</span>
        <span className="sep">·</span>
        <span><strong>I</strong> Invited (no login yet)</span>
        <span className="sep">·</span>
        <span><strong>A</strong> Accepted (signed in)</span>
      </div>

      {/* Filter chips — one letter + count each */}
      <div className="pending-filter-row">
        {(['pending', 'invited', 'accepted'] as StatusFilter[]).map((s) => {
          const count = counts[s] ?? 0;
          return (
            <button
              key={s}
              type="button"
              className={`pending-filter-chip pending-filter-chip-letter ${filter === s ? 'active' : ''}`}
              onClick={() => setFilter(s)}
              title={s[0].toUpperCase() + s.slice(1)}
            >
              <strong>{STATUS_LETTER[s]}</strong>
              <span className="pending-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {err && (
        <div className="pending-error">
          <AlertCircle size={14} /> {err}
        </div>
      )}

      {loading && !data && (
        <div className="pending-loading">
          <Loader2 size={20} className="spin" /> Loading…
        </div>
      )}

      {data && visibleItems.length === 0 && !loading && (
        <div className="pending-empty">
          {filter === 'pending'
            ? 'No pending users. Upload a CSV to stage Pulse users for migration.'
            : filter === 'invited'
              ? 'No invited users waiting. Either everyone has signed in (check A) or no one has been invited yet.'
              : 'No users have signed in yet. Invited users will move here after their first login.'}
        </div>
      )}

      {data && visibleItems.length > 0 && (
        <div className="pending-table-wrap">
          <table className="pending-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Pulse ext</th>
                <th>Pulse DID</th>
                <th>Connection</th>
                <th>Status</th>
                <th>Imported</th>
                <th className="ta-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((u) => (
                <PendingRow
                  key={u.id}
                  row={u}
                  onInvite={() => setInviteTarget(u)}
                  onDelete={async () => {
                    if (!confirm(`Delete ${u.email} from staging? (does NOT touch any User row)`)) return;
                    try {
                      await deletePendingUser(token, u.id);
                      await refresh();
                    } catch (e) {
                      alert(e instanceof Error ? e.message : 'Delete failed');
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploadOpen && (
        <CsvUploadModal
          onClose={() => setUploadOpen(false)}
          onImported={async () => {
            setUploadOpen(false);
            await refresh();
          }}
        />
      )}

      {inviteTarget && (
        <InviteModal
          target={inviteTarget}
          onClose={() => setInviteTarget(null)}
          onResult={(r) => {
            setInviteTarget(null);
            setResultOf(r);
            void refresh();
          }}
        />
      )}

      {resultOf && (
        <ResultModal result={resultOf} onClose={() => setResultOf(null)} />
      )}
    </div>
  );
}

// ────────────────────────────── Row ──────────────────────────────

function PendingRow({
  row,
  onInvite,
  onDelete,
}: {
  row: PendingUser;
  onInvite: () => void;
  onDelete: () => void;
}) {
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ') || '—';
  const formattedDid = formatPhone(row.pulseVoipNumber);
  const formattedImported = new Date(row.importedAt).toLocaleString();
  const d = deriveStatus(row);
  const fullStatusLabel =
    d === 'pending'
      ? 'Pending'
      : d === 'invited'
        ? 'Invited (no login yet)'
        : d === 'accepted'
          ? 'Accepted (signed in)'
          : 'Skipped';
  return (
    <tr className={`pending-row pending-${d}`}>
      <td className="pending-name">{name}</td>
      <td>{row.email}</td>
      <td className="pending-mono">{row.pulseVoipExt}</td>
      <td className="pending-mono">{formattedDid}</td>
      <td className="pending-mono">{row.pulseConnectionName ?? '—'}</td>
      <td>
        <span
          className={`pending-status-pill pending-status-pill-letter pending-${d}`}
          title={fullStatusLabel}
        >
          {STATUS_LETTER[d]}
        </span>
      </td>
      <td className="pending-imported">{formattedImported}</td>
      <td className="ta-right">
        {d === 'pending' ? (
          <>
            <button
              type="button"
              className="pending-action-primary"
              onClick={onInvite}
              title="Open the invite modal for this user"
            >
              Invite
            </button>
            <button
              type="button"
              className="pending-action-icon"
              onClick={onDelete}
              title="Remove from staging (does not touch User row)"
            >
              <Trash2 size={14} />
            </button>
          </>
        ) : d === 'invited' ? (
          <span className="pending-invited-note">
            User #{row.invitedUserId ?? '?'} ·{' '}
            {row.invitedAt ? new Date(row.invitedAt).toLocaleDateString() : ''}
          </span>
        ) : d === 'accepted' ? (
          <span className="pending-invited-note">
            Signed in · User #{row.invitedUserId ?? '?'}
          </span>
        ) : (
          <span className="pending-invited-note">{d}</span>
        )}
      </td>
    </tr>
  );
}

// ─────────────────────────── CSV Upload Modal ───────────────────────────

function CsvUploadModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const token = sessionStorage.getItem('ace_token')!;
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<PendingUserRow[] | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{
    inserted: number;
    updated: number;
    errors: Array<{ row: number; email: string; error: string }>;
  } | null>(null);

  function onFile(file: File) {
    setParseErr(null);
    setParsed(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const t = String(reader.result ?? '');
      setText(t);
      parseAndPreview(t);
    };
    reader.readAsText(file);
  }

  function parseAndPreview(rawText: string) {
    setParsing(true);
    try {
      const rows = parsePulseCsv(rawText);
      if (rows.length === 0) throw new Error('No data rows found in CSV');
      setParsed(rows);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : 'Parse failed');
    } finally {
      setParsing(false);
    }
  }

  async function commit() {
    if (!parsed) return;
    setCommitting(true);
    try {
      const r = await importPendingUsers(token, parsed);
      setResult({ inserted: r.inserted, updated: r.updated, errors: r.errors });
      if (r.errors.length === 0) {
        // success — auto-close after a beat
        setTimeout(() => { void onImported(); }, 1500);
      }
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pending-upload-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Upload Pulse Users CSV</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <p className="pending-upload-instructions">
            Expected columns (header row, snake_case as exported from Pulse):
            <code>first_name, last_name, email, voip_ext, voip_number, ext_password, connection_name, user_status</code>
          </p>

          <div className="pending-upload-fileinput">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
          </div>

          {text && !parsed && !parseErr && parsing && (
            <div className="pending-loading">
              <Loader2 size={16} className="spin" /> Parsing…
            </div>
          )}

          {parseErr && (
            <div className="pending-error">
              <AlertCircle size={14} /> {parseErr}
            </div>
          )}

          {parsed && !result && (
            <>
              <div className="pending-preview-summary">
                Parsed <strong>{parsed.length}</strong> rows. Preview first 5:
              </div>
              <div className="pending-table-wrap pending-preview-table">
                <table className="pending-table pending-preview-grid">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>voip_ext</th>
                      <th>voip_number</th>
                      <th>password</th>
                      <th>connection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        <td>{[r.firstName, r.lastName].filter(Boolean).join(' ') || '—'}</td>
                        <td>{r.email}</td>
                        <td className="pending-mono">{r.pulseVoipExt}</td>
                        <td className="pending-mono">{formatPhone(r.pulseVoipNumber)}</td>
                        <td className="pending-mono pending-secret">{r.pulseExtPassword}</td>
                        <td className="pending-mono">{r.pulseConnectionName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="pending-preview-note">
                You're previewing what's in the CSV before anything is saved.
                Passwords shown here come straight from your file; click <strong>Commit import</strong> to stage them.
              </p>
            </>
          )}

          {result && (
            <div className={`pending-result-box ${result.errors.length === 0 ? 'ok' : 'warn'}`}>
              <strong>Import complete:</strong> {result.inserted} inserted, {result.updated} updated
              {result.errors.length > 0 && (
                <>
                  , <strong>{result.errors.length} errors:</strong>
                  <ul>
                    {result.errors.map((e, i) => (
                      <li key={i}>
                        Row {e.row} ({e.email}): {e.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="settings-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="settings-btn"
            disabled={!parsed || committing || !!result}
            onClick={() => void commit()}
          >
            {committing ? (
              <>
                <Loader2 size={14} className="spin" /> Importing…
              </>
            ) : (
              <>
                <Upload size={14} /> Import {parsed?.length ?? 0} rows
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────── Invite Modal ───────────────────────────

function InviteModal({
  target,
  onClose,
  onResult,
}: {
  target: PendingUser;
  onClose: () => void;
  onResult: (r: InvitePendingResult) => void;
}) {
  const token = sessionStorage.getItem('ace_token')!;
  const [didMode, setDidMode] = useState<'existing' | 'new' | 'unassigned'>('existing');
  const [credsMode, setCredsMode] = useState<'existing' | 'new'>('existing');
  const [repointWebhook, setRepointWebhook] = useState(true);
  const [sendEmail, setSendEmail] = useState(true);
  const [newDidAreaCode, setNewDidAreaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Unassigned ACE numbers picker — lazy-loaded when the admin picks the
  // 'unassigned' radio. Saves a Telnyx round-trip for admins who never use it.
  const [unassigned, setUnassigned] = useState<UnassignedTelnyxNumber[] | null>(null);
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  const [unassignedErr, setUnassignedErr] = useState<string | null>(null);
  const [pickedUnassignedDid, setPickedUnassignedDid] = useState<string>('');

  // Fetch the list the first time the admin selects this option.
  useEffect(() => {
    if (didMode !== 'unassigned' || unassigned !== null || unassignedLoading) return;
    setUnassignedLoading(true);
    setUnassignedErr(null);
    listUnassignedTelnyxNumbers(token)
      .then((items) => {
        setUnassigned(items);
        if (items.length > 0) setPickedUnassignedDid(items[0].phoneNumber);
      })
      .catch((e) => setUnassignedErr(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setUnassignedLoading(false));
  }, [didMode, unassigned, unassignedLoading, token]);

  // Reveal SIP credentials: the LIST endpoint strips the password, so we
  // fetch it on-demand from /admin/pending-users/:id/credentials (audited
  // on the server side — every reveal is logged).
  const [creds, setCreds] = useState<PendingUserCredentials | null>(null);
  const [credsLoading, setCredsLoading] = useState(false);
  const [credsErr, setCredsErr] = useState<string | null>(null);

  async function revealCreds() {
    if (creds) { setCreds(null); return; }      // click again to hide
    setCredsLoading(true);
    setCredsErr(null);
    try {
      const c = await getPendingUserCredentials(token, target.id);
      setCreds(c);
    } catch (e) {
      setCredsErr(e instanceof Error ? e.message : 'Failed to load credentials');
    } finally {
      setCredsLoading(false);
    }
  }

  const defaultAreaCode = useMemo(
    () => extractUsAreaCode(target.pulseVoipNumber) ?? '',
    [target.pulseVoipNumber],
  );

  async function confirm() {
    // Refuse to submit if 'unassigned' was picked but no number selected.
    if (didMode === 'unassigned' && !pickedUnassignedDid) {
      onResult({ ok: false, error: 'Pick an unassigned number from the dropdown first.' });
      return;
    }
    setSubmitting(true);
    try {
      const r = await invitePendingUser(token, target.id, {
        didMode,
        credsMode,
        repointWebhook,
        sendEmail,
        newDidAreaCode: didMode === 'new' && newDidAreaCode ? newDidAreaCode : undefined,
        unassignedDidNumber: didMode === 'unassigned' ? pickedUnassignedDid : undefined,
      });
      onResult(r);
    } catch (e) {
      onResult({
        ok: false,
        error: e instanceof Error ? e.message : 'Invite failed',
      });
    } finally {
      setSubmitting(false);
    }
  }

  const name = [target.firstName, target.lastName].filter(Boolean).join(' ') || target.email;

  return (
    <div className="modal-backdrop" onClick={submitting ? undefined : onClose}>
      <div
        className="modal pending-invite-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>Invite {name}</h3>
          <button type="button" className="modal-close" onClick={onClose} disabled={submitting} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <p className="pending-invite-summary">
            <span>Email: <strong>{target.email}</strong></span><br />
            <span>Pulse number: <strong>{formatPhone(target.pulseVoipNumber)}</strong></span><br />
            <span>Pulse ext: <strong className="pending-mono">{target.pulseVoipExt}</strong></span><br />
            <span>Pulse connection: <strong className="pending-mono">{target.pulseConnectionName ?? '—'}</strong></span>
          </p>

          {/* Reveal full credentials (audited). Hides again on click. */}
          <div className="pending-reveal-row">
            <button
              type="button"
              className="pending-reveal-btn"
              onClick={() => void revealCreds()}
              disabled={credsLoading || submitting}
              title={creds ? 'Hide credentials' : 'Show the SIP credentials (audit-logged)'}
            >
              {credsLoading
                ? <><Loader2 size={14} className="spin" /> Loading…</>
                : creds
                  ? <><EyeOff size={14} /> Hide credentials</>
                  : <><Eye size={14} /> Reveal credentials</>}
            </button>
            {credsErr && (
              <span className="pending-reveal-err">
                <AlertCircle size={12} /> {credsErr}
              </span>
            )}
          </div>
          {creds && (
            <div className="pending-reveal-box">
              <div><span>Email</span><strong>{creds.email}</strong></div>
              <div><span>Pulse ext</span><strong className="pending-mono">{creds.pulseVoipExt}</strong></div>
              <div><span>Pulse DID</span><strong className="pending-mono">{formatPhone(creds.pulseVoipNumber)}</strong></div>
              <div><span>SIP password</span><strong className="pending-mono pending-secret">{creds.pulseExtPassword}</strong></div>
              <div><span>Connection</span><strong className="pending-mono">{creds.pulseConnectionName ?? '—'}</strong></div>
            </div>
          )}

          <hr className="pending-divider" />

          {/* ── Q1: DID ── */}
          <fieldset className="pending-toggle-group">
            <legend>1. Phone number</legend>
            <label className="pending-toggle">
              <input
                type="radio"
                name="didMode"
                checked={didMode === 'existing'}
                onChange={() => setDidMode('existing')}
              />
              <span>
                <strong>Use existing Pulse number</strong> — {formatPhone(target.pulseVoipNumber)}
                <span className="pending-toggle-help">No new Telnyx number bought — user keeps their current phone number.</span>
              </span>
            </label>
            <label className="pending-toggle">
              <input
                type="radio"
                name="didMode"
                checked={didMode === 'new'}
                onChange={() => setDidMode('new')}
              />
              <span>
                <strong>Purchase a new DID</strong>
                <span className="pending-toggle-help">
                  Telnyx buys a new local US number (~$0.45 upfront + $0.45/mo). User gets a fresh phone number.
                </span>
              </span>
            </label>
            {didMode === 'new' && (
              <div className="pending-toggle-extra">
                <label>
                  Area code:{' '}
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{3}"
                    maxLength={3}
                    value={newDidAreaCode}
                    onChange={(e) => setNewDidAreaCode(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                    placeholder={defaultAreaCode || '732'}
                    className="pending-areacode-input"
                  />
                </label>
                <span className="pending-toggle-help">
                  Defaults to <strong>{defaultAreaCode || '732'}</strong> (matched to current Pulse number).
                </span>
              </div>
            )}

            {/* Third option: reuse an ACE-owned number that isn't currently
                routed anywhere. Loads the list lazily when picked. */}
            <label className="pending-toggle">
              <input
                type="radio"
                name="didMode"
                checked={didMode === 'unassigned'}
                onChange={() => setDidMode('unassigned')}
              />
              <span>
                <strong>Use an ACE number you already own</strong>
                <span className="pending-toggle-help">
                  Pick from numbers already in your Telnyx account that aren't routed to any voice or messaging connection. $0 — no new purchase.
                </span>
              </span>
            </label>
            {didMode === 'unassigned' && (
              <div className="pending-toggle-extra">
                {unassignedLoading && (
                  <span className="pending-toggle-help">
                    <Loader2 size={12} className="spin" /> Loading unassigned numbers…
                  </span>
                )}
                {unassignedErr && (
                  <span className="pending-reveal-err">
                    <AlertCircle size={12} /> {unassignedErr}
                  </span>
                )}
                {unassigned && unassigned.length === 0 && !unassignedLoading && (
                  <span className="pending-toggle-help">
                    No unassigned numbers found in your Telnyx account. Pick a different option.
                  </span>
                )}
                {unassigned && unassigned.length > 0 && (
                  <label>
                    Pick a number:{' '}
                    <select
                      value={pickedUnassignedDid}
                      onChange={(e) => setPickedUnassignedDid(e.target.value)}
                      className="pending-unassigned-select"
                    >
                      {unassigned.map((n) => (
                        <option key={n.id} value={n.phoneNumber}>
                          {formatPhone(n.phoneNumber)}
                          {n.regionLabel ? ` — ${n.regionLabel}` : ''}
                          {n.areaCode ? ` (${n.areaCode})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {unassigned && unassigned.length > 0 && (
                  <span className="pending-toggle-help">
                    {unassigned.length} number{unassigned.length === 1 ? '' : 's'} available. Will be routed to the user's connection on Confirm.
                  </span>
                )}
              </div>
            )}
          </fieldset>

          {/* ── Q2: SIP Credentials ── */}
          <fieldset className="pending-toggle-group">
            <legend>2. SIP Credentials</legend>
            <label className="pending-toggle">
              <input
                type="radio"
                name="credsMode"
                checked={credsMode === 'existing'}
                onChange={() => setCredsMode('existing')}
              />
              <span>
                <strong>Reuse Pulse credentials</strong> ({target.pulseVoipExt})
                <span className="pending-toggle-help">
                  No Telnyx API call. <strong>User must uninstall the old dialer</strong> or both apps
                  will ring on every inbound call.
                </span>
              </span>
            </label>
            <label className="pending-toggle">
              <input
                type="radio"
                name="credsMode"
                checked={credsMode === 'new'}
                onChange={() => setCredsMode('new')}
              />
              <span>
                <strong>Generate new ACE credentials</strong>
                <span className="pending-toggle-help">
                  Telnyx creates a fresh Credential Connection. Pulse credentials stay untouched
                  (user can keep Pulse running until ready to switch).
                </span>
              </span>
            </label>
          </fieldset>

          {/* ── Q3: Repoint webhook ── */}
          <fieldset className="pending-toggle-group">
            <legend>3. Telnyx webhook</legend>
            <label className="pending-checkbox">
              <input
                type="checkbox"
                checked={repointWebhook}
                onChange={(e) => setRepointWebhook(e.target.checked)}
              />
              <span>
                <strong>Repoint webhook to ACE</strong>
                <span className="pending-toggle-help">
                  {credsMode === 'new'
                    ? 'Always on for new credentials (the new connection points at ACE by default).'
                    : 'PATCH the user\'s Pulse Credential Connection so call events flow to ACE\'s database instead of Pulse.'}
                </span>
              </span>
            </label>
          </fieldset>

          {/* ── Send email ── */}
          <fieldset className="pending-toggle-group">
            <legend>4. Welcome email</legend>
            <label className="pending-checkbox">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
              />
              <span>
                <strong>Send welcome email to {target.email}</strong>
                <span className="pending-toggle-help">
                  Heads-up email with sign-in instructions and the "uninstall old dialer first" warning.
                  Uncheck if you'll notify the user via Teams instead.
                </span>
              </span>
            </label>
          </fieldset>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-btn pending-confirm-btn"
            onClick={() => void confirm()}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="spin" /> Provisioning…
              </>
            ) : sendEmail ? (
              <>
                <Mail size={14} /> Confirm & Invite
              </>
            ) : (
              <>
                <CheckCircle2 size={14} /> Confirm (no email)
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────── Result Modal ───────────────────────────

function ResultModal({ result, onClose }: { result: InvitePendingResult; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pending-result-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>
            {result.ok ? (
              <>
                <CheckCircle2 size={20} className="pending-icon-ok" /> Invite complete
              </>
            ) : (
              <>
                <XCircle size={20} className="pending-icon-err" /> Invite failed
              </>
            )}
          </h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          {result.ok && (
            <div className="pending-result-summary">
              <p>
                User <strong>#{result.userId}</strong> provisioned.
              </p>
              <ul className="pending-result-bullets">
                {result.didNumber && (
                  <li>
                    DID: <strong>{formatPhone(result.didNumber)}</strong>
                    {result.didPurchased
                      ? ' (newly purchased from Telnyx)'
                      : ' (routed to user)'}
                  </li>
                )}
                {result.sipUsername && (
                  <li>
                    SIP username: <strong className="pending-mono">{result.sipUsername}</strong>
                    {result.credsCreated ? ' (newly generated)' : ' (kept from Pulse)'}
                  </li>
                )}
                {result.webhookRepointed && <li>Webhook repointed to ACE ✓</li>}
                {result.emailSent && <li>Welcome email sent ✓</li>}
              </ul>
            </div>
          )}
          {result.error && (
            <div className="pending-error">
              <AlertCircle size={14} /> {result.error}
            </div>
          )}
          {result.steps && result.steps.length > 0 && (
            <>
              <h4 className="pending-steps-heading">Steps</h4>
              <ul className="pending-steps-list">
                {result.steps.map((s, i) => (
                  <li key={i} className={s.ok ? 'ok' : 'err'}>
                    {s.ok ? (
                      <CheckCircle2 size={14} className="pending-icon-ok" />
                    ) : (
                      <XCircle size={14} className="pending-icon-err" />
                    )}
                    <span>{s.step}</span>
                    {s.error && <span className="pending-step-error">{s.error}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="settings-btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────── Helpers ───────────────────────────

/**
 * Parse a Pulse-exported CSV into PendingUserRow objects. Expects the
 * snake_case headers Pulse exports. Tolerates BOM, quoted cells with commas,
 * and trailing blank lines.
 */
function parsePulseCsv(text: string): PendingUserRow[] {
  // Strip BOM if present (Excel exports often have one)
  const cleaned = text.replace(/^﻿/, '');
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV needs at least a header row and 1 data row');

  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine).map((h) => h.trim().toLowerCase());

  const required = ['first_name', 'last_name', 'email', 'voip_ext', 'voip_number', 'ext_password'];
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length > 0) {
    throw new Error(
      `CSV missing required column(s): ${missing.join(', ')}. ` +
        `Expected headers: ${required.concat(['connection_name', 'user_status']).join(', ')}`,
    );
  }

  const idx = (name: string) => headers.indexOf(name);
  const rows: PendingUserRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const email = cells[idx('email')]?.trim() ?? '';
    const voipExt = cells[idx('voip_ext')]?.trim() ?? '';
    const voipNumber = cells[idx('voip_number')]?.trim() ?? '';
    const extPassword = cells[idx('ext_password')]?.trim() ?? '';
    if (!email || !voipExt || !voipNumber || !extPassword) {
      // Skip rows that are missing essentials; could surface a warning later.
      continue;
    }
    rows.push({
      email,
      firstName: cells[idx('first_name')]?.trim() || null,
      lastName: cells[idx('last_name')]?.trim() || null,
      pulseVoipExt: voipExt,
      pulseVoipNumber: voipNumber,
      pulseExtPassword: extPassword,
      pulseConnectionName: idx('connection_name') >= 0 ? cells[idx('connection_name')]?.trim() || null : null,
      pulseUserStatus: idx('user_status') >= 0 ? cells[idx('user_status')]?.trim() || null : null,
    });
  }
  return rows;
}

/**
 * Minimal CSV line splitter — handles quoted cells, "" escape for embedded
 * quotes, and trailing empty cells. Good enough for Excel/Sheets exports.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '—';
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function extractUsAreaCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}
