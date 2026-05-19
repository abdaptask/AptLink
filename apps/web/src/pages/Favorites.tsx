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
        <div className="compose-modal">
          <div className="compose-box">
            <h3>Add favorite</h3>
            <input
              className="ict-input"
              placeholder="Phone number"
              value={draftPhone}
              onChange={(e) => setDraftPhone(e.target.value)}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                className="ict-input"
                placeholder="First name (optional)"
                value={draftFirst}
                onChange={(e) => setDraftFirst(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                className="ict-input"
                placeholder="Last name (optional)"
                value={draftLast}
                onChange={(e) => setDraftLast(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="ict-actions">
              <button
                className="ict-cancel"
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
                className="ict-confirm"
                disabled={!draftPhone.trim()}
                onClick={handleAdd}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
          {(name[0] ?? '?').toUpperCase()}
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
