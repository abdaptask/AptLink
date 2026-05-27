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

import { useEffect, useState } from 'react';
import { X, Plus, Trash2, Pencil, Check, ShoppingCart, ListChecks, Star, AlertCircle } from 'lucide-react';
import {
  getAdminUserDids,
  addUserDid,
  patchUserDid,
  removeUserDid,
  listUnassignedTelnyxNumbers,
  type AdminUserDidRow,
  type UnassignedTelnyxNumber,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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

  async function handleEditLabel(row: AdminUserDidRow) {
    const next = window.prompt(`New label for ${formatPhone(row.didNumber)}:`, row.label);
    if (next === null) return;
    const trimmed = next.trim();
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
    <div className="compose-modal" onClick={onClose}>
      <div
        className="lines-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="lines-modal-title"
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

        <div className="modal-body lines-modal-body">
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
                        {row.label}
                        {row.isDefault && (
                          <span className="lines-row-default-pill" title="Default outbound line">
                            Default
                          </span>
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
  const [mode, setMode] = useState<'pick' | 'unassigned' | 'purchase'>('pick');
  const [unassigned, setUnassigned] = useState<UnassignedTelnyxNumber[]>([]);
  const [loadingUnassigned, setLoadingUnassigned] = useState(false);

  // Form state (shared between modes — only some fields apply per mode).
  const [pickedNumber, setPickedNumber] = useState<string>('');
  const [areaCode, setAreaCode] = useState<string>('');
  const [label, setLabel] = useState<string>('Sales');
  const [color, setColor] = useState<string>(COLOR_PALETTE[1]); // orange
  const [isDefault, setIsDefault] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="compose-modal" onClick={onClose}>
      <div
        className="lines-add-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <h3>Add a line</h3>
          <button type="button" className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="modal-body">
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
                  <div className="lines-mode-title">Use an existing number</div>
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
