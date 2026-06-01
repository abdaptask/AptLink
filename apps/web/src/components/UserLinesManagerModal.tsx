// v0.10.0 Task 27 — Admin modal for managing a single user's DIDs.
//
// Launched from the Users tab dropdown menu ("Manage lines"). Shows
// the user's current DIDs in a list with per-row actions (edit label/
// color, mark default, remove) and an "Add line" button that opens a
// sub-modal with two modes:
//
//   Mode A — pick from unassigned Telnyx inventory (free; just routes
//     an existing number to this user's connection).
//   Mode B — purchase a brand new DID by area code (BILLABLE).
//
// The user explicitly asked for the choice between "existing" and
// "buy new" rather than defaulting either way, so the add-modal opens
// on a mode-picker screen and the admin selects which path before
// seeing the actual form.

import { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, Pencil, Check, ShoppingCart, ListChecks, Star, AlertCircle, ArrowRightLeft } from 'lucide-react';
import {
  getAdminUserDids,
  addUserDid,
  patchUserDid,
  removeUserDid,
  listUnassignedTelnyxNumbers,
  // v0.10.20 — Migrate Existing User to New Dialer flow.
  listMigrationCandidates,
  migrateDidToUser,
  // v0.10.21 — "What to do with the old SIP connection?" cleanup.
  cleanupTelnyxConnection,
  type AdminUserDidRow,
  type UnassignedTelnyxNumber,
  type MigrationCandidate,
} from '../api';
import { formatPhone } from '../lib/phone';

interface Props {
  userId: number;
  userLabel: string;     // for the title bar ("Manage lines for Nilesh Darekar")
  onClose: () => void;
}

// Predefined color palette so labels look consistent across users.
// Six distinct hues chosen for good visual separation on both dark + light.
const COLOR_PALETTE = [
  '#3b82f6', // blue
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // purple
  '#ef4444', // red
  '#eab308', // yellow
];

