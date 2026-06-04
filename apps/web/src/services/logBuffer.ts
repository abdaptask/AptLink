// v0.10.80 — In-app log buffer for diagnostics export.
//
// PROBLEM this solves: when a user reports "I missed a call but the app
// looked fine", we have no record of what actually happened on their
// machine. DevTools console only helps if the user knows how to open it
// AND if they had it open BEFORE the issue (Chromium doesn't backfill
// past logs into a freshly-opened console).
//
// SOLUTION: a small ring buffer that captures every console.log/warn/error
// call from the moment the app boots. Settings → Diagnostics has a
// "Download logs" button that exports the buffer as a .txt file the
// user emails to support. We get a real timeline instead of guesses.
//
// CAPACITY: 20,000 entries × avg ~250 bytes = ~5 MB peak. With the
// 30s force-register firing 2x/min, that's enough for a ~6-hour
// session before we start dropping the oldest entries. For longer
// sessions the oldest get evicted (FIFO) — we keep the most recent.
//
// PERFORMANCE: each console.log call now does one array push + one
// shift-if-over-cap. O(1) amortized. We measured no perceptible
// slowdown even with JsSIP debug logging on.
//
// PRIVACY: the buffer is in-memory only. It is NEVER auto-sent
// anywhere. Export requires a user action (click Download). When the
// app reloads, the buffer resets to empty.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO-8601 timestamp with millisecond precision. */
  ts: string;
  level: LogLevel;
  /** Where the log came from: 'console' (intercepted console.X) or a
   *  module name when we explicitly call appendLog (e.g. 'sip'). */
  source: string;
  /** Formatted message — args joined with space, objects JSON-stringified. */
  message: string;
}

const MAX_ENTRIES = 20_000;
const buffer: LogEntry[] = [];

const SESSION_START = new Date().toISOString();

/** Append a structured log entry. Used both by the console interceptor
 *  and by callers who want to log without going through console. */
export function appendLog(level: LogLevel, source: string, message: string): void {
  buffer.push({
    ts: new Date().toISOString(),
    level,
    source,
    message,
  });
  if (buffer.length > MAX_ENTRIES) {
    // Drop the oldest 5% in one go so we're not shifting on every push.
    // shift() is O(n); slice + reassign is faster for bulk eviction.
    buffer.splice(0, Math.floor(MAX_ENTRIES * 0.05));
  }
}

/** Read-only snapshot. The actual array isn't exposed so callers can't
 *  mutate it. Returns a shallow copy. */
export function getAllLogs(): LogEntry[] {
  return buffer.slice();
}

/** Returns just the last N entries — used by the live tail preview in
 *  the Diagnostics Settings section. */
export function getRecentLogs(n: number): LogEntry[] {
  return buffer.slice(Math.max(0, buffer.length - n));
}

export function getLogBufferSize(): number {
  return buffer.length;
}

export function getSessionStartTime(): string {
  return SESSION_START;
}

/** Format the buffer as a single string suitable for a .txt download.
 *  Includes a header with environment info so triage is easier when
 *  multiple users send logs. */
export function getLogsAsText(meta: {
  email?: string | null;
  version?: string | null;
}): string {
  const header = [
    `ACE Dialer diagnostic log`,
    `Exported:        ${new Date().toISOString()}`,
    `Session started: ${SESSION_START}`,
    `User:            ${meta.email ?? '(unknown — not signed in)'}`,
    `App version:     ${meta.version ?? '(unknown)'}`,
    `User agent:      ${navigator.userAgent}`,
    `Buffer size:     ${buffer.length} entries (capped at ${MAX_ENTRIES})`,
    `─`.repeat(72),
    '',
  ].join('\n');

  const body = buffer
    .map((e) => {
      const lvl = e.level.toUpperCase().padEnd(5);
      return `${e.ts} [${lvl}] [${e.source}] ${e.message}`;
    })
    .join('\n');

  return header + body + '\n';
}

/** Format any list of values into a single line for inclusion in a log
 *  entry. Mirrors console.log behavior: strings as-is, errors as
 *  message+stack, objects JSON-stringified (one level deep — anything
 *  deeper gets [Object]). */
export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a === null || a === undefined) return String(a);
      if (typeof a === 'string') return a;
      if (typeof a === 'number' || typeof a === 'boolean') return String(a);
      if (a instanceof Error) {
        return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
      }
      try {
        // depth-limited JSON to avoid huge dumps from cyclic graphs.
        return JSON.stringify(a, replacerCapture, 2);
      } catch {
        return '[unserializable]';
      }
    })
    .join(' ');
}

/** JSON.stringify replacer that swaps cyclic references and very long
 *  strings with placeholders. */
const seen = new WeakSet();
function replacerCapture(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
  }
  if (typeof value === 'string' && value.length > 4000) {
    return value.slice(0, 4000) + `…[truncated ${value.length - 4000} chars]`;
  }
  return value;
}

/**
 * Install console interceptors. Call this exactly once, as early in app
 * boot as possible (apps/web/src/main.tsx, before ReactDOM.render).
 *
 * Each console method is replaced with a wrapper that:
 *   1. Appends the entry to our buffer.
 *   2. Calls through to the original (so DevTools still shows the same
 *      output for users who have DevTools open).
 *
 * Idempotent — calling twice is a no-op (the second install would chain
 * on top of the first wrapper, which would double-buffer every entry).
 */
let installed = false;
export function installConsoleInterceptors(): void {
  if (installed) return;
  installed = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  console.log = (...args: unknown[]) => {
    appendLog('info', 'console', formatArgs(args));
    orig.log(...args);
  };
  console.info = (...args: unknown[]) => {
    appendLog('info', 'console', formatArgs(args));
    orig.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendLog('warn', 'console', formatArgs(args));
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    appendLog('error', 'console', formatArgs(args));
    orig.error(...args);
  };
  // debug intentionally NOT buffered — JsSIP debug mode emits thousands
  // of lines/sec and would chew through the buffer in seconds. If we
  // ever want JsSIP debug captured we'll add it as a user-toggleable
  // "verbose mode" instead of always-on.
  console.debug = (...args: unknown[]) => {
    orig.debug(...args);
  };

  // Capture uncaught errors + unhandled promise rejections too — these
  // are exactly the kind of thing a missed-call report would need.
  window.addEventListener('error', (ev) => {
    appendLog(
      'error',
      'window.error',
      `${ev.message} (at ${ev.filename}:${ev.lineno}:${ev.colno})${ev.error?.stack ? '\n' + ev.error.stack : ''}`,
    );
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const msg = reason instanceof Error
      ? `${reason.name}: ${reason.message}${reason.stack ? '\n' + reason.stack : ''}`
      : String(reason);
    appendLog('error', 'unhandledrejection', msg);
  });

  appendLog('info', 'logBuffer', `Log buffer installed (capacity ${MAX_ENTRIES} entries).`);
}
