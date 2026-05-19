// Favorites tab — quick-access list of starred contacts.
// Stored in localStorage via lib/userPrefs (so it survives across sessions).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, MessageSquare, Star, StarOff, Plus, X } from 'lucide-react';
import {
  getFavorites,
  addFavorite,
  removeFavorite,
  type FavoriteContact,
} from '../lib/userPrefs';
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
  return (
    <li className="favorite-row">
      <button type="button" className="favorite-main" onClick={onCall}>
        <span className="favorite-avatar">
          {favoriteInitials(fav, name)}
        </span>
        <span className="favorite-text">
          <span className="favorite-name">{name}</span>
          {secondary && secondary !== name && (
            <span className="favorite-sub">{secondary}</span>
          )}
        </span>
      </button>
      <div className="favorite-actions">
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
    </li>
  );
}
