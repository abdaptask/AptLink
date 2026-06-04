// v0.10.74 — Praise / Announcement recipient modal.
//
// Polls /me/praises every 60 seconds for unread praises addressed to the
// current user (or broadcast). When something lands, queues it for
// display. The modal:
//   * is suppressed when an active call is in progress — recruiter
//     shouldn't get yanked out of a conversation by a confetti modal
//   * shows the highest-priority unread item; user dismisses with
//     "Got it" which POSTs to /me/praises/:id/read, then the next
//     unread item in the queue (if any) pops up
//   * displays the sender's name, the category icon + headline, the
//     recipient name (when set), and the free-form message
//
// Mounted once at the Layout level so it's available on every tab.

import { useEffect, useRef, useState } from 'react';
import { PartyPopper, Cake, Award, UserPlus, Star, X } from 'lucide-react';
import { listMyPraises, markPraiseRead, type Praise, type PraiseCategory } from '../api';
import { useSip } from '../contexts/SipContext';

// Icon + default headline per category. Customizable later if needed.
// Keep this in sync with the CATEGORY_VALUES list in
// apps/api/src/praises/praises.routes.ts.
const CATEGORY_META: Record<PraiseCategory, { icon: typeof PartyPopper; headline: string; accent: string }> = {
  new_hire: { icon: UserPlus, headline: 'Welcome aboard', accent: '#0a84ff' },
  new_offer: { icon: Star, headline: 'New offer!', accent: '#34c759' },
  birthday: { icon: Cake, headline: 'Happy birthday', accent: '#ff2d55' },
  anniversary: { icon: Award, headline: 'Work anniversary', accent: '#ffcc00' },
  custom: { icon: PartyPopper, headline: 'A note from the team', accent: '#af52de' },
};

interface PraiseModalProps {
  /** Optional ref-style polling tick. When the parent dispatches the
   *  custom event 'ace:praise-poke' (e.g. after admin sends a new one),
   *  we refetch immediately instead of waiting for the next interval. */
  // Receives no props — fully self-contained for drop-in placement.
}

export default function PraiseModal({}: PraiseModalProps) {
  const [queue, setQueue] = useState<Praise[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const { callState } = useSip();

  // Don't display while an active call is ongoing — wait until they're
  // back to idle. Same rule the call-block CSS uses elsewhere.
  const callActive = callState.state === 'connected' || callState.state === 'ringing' || callState.state === 'calling';

  // Polling — every 60 seconds. Custom event 'ace:praise-poke' triggers
  // immediate refetch (e.g. when admin just sent one in this session).
  const inFlightRef = useRef(false);
  useEffect(() => {
    const fetchNow = async () => {
      if (inFlightRef.current) return;
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      inFlightRef.current = true;
      try {
        const rows = await listMyPraises(token);
        setQueue(rows);
      } finally {
        inFlightRef.current = false;
      }
    };
    void fetchNow();
    const id = window.setInterval(fetchNow, 60_000);
    const onPoke = () => void fetchNow();
    window.addEventListener('ace:praise-poke', onPoke);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('ace:praise-poke', onPoke);
    };
  }, []);

  if (queue.length === 0 || callActive) return null;

  // Show the most-recent unread first (queue is ordered desc by createdAt).
  const current = queue[0];
  const meta = CATEGORY_META[current.category] ?? CATEGORY_META.custom;
  const Icon = meta.icon;
  const senderName =
    [current.fromUser.firstName, current.fromUser.lastName].filter(Boolean).join(' ').trim() ||
    current.fromUser.email;
  // v0.10.89 — Display headline.
  // Priority: admin-authored override (current.headline) → category default
  // + recipientName → category default alone. The override exists because
  // the auto-built "Welcome aboard {recipientName}" doesn't fit every
  // use case (e.g. praising the recruiter for a placement vs. welcoming
  // the new hire themselves).
  const headline = current.headline?.trim()
    ? current.headline.trim()
    : current.recipientName
      ? `${meta.headline} ${current.recipientName}`
      : meta.headline;

  async function handleDismiss() {
    if (submitting) return;
    setSubmitting(true);
    const token = sessionStorage.getItem('ace_token');
    if (token) {
      try {
        await markPraiseRead(token, current.id);
      } catch {
        /* non-fatal — worst case the user sees it again next poll */
      }
    }
    // Pop from local queue so the next one (if any) shows immediately.
    setQueue((q) => q.filter((p) => p.id !== current.id));
    setSubmitting(false);
  }

  return (
    <div className="praise-modal-backdrop" onClick={handleDismiss}>
      <div
        className="praise-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="praise-modal-headline"
      >
        <button
          type="button"
          className="praise-modal-close"
          onClick={handleDismiss}
          disabled={submitting}
          aria-label="Dismiss"
        >
          <X size={18} />
        </button>
        <div className="praise-modal-icon" style={{ background: meta.accent }}>
          <Icon size={48} />
        </div>
        <div className="praise-modal-headline" id="praise-modal-headline">
          {headline}
        </div>
        <div className="praise-modal-message">{current.message}</div>
        <div className="praise-modal-from">From {senderName}</div>
        <button
          type="button"
          className="praise-modal-cta"
          onClick={handleDismiss}
          disabled={submitting}
        >
          {submitting ? 'Marking…' : 'Got it 🎉'}
        </button>
        {queue.length > 1 && (
          <div className="praise-modal-queue-hint">
            {queue.length - 1} more {queue.length - 1 === 1 ? 'announcement' : 'announcements'} after this
          </div>
        )}
      </div>
    </div>
  );
}
