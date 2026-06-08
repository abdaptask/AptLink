// v0.10.80 — Settings → Diagnostics. Download the in-memory log buffer
// as a .txt file so users can email it to support.
//
// PROBLEM this solves: when a user reports a missed call or weird SIP
// behavior, we need to know what their dialer was actually doing. Asking
// non-technical users to open DevTools is a non-starter. This page lets
// any user click one button and email me the timeline.
//
// The buffer is populated via installConsoleInterceptors() in main.tsx —
// see services/logBuffer.ts for the implementation.

import { useEffect, useState } from 'react';
import { Download, FileText, RefreshCw } from 'lucide-react';
import {
  getAllLogs,
  getLogBufferSize,
  getLogsAsText,
  getRecentLogs,
  getSessionStartTime,
  type LogEntry,
} from '../services/logBuffer';

// Hard-coded so the export filename has a version stamp. Bump when bumping
// the rest of the version-bumped files.
const APP_VERSION = '0.10.105';

export default function DiagnosticsSection() {
  const [bufferSize, setBufferSize] = useState<number>(0);
  const [recent, setRecent] = useState<LogEntry[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  // Refresh the live tail every second so users can SEE that logs are
  // being captured. Stops when the tab is hidden (no point refreshing
  // a view nobody's looking at).
  useEffect(() => {
    function refresh() {
      setBufferSize(getLogBufferSize());
      setRecent(getRecentLogs(40));
    }
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Pull the email from the JWT once at mount so the export filename
  // includes who it came from. Decoded without validation — only used
  // for filename display; security-critical decisions happen server-side.
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
      if (payload?.email) setEmail(payload.email);
    } catch {
      // Bad token shape — leave email as null. Filename will fall back
      // to "anonymous". Not worth alarming the user about.
    }
  }, []);

  function handleDownload() {
    setDownloading(true);
    try {
      const text = getLogsAsText({ email, version: APP_VERSION });
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      // Filename: ace-dialer-logs-{email-or-anon}-v{version}-{datetime}.txt
      // Date is local time stamped into the filename so users can sort
      // multiple exports without opening them.
      const userPart = (email || 'anonymous').replace(/[^a-zA-Z0-9.@-]/g, '_');
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19); // 2026-06-04T14-32-18
      const filename = `ace-dialer-logs-${userPart}-v${APP_VERSION}-${stamp}.txt`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke shortly after the click so we don't leak the blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="settings-section-body diagnostics-settings">
      <p className="muted">
        If your dialer is having trouble — missed calls, calls going to
        voicemail directly, weird disconnect behavior — click <strong>Download
        logs</strong> below and email the file to your dialer admin. The file
        is a plain-text timeline of everything your dialer has been doing
        since you opened the app. We use it to pinpoint exactly what went
        wrong.
      </p>

      <div className="diagnostics-stats">
        <div className="diagnostics-stat">
          <FileText size={14} aria-hidden />
          <span><strong>{bufferSize.toLocaleString()}</strong> log entries captured</span>
        </div>
        <div className="diagnostics-stat">
          <RefreshCw size={14} aria-hidden />
          <span>
            Session started: <strong>{formatRelativeSince(getSessionStartTime())}</strong>
          </span>
        </div>
      </div>

      <div className="diagnostics-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={handleDownload}
          disabled={downloading || bufferSize === 0}
        >
          <Download size={14} />
          Download logs ({bufferSize.toLocaleString()} entries)
        </button>
      </div>

      <p className="muted small" style={{ marginTop: 14 }}>
        The export is a .txt file. No data leaves your computer until you
        attach it to an email yourself. Buffer resets on each app restart —
        so reproduce the issue first, THEN download.
      </p>

      <details className="diagnostics-tail-wrapper" style={{ marginTop: 18 }}>
        <summary className="diagnostics-tail-summary">
          Show live log tail (latest {recent.length} entries)
        </summary>
        <pre className="diagnostics-tail">
          {recent.map((e, i) => (
            <div key={i} className={`diag-line diag-line-${e.level}`}>
              <span className="diag-ts">{e.ts.slice(11, 23)}</span>
              <span className={`diag-lvl diag-lvl-${e.level}`}>
                {e.level.toUpperCase().padEnd(5)}
              </span>
              <span className="diag-src">[{e.source}]</span>
              <span className="diag-msg">{truncateForDisplay(e.message)}</span>
            </div>
          ))}
          {recent.length === 0 && (
            <div className="muted small">No log entries yet — interact with the dialer to see something here.</div>
          )}
        </pre>
      </details>
    </div>
  );
}

/** "Started 3m 12s ago" — humans understand relative durations faster than
 *  ISO timestamps when scanning. */
function formatRelativeSince(iso: string): string {
  const elapsedMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return iso;
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

/** Keep tail readable — multi-line entries (stack traces, full SIP messages)
 *  collapse in the inline view but stay fully captured in the export. */
function truncateForDisplay(s: string): string {
  if (s.length > 200) return s.slice(0, 200) + '… (truncated in preview, full text in download)';
  // Show first line only in the preview if multi-line.
  const firstLine = s.split('\n')[0];
  return firstLine.length < s.length ? firstLine + ' …' : firstLine;
}
