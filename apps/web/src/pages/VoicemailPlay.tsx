// v0.10.2 Pillar 2 / Task 9 — Voicemail playback page.
//
// Reached by clicking "Listen" on a Teams card, or by direct link
// at /voicemail/:id/play. Authentication is enforced by the parent
// route wrapper (App.tsx → Layout → authenticated only); if the user
// isn't logged in, App.tsx stashes the URL in sessionStorage and
// redirects to /login, then returns here after SSO.
//
// Layout: minimal full-page view (rendered INSIDE Layout but with its
// own scroll container). Shows caller info, time received, duration,
// audio player, transcript text, action buttons (Call back / Send
// text — using the same routes the Teams card buttons fall back to).
//
// Audio fetch strategy: <audio src=...> can't carry an Authorization
// header. We fetch the audio bytes with our JWT, convert the response
// to a Blob, and create an Object URL for the <audio> element. The
// blob is freed in the cleanup effect to avoid leaking memory across
// page nav.
//
// Per CLAUDE.md UI rule #3, we scroll-to-top on mount even though this
// page is reached via direct nav (defensive — covers the case where
// the user opens it from a Teams card while a prior tab was scrolled).

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Phone,
  MessageSquare,
  ArrowLeft,
  Voicemail as VoicemailIcon,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import {
  getVoicemail,
  getVoicemailAudioBlob,
  markVoicemailListened,
  type VoicemailRecord,
} from '../api';
import { formatPhone } from '../lib/phone';
import LineBadge from '../components/LineBadge';

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFullTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-US', { timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function VoicemailPlay() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [vm, setVm] = useState<VoicemailRecord | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [audioLoading, setAudioLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioBlobRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll-to-top on mount per CLAUDE.md UI rule #3. We hit both
  // window scroll AND the internal scroll container to cover both
  // layouts (mobile single-column vs desktop with sidebar).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) {
      // Defensive — App.tsx should have redirected before we mount,
      // but in case of a race or direct navigation while logging out.
      navigate('/login');
      return;
    }
    if (!id || !Number.isFinite(Number(id))) {
      setError('Invalid voicemail ID');
      setLoading(false);
      return;
    }
    const vmId = Number(id);

    let cancelled = false;

    // Fetch metadata + audio in parallel. Metadata blocks UI; audio
    // loads in background and the <audio> spinner reflects its state.
    (async () => {
      try {
        const meta = await getVoicemail(token, vmId);
        if (cancelled) return;
        setVm(meta);
        setLoading(false);

        // Mark as listened the moment the page loads — same heuristic
        // as opening the row in the main Voicemail list. If the user
        // bounces away without playing we still consider it "seen".
        if (!meta.listenedAt) {
          void markVoicemailListened(token, vmId, true).catch(() => {
            /* non-fatal — UI doesn't depend on this */
          });
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.includes('404') ? 'Voicemail not found or not yours.' : msg);
        setLoading(false);
      }

      // Audio fetch is independent — even if metadata succeeded the
      // recording URL upstream might fail (Telnyx 410 after retention,
      // network blip). Errors render inline next to the player.
      try {
        const blobUrl = await getVoicemailAudioBlob(token, vmId);
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        audioBlobRef.current = blobUrl;
        setAudioUrl(blobUrl);
        setAudioLoading(false);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setAudioError(msg || 'Audio unavailable');
        setAudioLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (audioBlobRef.current) {
        URL.revokeObjectURL(audioBlobRef.current);
        audioBlobRef.current = null;
      }
    };
  }, [id, navigate]);

  function handleCallBack() {
    if (!vm) return;
    // Use the in-app dialer rather than firing the deep-link protocol —
    // this page IS the dialer. Same approach as elsewhere in the app.
    navigate(`/keypad?to=${encodeURIComponent(vm.fromNumber)}`);
  }

  function handleSendText() {
    if (!vm) return;
    navigate(`/messages?to=${encodeURIComponent(vm.fromNumber)}`);
  }

  function handleBack() {
    navigate('/voicemail');
  }

  if (loading) {
    return (
      <div className="vm-play-page" ref={scrollRef}>
        <div className="vm-play-loading">
          <Loader2 size={24} className="spin" />
          <span>Loading voicemail…</span>
        </div>
      </div>
    );
  }

  if (error || !vm) {
    return (
      <div className="vm-play-page" ref={scrollRef}>
        <div className="vm-play-error">
          <AlertCircle size={24} />
          <h2>Couldn't open voicemail</h2>
          <p>{error ?? 'Unknown error'}</p>
          <button type="button" className="settings-btn" onClick={handleBack}>
            <ArrowLeft size={14} /> Back to voicemails
          </button>
        </div>
      </div>
    );
  }

  const callerDisplay = formatPhone(vm.fromNumber) || vm.fromNumber;

  return (
    <div className="vm-play-page" ref={scrollRef}>
      <button
        type="button"
        className="vm-play-back"
        onClick={handleBack}
        aria-label="Back to voicemails"
      >
        <ArrowLeft size={16} /> All voicemails
      </button>

      <div className="vm-play-card">
        <div className="vm-play-header">
          <VoicemailIcon size={28} className="vm-play-icon" />
          <div className="vm-play-header-text">
            <h1>{callerDisplay}</h1>
            <p className="muted">
              {formatFullTime(vm.receivedAt)} • {formatDuration(vm.durationSeconds)}
            </p>
            {vm.userDid && (
              <div className="vm-play-line">
                <LineBadge userDid={vm.userDid} />
              </div>
            )}
          </div>
        </div>

        <div className="vm-play-audio">
          {audioLoading ? (
            <div className="vm-play-audio-loading">
              <Loader2 size={16} className="spin" /> Loading audio…
            </div>
          ) : audioError ? (
            <div className="vm-play-audio-error">
              <AlertCircle size={16} />
              <span>{audioError}</span>
            </div>
          ) : audioUrl ? (
            <audio controls preload="auto" src={audioUrl} className="vm-play-audio-el">
              Your browser does not support audio playback.
            </audio>
          ) : null}
        </div>

        <div className="vm-play-transcript">
          <h3>Transcript</h3>
          {vm.transcription ? (
            <p>{vm.transcription}</p>
          ) : (
            <p className="muted italic">
              Transcription not available for this voicemail.
            </p>
          )}
        </div>

        <div className="vm-play-actions">
          <button type="button" className="settings-btn" onClick={handleCallBack}>
            <Phone size={14} /> Call back
          </button>
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={handleSendText}
          >
            <MessageSquare size={14} /> Send text
          </button>
        </div>
      </div>
    </div>
  );
}
