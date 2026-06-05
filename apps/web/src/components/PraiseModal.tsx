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
import {
  PartyPopper, Cake, Award, UserPlus, Star, X,
  Megaphone, RefreshCw, Wrench, TreePine, Clipboard,
  AlertTriangle, AlertOctagon, Bell, GraduationCap, Hand,
} from 'lucide-react';
import { listMyPraises, markPraiseRead, type Praise, type PraiseCategory } from '../api';
import { useSip } from '../contexts/SipContext';

// v0.10.93 — Broadcast metadata.
//
// Each category has:
//   icon     — Lucide React component shown in the modal's circle icon
//   headline — default text the recipient sees if admin doesn't override
//   accent   — primary color (icon background + border accent)
//   group    — visual grouping ('celebration' | 'announcement' | 'alert' |
//              'reminder' | 'welcome'). Drives the modal's overall mood —
//              alerts get red borders, celebrations get festive treatment,
//              reminders get amber prominence, etc.
//
// Keep this in sync with:
//   - apps/api/src/praises/praises.routes.ts CATEGORY_VALUES
//   - apps/web/src/api.ts PraiseCategory type
//   - apps/web/src/pages/Settings.tsx CATEGORY_LABELS + BroadcastAdminSection grouping
type CategoryGroup = 'celebration' | 'announcement' | 'alert' | 'reminder' | 'welcome';

const CATEGORY_META: Record<PraiseCategory, {
  icon: typeof PartyPopper;
  headline: string;
  accent: string;
  group: CategoryGroup;
}> = {
  // ── Celebrations ───────────────────────────────────────────────────
  new_hire:    { icon: UserPlus,    headline: 'Welcome aboard',         accent: '#0a84ff', group: 'celebration' },
  new_offer:   { icon: Star,        headline: 'New offer!',             accent: '#34c759', group: 'celebration' },
  birthday:    { icon: Cake,        headline: 'Happy birthday',         accent: '#ff2d55', group: 'celebration' },
  anniversary: { icon: Award,       headline: 'Work anniversary',       accent: '#ffcc00', group: 'celebration' },
  custom:      { icon: PartyPopper, headline: 'A note from the team',   accent: '#af52de', group: 'celebration' },
  // ── Announcements ──────────────────────────────────────────────────
  announcement:    { icon: Megaphone, headline: 'Announcement',              accent: '#0a84ff', group: 'announcement' },
  update_required: { icon: RefreshCw, headline: 'Please update your dialer', accent: '#5e5ce6', group: 'announcement' },
  maintenance:     { icon: Wrench,    headline: 'Scheduled maintenance',     accent: '#64748b', group: 'announcement' },
  holiday:         { icon: TreePine,  headline: 'Office closed',             accent: '#14b8a6', group: 'announcement' },
  policy_update:   { icon: Clipboard, headline: 'Policy update',             accent: '#6366f1', group: 'announcement' },
  // ── Alerts ─────────────────────────────────────────────────────────
  alert_urgent:    { icon: AlertTriangle, headline: 'Important — please read', accent: '#dc2626', group: 'alert' },
  service_outage:  { icon: AlertOctagon,  headline: 'Service notice',          accent: '#ea580c', group: 'alert' },
  // ── Reminders ──────────────────────────────────────────────────────
  reminder: { icon: Bell,           headline: 'Reminder',           accent: '#f59e0b', group: 'reminder' },
  training: { icon: GraduationCap,  headline: 'Training session',   accent: '#0891b2', group: 'reminder' },
  // ── Welcomes ───────────────────────────────────────────────────────
  welcome:  { icon: Hand, headline: 'Welcome to the team', accent: '#f97316', group: 'welcome' },
};

// Per-group visual treatment for the modal container itself.
//   alert   → red border ring (draws extra attention)
//   announcement → subtle blue accent border
//   reminder → amber accent
//   celebration / welcome → no extra ring (the icon color carries the mood)
function modalContainerStyle(group: CategoryGroup): React.CSSProperties {
  switch (group) {
    case 'alert':
      return { boxShadow: '0 0 0 2px rgba(220, 38, 38, 0.35), 0 8px 32px rgba(15, 23, 42, 0.25)' };
    case 'announcement':
      return { boxShadow: '0 0 0 1px rgba(10, 132, 255, 0.25), 0 8px 32px rgba(15, 23, 42, 0.18)' };
    case 'reminder':
      return { boxShadow: '0 0 0 1px rgba(245, 158, 11, 0.30), 0 8px 32px rgba(15, 23, 42, 0.18)' };
    default:
      return {};
  }
}

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
  // v0.10.89/95 — Display headline.
  // Priority: admin-authored override (current.headline) → category default
  // + recipientName (ONLY for Celebrations + Welcomes where appending a
  // name reads naturally) → category default alone. For Announcements /
  // Alerts / Reminders the admin form doesn't even surface the
  // recipientName field, so this branch typically has no name to append.
  // The override exists because the auto-built "Welcome aboard {name}"
  // doesn't fit every use case (e.g. praising the recruiter vs. welcoming
  // the new hire themselves).
  const appendsName = meta.group === 'celebration' || meta.group === 'welcome';
  const headline = current.headline?.trim()
    ? current.headline.trim()
    : appendsName && current.recipientName
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
        // v0.10.93 — per-category-group visual treatment. Alerts get an
        // attention-grabbing red ring; reminders amber; announcements
        // blue; celebrations/welcomes use the standard shadow.
        style={modalContainerStyle(meta.group)}
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