export default function UserLinesManagerModal({ userId, userLabel, onClose }: Props) {
  const [rows, setRows] = useState<AdminUserDidRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // v0.10.8 — inline label editor. Was using window.prompt() which
  // Electron silently disables (no dialog appears, returns null). Now
  // the pencil button toggles an <input> in place of the label text.
  // Enter saves, Escape cancels, blur saves (matches what users expect
  // from native inline-edit patterns like Finder / File Explorer).
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState<string>('');
  // CLAUDE.md UI rule #2 — modal-body scrolls to top on open.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  function load() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getAdminUserDids(token, userId)
      .then(setRows)
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    load();
    // CLAUDE.md UI rule #2 — reset modal body scroll on open. Fires
    // both immediately and on a microtask follow-up so React's
    // render → layout ordering doesn't leave the body half-scrolled.
    const reset = () => bodyRef.current?.scrollTo({ top: 0 });
    reset();
    queueMicrotask(reset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // CLAUDE.md UI rule #1 — close on Escape key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showAdd) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, showAdd]);

  async function handleSetDefault(row: AdminUserDidRow) {
    if (row.isDefault) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusyId(row.id);
    const res = await patchUserDid(token, userId, row.id, { isDefault: true });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error ?? 'Failed to set default');
      return;
    }
    load();
  }

  function handleEditLabel(row: AdminUserDidRow) {
    // v0.10.8 — open the inline editor. The actual save happens in
    // commitLabelEdit when the user hits Enter / blurs the input.
    setEditingLabelId(row.id);
    setEditingLabelValue(row.label);
  }

  async function commitLabelEdit(row: AdminUserDidRow) {
    const trimmed = editingLabelValue.trim();
    setEditingLabelId(null);
    if (!trimmed || trimmed === row.label) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusyId(row.id);
    const res = await patchUserDid(token, userId, row.id, { label: trimmed });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error ?? 'Failed to update label');
      return;
    }
    load();
  }

  async function handleSetColor(row: AdminUserDidRow, color: string) {
    if (color === row.colorHex) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusyId(row.id);
    const res = await patchUserDid(token, userId, row.id, { colorHex: color });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error ?? 'Failed to update color');
      return;
    }
    setEditingId(null);
    load();
  }

  async function handleRemove(row: AdminUserDidRow) {
    const ok = window.confirm(
      `Remove ${formatPhone(row.didNumber)} (${row.label}) from this user?\n\n` +
      `The number will return to Telnyx's unassigned pool — you can re-use it ` +
      `on another user later. This user's call/SMS history is preserved (just ` +
      `loses the line tag on those historical rows).`,
    );
    if (!ok) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusyId(row.id);
    const res = await removeUserDid(token, userId, row.id);
    setBusyId(null);
    if (!res.ok) {
      setError(res.error ?? 'Failed to remove');
      return;
    }
    load();
  }

  return (
    <div
      className={`compose-modal${showAdd ? ' compose-modal-dimmed' : ''}`}
      onClick={onClose}
    >
      <div
        className="lines-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="lines-modal-title"
        aria-modal="true"
      >
        <header className="modal-header">
          <h3 id="lines-modal-title">Manage lines for {userLabel}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="modal-body lines-modal-body" ref={bodyRef}>
          {error && (
            <div className="pending-error" role="alert">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {loading ? (
            <p className="muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="muted">
              This user has no lines yet. Click "Add line" below to assign one.
            </p>
          ) : (
            <ul className="lines-list">
              {rows.map((row) => {
                const isEditingColor = editingId === row.id;
                const isBusy = busyId === row.id;
                return (
                  <li key={row.id} className="lines-row">
                    <button
                      type="button"
                      className="lines-row-swatch"
                      style={{ background: row.colorHex }}
                      title="Click to change color"
                      onClick={() => setEditingId(isEditingColor ? null : row.id)}
                      disabled={isBusy}
                    />
                    <div className="lines-row-text">
                      <div className="lines-row-label">
                        {editingLabelId === row.id ? (
                          <input
                            type="text"
                            className="lines-row-label-input"
                            value={editingLabelValue}
                            autoFocus
                            onChange={(e) => setEditingLabelValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void commitLabelEdit(row);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingLabelId(null);
                              }
                            }}
                            onBlur={() => void commitLabelEdit(row)}
                            disabled={isBusy}
                            maxLength={32}
                            aria-label="Line label"
                          />
                        ) : (
                          <>
                            {row.label}
                            {row.isDefault && (
                              <span className="lines-row-default-pill" title="Default outbound line">
                                Default
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      <div className="lines-row-number">{formatPhone(row.didNumber)}</div>
                    </div>
                    <div className="lines-row-actions">
                      {!row.isDefault && (
                        <button
                          type="button"
                          className="settings-btn-secondary lines-action"
                          onClick={() => handleSetDefault(row)}
                          disabled={isBusy}
                          title="Set as default outbound line"
                        >
                          <Star size={14} /> Default
                        </button>
                      )}
                      <button
                        type="button"
                        className="settings-btn-secondary lines-action"
                        onClick={() => handleEditLabel(row)}
                        disabled={isBusy}
                        title="Edit label"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="settings-btn-secondary lines-action lines-action-remove"
                        onClick={() => handleRemove(row)}
                        disabled={isBusy || rows.length <= 1}
                        title={
                          rows.length <= 1
                            ? "Can't remove the user's only line"
                            : 'Remove this line'
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {isEditingColor && (
                      <div className="lines-row-color-palette">
                        {COLOR_PALETTE.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`lines-color-swatch${c === row.colorHex ? ' active' : ''}`}
                            style={{ background: c }}
                            onClick={() => handleSetColor(row, c)}
                            disabled={isBusy}
                            aria-label={`Set color to ${c}`}
                          >
                            {c === row.colorHex && <Check size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setShowAdd(true)}
          >
            <Plus size={14} /> Add line
          </button>
        </footer>
      </div>

      {showAdd && (
        <AddLineSubModal
          userId={userId}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Add Line sub-modal — mode picker → form ────────────────────────────

interface AddLineProps {
  userId: number;
  onClose: () => void;
  onAdded: () => void;
}

function AddLineSubModal({ userId, onClose, onAdded }: AddLineProps) {
  // The first thing the admin sees is the mode picker (per user request:
  // "ask if I want to add it from an existing number or buy a new number").
  // Once they pick, we show the matching form.
  // v0.10.17 — added 'migrate' mode for taking over a Pulse-side DID.
  // 'unassigned' (renamed in UI to "Add an available number from Telnyx")
  // still picks from unassigned DIDs; 'migrate' picks from DIDs that ARE
  // currently bound to another connection (Pulse) and re-binds them to
  // this ACE user's connection without losing the phone number.
  const [mode, setMode] = useState<'pick' | 'unassigned' | 'purchase' | 'migrate' | 'cleanup'>('pick');
  // v0.10.21 — After a successful migration, we land on the 'cleanup' step
  // and offer to deactivate/delete the OLD SIP connection that previously
  // served this number on Pulse. Captures the data we need to show + cleanup.
  const [postMigrate, setPostMigrate] = useState<{
    didNumber: string;
    previousConnectionId: string;
    previousConnectionName: string | null;
    previousSipUser: string | null;
  } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<'deactivate' | 'delete' | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedTelnyxNumber[]>([]);
  const [loadingUnassigned, setLoadingUnassigned] = useState(false);
  // v0.10.20 — Migration candidate list (Telnyx DIDs currently bound to
  // another connection, not yet in ACE). Lazy-loaded when mode === 'migrate'.
  const [migrationCandidates, setMigrationCandidates] = useState<MigrationCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [pickedMigrationDid, setPickedMigrationDid] = useState<string>('');
  // v0.10.20 — Search/filter for the migrate picker. Pulse customers may
  // have hundreds of DIDs across many connections, so a typeahead filter
  // is essential. We match against phone digits, connection name, AND
  // SIP username so the admin can find by either identifier.
  const [migrationSearch, setMigrationSearch] = useState<string>('');

  // Form state (shared between modes — only some fields apply per mode).
  const [pickedNumber, setPickedNumber] = useState<string>('');
  const [areaCode, setAreaCode] = useState<string>('');
  const [label, setLabel] = useState<string>('Sales');
  const [color, setColor] = useState<string>(COLOR_PALETTE[1]); // orange
  const [isDefault, setIsDefault] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CLAUDE.md UI rule #2 — scroll-to-top on open + mode change.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const reset = () => bodyRef.current?.scrollTo({ top: 0 });
    reset();
    queueMicrotask(reset);
  }, [mode]);

  // CLAUDE.md UI rule #1 — close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lazy-load the unassigned list only when the admin enters that mode.
  useEffect(() => {
    if (mode !== 'unassigned') return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoadingUnassigned(true);
    listUnassignedTelnyxNumbers(token)
      .then(setUnassigned)
      .catch((e) => setError((e as Error).message ?? 'Failed to load unassigned numbers'))
      .finally(() => setLoadingUnassigned(false));
  }, [mode]);

  // v0.10.20 — Lazy-load migration candidates when admin enters migrate mode.
  useEffect(() => {
    if (mode !== 'migrate') return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoadingCandidates(true);
    setError(null);
    listMigrationCandidates(token)
      .then(setMigrationCandidates)
      .catch((e) => setError((e as Error).message ?? 'Failed to load migration candidates'))
      .finally(() => setLoadingCandidates(false));
  }, [mode]);

  async function handleSubmit() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    setSubmitting(true);
    const res = await addUserDid(token, userId, {
      source: mode === 'purchase' ? 'purchase' : 'unassigned',
      ...(mode === 'unassigned' ? { didNumber: pickedNumber } : { purchaseAreaCode: areaCode }),
      label,
      colorHex: color,
      isDefault,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? 'Add failed');
      return;
    }
    if (res.purchased) {
      // Surface what we billed for.
      window.alert(`Purchased ${res.purchasedNumber} from Telnyx and assigned to user.`);
    }
    onAdded();
  }

  // v0.10.20 — Migrate flow submit. Different endpoint from regular Add-Line.
  // POSTs to /admin/users/:id/dids/migrate which re-binds the picked Telnyx
  // DID's connection_id to this user's ACE connection (Pulse stops receiving),
  // then creates a UserDid row.
  //
  // v0.10.21 — On success we LAND ON the cleanup step instead of closing.
  // The cleanup step lets the admin decide what to do with the old SIP
  // connection that previously served this number (deactivate / delete / skip).
  async function handleMigrateSubmit() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    setSubmitting(true);
    const res = await migrateDidToUser(token, userId, {
      didNumber: pickedMigrationDid,
      label,
      colorHex: color,
      isDefault,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? 'Migration failed');
      return;
    }
    // Capture the previous connection's metadata BEFORE closing so the
    // cleanup step can show "what was on connection X (jdoe@pulse)".
    const picked = migrationCandidates.find((c) => c.phoneNumber === pickedMigrationDid);
    setPostMigrate({
      didNumber: pickedMigrationDid,
      previousConnectionId: res.previousConnectionId ?? picked?.sourceConnectionId ?? '',
      previousConnectionName: picked?.connectionName ?? null,
      previousSipUser: picked?.sipUsername ?? null,
    });
    setMode('cleanup');
  }

  // v0.10.21 — Cleanup prompt action. Either deactivates (reversible) or
  // deletes (irreversible) the old SIP connection that served this number
  // on Pulse. Returns control to parent after either succeeds OR after
  // the admin clicks Skip.
  async function handleCleanup(action: 'deactivate' | 'delete' | 'skip') {
    if (action === 'skip') {
      onAdded();
      return;
    }
    const pm = postMigrate;
    if (!pm?.previousConnectionId) {
      // No connection id known — just close gracefully.
      onAdded();
      return;
    }
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    setCleanupBusy(action);
    const res = await cleanupTelnyxConnection(
      token,
      pm.previousConnectionId,
      action,
      `Post-migration cleanup of ${pm.didNumber}`,
    );
    setCleanupBusy(null);
    if (!res.ok) {
      setError(res.error ?? `${action} failed`);
      return;
    }
    onAdded();
  }

  return (
    <div className="compose-modal" onClick={onClose}>
      <div
        className="lines-add-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lines-add-modal-title"
      >
        <header className="modal-header">
          <h3 id="lines-add-modal-title">Add a line</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="modal-body" ref={bodyRef}>
          {error && (
            <div className="pending-error" role="alert">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {mode === 'pick' && (
            <div className="lines-mode-picker">
              <p className="muted">How do you want to add this line?</p>
              <button
                type="button"
                className="lines-mode-option"
                onClick={() => setMode('unassigned')}
              >
                <ListChecks size={20} className="lines-mode-icon" />
                <div className="lines-mode-text">
                  <div className="lines-mode-title">Add an available number from Telnyx</div>
                  <div className="lines-mode-desc">
                    Pick from numbers we already own that aren't currently assigned to a user.
                    No new billing.
                  </div>
                </div>
              </button>
              <button
                type="button"
                className="lines-mode-option"
                onClick={() => setMode('purchase')}
              >
                <ShoppingCart size={20} className="lines-mode-icon" />
                <div className="lines-mode-text">
                  <div className="lines-mode-title">Buy a new number</div>
                  <div className="lines-mode-desc">
                    Search Telnyx for a fresh DID in a US area code and purchase it now.
                    Adds a monthly fee to your Telnyx bill.
                  </div>
                </div>
              </button>
              {/* v0.10.17 — Migrate Existing User to New Dialer.
                  Picks from Telnyx DIDs that ARE currently bound to a
                  Credential Connection (likely Pulse) but haven't been
                  claimed by ACE yet. Re-binds the DID to this ACE user's
                  Credential Connection, so calls now route through ACE
                  without the user losing their phone number. Pulse stops
                  receiving calls for that number immediately. */}
              <button
                type="button"
                className="lines-mode-option"
                onClick={() => setMode('migrate')}
              >
                <ArrowRightLeft size={20} className="lines-mode-icon" />
                <div className="lines-mode-text">
                  <div className="lines-mode-title">Migrate Existing User to New Dialer</div>
                  <div className="lines-mode-desc">
                    Take over a number that's currently working on the old dialer (Pulse).
                    Re-binds it to this user's ACE connection without changing the phone number.
                  </div>
                </div>
              </button>
            </div>
          )}

          {mode === 'unassigned' && (
            <div className="lines-form">
              <button
                type="button"
                className="lines-back-link"
                onClick={() => setMode('pick')}
              >
                ← Change how to add
              </button>

              <label className="lines-field">
                <span>Pick a number</span>
                {loadingUnassigned ? (
                  <p className="muted">Loading available numbers…</p>
                ) : unassigned.length === 0 ? (
                  <p className="muted">
                    No unassigned numbers in inventory.
                    Switch to "Buy a new number" instead, or release one from another user first.
                  </p>
                ) : (
                  <select
                    value={pickedNumber}
                    onChange={(e) => setPickedNumber(e.target.value)}
                  >
                    <option value="">— Select a number —</option>
                    {unassigned.map((n) => (
                      <option key={n.phoneNumber} value={n.phoneNumber}>
                        {formatPhone(n.phoneNumber)}
                      </option>
                    ))}
                  </select>
                )}
              </label>

              <CommonFields
                label={label}
                onLabel={setLabel}
                color={color}
                onColor={setColor}
                isDefault={isDefault}
                onDefault={setIsDefault}
              />

              <div className="modal-footer">
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
                  className="settings-btn"
                  onClick={handleSubmit}
                  disabled={submitting || !pickedNumber || !label}
                >
                  {submitting ? 'Adding…' : 'Add line'}
                </button>
              </div>
            </div>
          )}

          {mode === 'migrate' && (
            <div className="lines-form">
              <button
                type="button"
                className="lines-back-link"
                onClick={() => setMode('pick')}
              >
                ← Change how to add
              </button>

              <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                Picks a phone number that's currently bound to another
                connection in Telnyx (usually the old dialer) and re-binds
                it to this user's ACE connection. The number stays the
                same; the old dialer stops receiving calls for it
                immediately.
              </p>

              <label className="lines-field">
                <span>Pick a number to migrate</span>
                {loadingCandidates ? (
                  <p className="muted">Loading numbers from Telnyx…</p>
                ) : migrationCandidates.length === 0 ? (
                  <p className="muted">
                    No numbers found that are currently bound to another
                    connection. Either all your DIDs are already in ACE,
                    or none are bound to anything in Telnyx yet.
                  </p>
                ) : (
                  <>
                    {/* v0.10.20 — Search input above dropdown. Filters by
                        digit substring, connection name, OR SIP user. */}
                    <input
                      type="text"
                      placeholder="Search by number, connection name, or SIP user…"
                      value={migrationSearch}
                      onChange={(e) => setMigrationSearch(e.target.value)}
                      style={{ marginBottom: '0.4rem' }}
                    />
                    {(() => {
                      const q = migrationSearch.trim().toLowerCase();
                      const qDigits = q.replace(/\D/g, '');
                      const filtered = q
                        ? migrationCandidates.filter((c) => {
                            const digits = c.phoneNumber.replace(/\D/g, '');
                            const nameMatch = (c.connectionName ?? '').toLowerCase().includes(q);
                            const sipMatch = (c.sipUsername ?? '').toLowerCase().includes(q);
                            const numMatch = qDigits.length > 0 && digits.includes(qDigits);
                            return nameMatch || sipMatch || numMatch;
                          })
                        : migrationCandidates;
                      return (
                        <>
                          <select
                            value={pickedMigrationDid}
                            onChange={(e) => setPickedMigrationDid(e.target.value)}
                            size={Math.min(5, Math.max(3, filtered.length + 1))}
                          >
                            <option value="">— Select a number —</option>
                            {filtered.map((c) => {
                              const conn = c.connectionName ?? 'Unknown connection';
                              const sip = c.sipUsername ? ` (SIP user: ${c.sipUsername})` : '';
                              return (
                                <option key={c.phoneNumber} value={c.phoneNumber}>
                                  {formatPhone(c.phoneNumber)} — {conn}{sip}
                                </option>
                              );
                            })}
                          </select>
                          <small className="muted">
                            {filtered.length === migrationCandidates.length
                              ? `${migrationCandidates.length} candidate${migrationCandidates.length === 1 ? '' : 's'}`
                              : `${filtered.length} of ${migrationCandidates.length} matching`}
                          </small>
                        </>
                      );
                    })()}
                  </>
                )}
              </label>

              <CommonFields
                label={label}
                onLabel={setLabel}
                color={color}
                onColor={setColor}
                isDefault={isDefault}
                onDefault={setIsDefault}
              />

              <div
                className="pending-error"
                role="status"
                style={{ marginTop: '0.5rem' }}
              >
                <AlertCircle size={14} />
                <span>
                  Heads-up: migrating will stop the old dialer from
                  receiving calls on this number. Only ACE will ring after.
                </span>
              </div>

              <div className="modal-footer">
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
                  className="settings-btn"
                  onClick={handleMigrateSubmit}
                  disabled={submitting || !pickedMigrationDid || !label}
                >
                  {submitting ? 'Migrating…' : 'Migrate number'}
                </button>
              </div>
            </div>
          )}

          {mode === 'cleanup' && postMigrate && (
            <div className="lines-form">
              <div
                className="pending-status"
                role="status"
                style={{
                  background: 'rgba(34, 197, 94, 0.12)',
                  border: '1px solid rgba(34, 197, 94, 0.35)',
                  color: 'inherit',
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  marginBottom: '0.75rem',
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'center',
                }}
              >
                <Check size={16} />
                <span>
                  Number {formatPhone(postMigrate.didNumber)} migrated
                  successfully. ACE is now receiving its calls and SMS.
                </span>
              </div>

              <h4 style={{ margin: '0.4rem 0 0.3rem 0' }}>Clean up the old SIP connection?</h4>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
                The previous Pulse-side connection still exists in Telnyx
                but no longer receives traffic for this number. Decide
                what to do with it:
              </p>

              <div
                style={{
                  background: 'rgba(128,128,128,0.08)',
                  border: '1px solid rgba(128,128,128,0.2)',
                  borderRadius: '6px',
                  padding: '0.6rem 0.8rem',
                  margin: '0.5rem 0',
                  fontSize: '0.85rem',
                }}
              >
                <div><strong>Connection:</strong> {postMigrate.previousConnectionName ?? '(unknown name)'}</div>
                <div><strong>SIP user:</strong> {postMigrate.previousSipUser ?? '(unknown)'}</div>
                <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  ID: {postMigrate.previousConnectionId || '(none)'}
                </div>
              </div>

              <div
                className="pending-error"
                role="status"
                style={{ marginTop: '0.5rem' }}
              >
                <AlertCircle size={14} />
                <span>
                  <strong>Important:</strong> if this Pulse connection is
                  shared with other users still on Pulse, deactivating or
                  deleting it will break their SIP login too. Only proceed
                  if you're certain this connection only served the migrated
                  number/user.
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  className="settings-btn-secondary"
                  onClick={() => handleCleanup('deactivate')}
                  disabled={cleanupBusy !== null}
                >
                  {cleanupBusy === 'deactivate' ? 'Deactivating…' : 'Deactivate (reversible)'}
                </button>
                <button
                  type="button"
                  className="settings-btn-danger"
                  onClick={() => {
                    if (window.confirm('Permanently delete this Telnyx connection? This cannot be undone — any SIP user on Pulse using these creds will lose access immediately.')) {
                      void handleCleanup('delete');
                    }
                  }}
                  disabled={cleanupBusy !== null}
                  style={{ background: '#dc2626', color: 'white', borderColor: '#dc2626' }}
                >
                  {cleanupBusy === 'delete' ? 'Deleting…' : 'Delete (permanent)'}
                </button>
                <button
                  type="button"
                  className="settings-btn-secondary"
                  onClick={() => handleCleanup('skip')}
                  disabled={cleanupBusy !== null}
                >
                  Keep — do nothing (close)
                </button>
              </div>
            </div>
          )}

          {mode === 'purchase' && (
            <div className="lines-form">
              <button
                type="button"
                className="lines-back-link"
                onClick={() => setMode('pick')}
              >
                ← Change how to add
              </button>

              <label className="lines-field">
                <span>Area code (3 digits)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={3}
                  placeholder="732"
                  value={areaCode}
                  onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                />
                <small className="muted">
                  We'll search Telnyx for the first available local number in this area code and
                  purchase it. Billing starts immediately.
                </small>
              </label>

              <CommonFields
                label={label}
                onLabel={setLabel}
                color={color}
                onColor={setColor}
                isDefault={isDefault}
                onDefault={setIsDefault}
              />

              <div className="modal-footer">
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
                  className="settings-btn"
                  onClick={handleSubmit}
                  disabled={submitting || areaCode.length !== 3 || !label}
                >
                  {submitting ? 'Purchasing…' : 'Buy + assign'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared form chunk between both modes — label, color, default flag.
function CommonFields({
  label, onLabel, color, onColor, isDefault, onDefault,
}: {
  label: string; onLabel: (s: string) => void;
  color: string; onColor: (s: string) => void;
  isDefault: boolean; onDefault: (b: boolean) => void;
}) {
  return (
    <>
      <label className="lines-field">
        <span>Label</span>
        <input
          type="text"
          maxLength={40}
          placeholder="e.g. Sales, Personal, Recruiting"
          value={label}
          onChange={(e) => onLabel(e.target.value)}
        />
      </label>

      <div className="lines-field">
        <span>Color</span>
        <div className="lines-color-palette-inline">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`lines-color-swatch${c === color ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => onColor(c)}
              aria-label={`Set color to ${c}`}
            >
              {c === color && <Check size={12} />}
            </button>
          ))}
        </div>
      </div>

      <label className="lines-field lines-field-checkbox">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => onDefault(e.target.checked)}
        />
        <span>Set as user's default outbound line</span>
      </label>
    </>
  );
}
