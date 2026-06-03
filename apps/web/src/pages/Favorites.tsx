// Favorites tab — quick-access list of starred contacts.
// Stored in localStorage via lib/userPrefs (so it survives across sessions).
//
// v0.10.66 — Multi-number favorites: each contact can have multiple labeled
// numbers (Cell / Home / Work / Other). The row collapses to the primary
// number's call/SMS by default; tap the chevron to expand and show every
// number with its own quick actions (call / SMS / block / remove).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, MessageSquare, Star, Plus, X, ChevronDown, ChevronUp, Ban, Trash2 } from 'lucide-react';
import {
  getFavorites,
  addFavorite,
  removeFavorite,
  type FavoriteContact,
} from '../lib/userPrefs';
import {
  addFavoriteNumber,
  patchFavoriteNumber,
  deleteFavoriteNumber,
  addBlockedNumber,
} from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone, toE164 } from '../lib/phone';

export default function Favorites() {
  const [favs, setFavs] = useState<FavoriteContact[]>(() => getFavorites());
  const [showAdd, setShowAdd] = useState(false);
  const [draftPhone, setDraftPhone] = useState('');
  const [draftFirst, setDraftFirst] = useState('');
  const [draftLast, setDraftLast] = useState('');
  const { sipState, call } = useSip();
  const navigate = useNavigate();

  // Re-read whenever someone adds/removes from anywhere.
  useEffect(() => {
    const refresh = () => setFavs(getFavorites());
    window.addEventListener('ace:favoritesChanged', refresh);
    return () => window.removeEventListener('ace:favoritesChanged', refresh);
  }, []);

  function handleCall(f: FavoriteContact) {
    if (sipState !== 'registered') {
      alert(`SIP not ready (${sipState}). Try again in a moment.`);
      return;
    }
    call(f.phone);
    navigate('/in-call');
  }
  function handleSms(f: FavoriteContact) {
    navigate(`/messages?to=${encodeURIComponent(f.phone)}`);
  }
  function handleRemove(f: FavoriteContact) {
    if (!confirm(`Remove ${f.label || formatPhone(f.phone)} from favorites?`)) return;
    removeFavorite(f.phone);
  }
  function handleAdd() {
    const phone = draftPhone.trim();
    if (!phone) return;
    addFavorite(toE164(phone), {
      firstName: draftFirst.trim() || null,
      lastName: draftLast.trim() || null,
    });
    setDraftPhone('');
    setDraftFirst('');
    setDraftLast('');
    setShowAdd(false);
  }

  return (
    <div className="favorites">
      <div className="recents-header">
        <h2>Favorites</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setShowAdd(true)}
          aria-label="Add favorite"
        >
          <Plus size={18} />
        </button>
      </div>

      {favs.length === 0 ? (
        <div className="empty-state">
          <Star size={32} style={{ opacity: 0.4, marginBottom: '0.5rem' }} />
          <p>No favorites yet.</p>
          <p className="muted">
            Tap the star on any conversation, recent, or voicemail to pin it here.
          </p>
        </div>
      ) : (
        <ul className="favorites-list">
          {favs.map((f) => (
            <FavoriteRow
              key={f.phone}
              fav={f}
              onCall={() => handleCall(f)}
              onSms={() => handleSms(f)}
              onRemove={() => handleRemove(f)}
            />
          ))}
        </ul>
      )}

      {showAdd && (
        <div
          className="compose-modal"
          onClick={() => {
            setShowAdd(false);
            setDraftPhone('');
            setDraftFirst('');
            setDraftLast('');
          }}
        >
          <div
            className="fav-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="fav-modal-title-2"
          >
            <div className="fav-modal-header">
              <Star size={18} fill="currentColor" className="fav-modal-icon" />
              <h3 id="fav-modal-title-2">Add favorite</h3>
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); if (draftPhone.trim()) handleAdd(); }}
              autoComplete="off"
            >
              {/* Honeypot to absorb password-manager autofill */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
              />
              <label className="fav-modal-field" style={{ marginBottom: '0.75rem' }}>
                <span className="fav-modal-label">Phone number</span>
                <input
                  type="tel"
                  inputMode="tel"
                  className="fav-modal-input"
                  placeholder="+1 (555) 123 4567"
                  value={draftPhone}
                  onChange={(e) => setDraftPhone(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  name="fav-phone"
                />
              </label>
              <div className="fav-modal-row">
                <label className="fav-modal-field">
                  <span className="fav-modal-label">First name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    placeholder="Optional"
                    value={draftFirst}
                    onChange={(e) => setDraftFirst(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    name="fav-first"
                  />
                </label>
                <label className="fav-modal-field">
                  <span className="fav-modal-label">Last name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    placeholder="Optional"
                    value={draftLast}
                    onChange={(e) => setDraftLast(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    name="fav-last"
                  />
                </label>
              </div>
              <div className="fav-modal-actions">
                <button
                  type="button"
                  className="fav-modal-cancel"
                  onClick={() => {
                    setShowAdd(false);
                    setDraftPhone('');
                    setDraftFirst('');
                    setDraftLast('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="fav-modal-save"
                  disabled={!draftPhone.trim()}
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Initials for the round avatar.
// Rules (in order):
//   - If firstName + lastName both present: take first letter of each, uppercase.
//       "Abdulla Sheikh" → "AS",  "A Sheikh" → "AS",  "Abdulla S" → "AS"
//   - If only firstName: first letter of firstName.
//   - If only lastName: first letter of lastName.
//   - Otherwise, fall back to the display label (first letter, or the first
//     letter of each whitespace-separated word, up to 2).
function favoriteInitials(fav: FavoriteContact, fallbackName: string): string {
  const first = (fav.firstName ?? '').trim();
  const last = (fav.lastName ?? '').trim();
  if (first && last) {
    return (first[0] + last[0]).toUpperCase();
  }
  if (first) return first[0].toUpperCase();
  if (last) return last[0].toUpperCase();
  // Fall back to label / JobDiva name. Take initials of first two words.
  const words = (fallbackName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1) {
    return words[0][0].toUpperCase();
  }
  return '?';
}

function FavoriteRow({
  fav,
  onCall,
  onSms,
  onRemove,
}: {
  fav: FavoriteContact;
  onCall: () => void;
  onSms: () => void;
  onRemove: () => void;
}) {
  const jd = useJobDivaContact(fav.phone);
  const name = fav.label ?? jd?.name ?? getCachedJobDivaName(fav.phone) ?? formatPhone(fav.phone);
  const secondary = jd?.company ?? formatPhone(fav.phone);
  const navigate = useNavigate();
  const { sipState, call } = useSip();

  // v0.10.66 — Multi-number expand state. Initialized collapsed; user
  // taps the chevron (or the row when there's >1 number) to expand and
  // see per-number quick actions.
  const numbers = fav.numbers ?? [];
  const hasMultiple = numbers.length > 1;
  const [expanded, setExpanded] = useState(false);

  // v0.10.66 — When the favorite has more than one number, tapping the
  // row's name area expands the number list instead of dialing the
  // primary. Single-number favorites keep the legacy tap-to-call behavior.
  const handleRowTap = () => {
    if (hasMultiple) {
      setExpanded((v) => !v);
    } else {
      onCall();
    }
  };

  // v0.10.66 — Per-number actions used in the expanded view. Mirrors the
  // top-level call/sms but for an arbitrary number on this favorite.
  function callNumber(phone: string) {
    if (sipState !== 'registered') {
      alert(`SIP not ready (${sipState}). Try again in a moment.`);
      return;
    }
    call(phone);
    navigate('/in-call');
  }
  function smsNumber(phone: string) {
    navigate(`/messages?to=${encodeURIComponent(phone)}`);
  }
  async function blockNumber(phone: string) {
    const reason = prompt(`Why are you blocking ${formatPhone(phone)}? (Admin can see this reason.)`, '');
    if (reason === null) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const r = await addBlockedNumber(token, { number: phone, reason: reason.trim() || undefined });
    if ('error' in r && r.error) {
      alert(`Block failed: ${r.error}`);
    }
  }
  async function removeNumber(numberId: number) {
    const token = sessionStorage.getItem('ace_token');
    if (!token || !fav.id) return;
    if (!confirm('Remove this number from the favorite?')) return;
    const r = await deleteFavoriteNumber(token, fav.id, numberId);
    if (!r.ok) {
      alert(r.error ?? 'Remove failed');
      return;
    }
    // Trigger a refresh so the cache picks up the change.
    window.dispatchEvent(new CustomEvent('ace:favoritesChanged'));
  }

  return (
    <li className={`favorite-row${expanded ? ' expanded' : ''}`}>
      <button type="button" className="favorite-main" onClick={handleRowTap}>
        <span className="favorite-avatar">
          {favoriteInitials(fav, name)}
        </span>
        <span className="favorite-text">
          <span className="favorite-name">
            {name}
            {hasMultiple && (
              <span className="favorite-numbers-count" title={`${numbers.length} numbers — tap to expand`}>
                {numbers.length} numbers
              </span>
            )}
          </span>
          {secondary && secondary !== name && (
            <span className="favorite-sub">{secondary}</span>
          )}
        </span>
      </button>
      <div className="favorite-actions">
        {hasMultiple && (
          <button
            type="button"
            className="callback-ico"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse numbers' : 'Show all numbers'}
            title={expanded ? 'Hide numbers' : 'Show all numbers'}
          >
            {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
        <button
          type="button"
          className="callback-ico sms-ico"
          onClick={onSms}
          aria-label="Send message"
          title="Send message"
        >
          <MessageSquare size={16} />
        </button>
        <button
          type="button"
          className="callback-ico"
          onClick={onCall}
          aria-label="Call"
          title="Call"
        >
          <Phone size={18} />
        </button>
        <button
          type="button"
          className="callback-ico"
          onClick={onRemove}
          aria-label="Remove favorite"
          title="Remove"
          style={{ color: 'var(--text-muted)' }}
        >
          <X size={16} />
        </button>
      </div>

      {/* v0.10.66 — Expanded multi-number list. Each row shows the label,
          formatted phone, and call/SMS/block/remove icons. Per-number block
          (not per-favorite) per design decision. */}
      {expanded && hasMultiple && (
        <ul className="favorite-numbers-list">
          {numbers.map((n) => (
            <li
              key={n.id}
              className={`favorite-number-row${n.isPrimary ? ' primary' : ''}`}
            >
              <div className="favorite-number-text">
                <span className="favorite-number-label">
                  {n.label}
                  {n.isPrimary && <span className="favorite-number-primary-pill">primary</span>}
                </span>
                <span className="favorite-number-phone">{formatPhone(n.phone)}</span>
              </div>
              <div className="favorite-number-actions">
                <button
                  type="button"
                  className="callback-ico sms-ico"
                  onClick={() => smsNumber(n.phone)}
                  aria-label={`Send message to ${n.label}`}
                  title={`Send message to ${n.label}`}
                >
                  <MessageSquare size={14} />
                </button>
                <button
                  type="button"
                  className="callback-ico"
                  onClick={() => callNumber(n.phone)}
                  aria-label={`Call ${n.label}`}
                  title={`Call ${n.label}`}
                >
                  <Phone size={16} />
                </button>
                <button
                  type="button"
                  className="callback-ico"
                  onClick={() => blockNumber(n.phone)}
                  aria-label={`Block ${n.label}`}
                  title={`Block ${n.label}`}
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Ban size={14} />
                </button>
                <button
                  type="button"
                  className="callback-ico"
                  onClick={() => removeNumber(n.id)}
                  aria-label={`Remove ${n.label}`}
                  title={`Remove ${n.label}`}
                  style={{ color: 'var(--text-muted)' }}
                  disabled={numbers.length <= 1}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
          {/* v0.10.66 — Add-number affordance lives at the bottom of the
              expanded list. Posts to /favorites/:id/numbers. */}
          {fav.id !== undefined && (
            <AddNumberInline
              favoriteId={fav.id}
              onAdded={() => window.dispatchEvent(new CustomEvent('ace:favoritesChanged'))}
            />
          )}
        </ul>
      )}
    </li>
  );
}

// v0.10.66 — Inline "add another number" form inside the expanded
// favorite. Two fields (phone + label dropdown). Submits via the
// /favorites/:id/numbers POST.
function AddNumberInline({
  favoriteId,
  onAdded,
}: {
  favoriteId: number;
  onAdded: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState<'Cell' | 'Home' | 'Work' | 'Other'>('Cell');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function handleAdd() {
    setError(null);
    if (!phone.trim()) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSubmitting(true);
    const r = await addFavoriteNumber(token, favoriteId, {
      phone: toE164(phone),
      label,
    });
    setSubmitting(false);
    if ('error' in r && r.error) {
      setError(r.error);
      return;
    }
    setPhone('');
    setLabel('Cell');
    setOpen(false);
    onAdded();
  }

  if (!open) {
    return (
      <li className="favorite-number-add-cta">
        <button
          type="button"
          className="callback-ico"
          onClick={() => setOpen(true)}
          aria-label="Add another number"
          title="Add another number"
        >
          <Plus size={14} /> <span style={{ fontSize: 12 }}>Add number</span>
        </button>
      </li>
    );
  }

  return (
    <li className="favorite-number-add-form">
      <select
        value={label}
        onChange={(e) => setLabel(e.target.value as typeof label)}
        disabled={submitting}
        aria-label="Number label"
      >
        <option>Cell</option>
        <option>Home</option>
        <option>Work</option>
        <option>Other</option>
      </select>
      <input
        type="tel"
        placeholder="+1 555 123 4567"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={submitting}
      />
      <button type="button" onClick={handleAdd} disabled={submitting || !phone.trim()}>
        {submitting ? '…' : 'Add'}
      </button>
      <button type="button" onClick={() => { setOpen(false); setError(null); }} disabled={submitting}>
        Cancel
      </button>
      {error && <div className="error small" style={{ width: '100%' }}>{error}</div>}
    </li>
  );
}
