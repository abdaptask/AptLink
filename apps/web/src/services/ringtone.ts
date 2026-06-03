// v0.10.75 — Ringtone presets (synthesized via Web Audio API, no audio
// assets needed). User picks one in Settings → Personal → Ringtone;
// preference persists on User.ringtone server-side.
//
// Each preset is just a set of synthesis parameters: which oscillators
// to mix, their frequencies + waveform, the on/off cadence, the
// envelope shape. The runtime engine reads the preset and schedules
// gain ramps accordingly.
//
// Available presets:
//   - 'classic' (default): N. American 440+480Hz sine, 2s on / 4s off
//   - 'modern':            higher-pitched 700+900Hz sine, 1s on / 2s off
//   - 'chime':             single 880Hz triangle, slow swell 0.6s, 3s off
//   - 'pulse':             low 220Hz square pulse, 0.3s on / 0.7s off (fast)
//
// Adding a new preset is just appending an entry to PRESETS below + adding
// it to the type union + updating the picker UI.

import { getNotificationPrefs } from '../lib/userPrefs';

export type RingtoneSlug = 'classic' | 'modern' | 'chime' | 'pulse';

export interface RingtonePresetDef {
  /** Each oscillator gets a frequency + waveform. Stacked = mixed in. */
  oscs: Array<{ freq: number; type: OscillatorType }>;
  /** Seconds the ringtone is audibly active per cycle. */
  onSec: number;
  /** Total cycle length (on + silence). Must be > onSec. */
  cycleSec: number;
  /** Attack ramp (s) — how fast it fades in at the start of "on". */
  attackSec: number;
  /** Release ramp (s) — how fast it fades out at the end of "on". */
  releaseSec: number;
  /** Peak gain (0..1). Volume slider scales this further. */
  peak: number;
  /** Human label for the picker UI. */
  label: string;
  /** One-line description for the picker UI. */
  hint: string;
}

const PRESETS: Record<RingtoneSlug, RingtonePresetDef> = {
  classic: {
    oscs: [
      { freq: 440, type: 'sine' },
      { freq: 480, type: 'sine' },
    ],
    onSec: 2,
    cycleSec: 6,
    attackSec: 0.02,
    releaseSec: 0.02,
    peak: 0.4,
    label: 'Classic',
    hint: 'Standard North American phone ring (440+480 Hz)',
  },
  modern: {
    oscs: [
      { freq: 700, type: 'sine' },
      { freq: 900, type: 'sine' },
    ],
    onSec: 1,
    cycleSec: 3,
    attackSec: 0.02,
    releaseSec: 0.05,
    peak: 0.35,
    label: 'Modern',
    hint: 'Brighter, faster — like a modern smartphone',
  },
  chime: {
    oscs: [
      { freq: 880, type: 'triangle' },
    ],
    onSec: 0.6,
    cycleSec: 4,
    attackSec: 0.15,
    releaseSec: 0.35,
    peak: 0.3,
    label: 'Chime',
    hint: 'Single soft swell — least intrusive',
  },
  pulse: {
    oscs: [
      { freq: 220, type: 'square' },
    ],
    onSec: 0.3,
    cycleSec: 1.0,
    attackSec: 0.01,
    releaseSec: 0.05,
    peak: 0.25,
    label: 'Pulse',
    hint: 'Low + fast — for noisy environments',
  },
};

export const DEFAULT_RINGTONE: RingtoneSlug = 'classic';

export function getRingtonePresets(): Array<{ slug: RingtoneSlug; label: string; hint: string }> {
  return (Object.keys(PRESETS) as RingtoneSlug[]).map((slug) => ({
    slug,
    label: PRESETS[slug].label,
    hint: PRESETS[slug].hint,
  }));
}

/**
 * Read the current user's saved ringtone from sessionStorage. Falls back
 * to the default when nothing is saved (new user, or v0.10.74-and-older
 * client that didn't persist the field).
 */
export function getCurrentRingtoneSlug(): RingtoneSlug {
  try {
    const v = sessionStorage.getItem('ace_ringtone') as RingtoneSlug | null;
    if (v && PRESETS[v]) return v;
  } catch { /* noop */ }
  return DEFAULT_RINGTONE;
}

class Ringtone {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private oscs: any[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  /** When non-null, auto-stops after this many ms (used for previews). */
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the ringtone. Pass a slug to play that specific preset; omit to
   * use the current user's saved choice. Pass durationMs to auto-stop
   * after a given duration (for previews).
   */
  start(slug?: RingtoneSlug, durationMs?: number): void {
    if (this.playing) this.stop();

    // Honour user notification prefs — silent if ringtone disabled.
    const prefs = getNotificationPrefs();
    if (!prefs.ringtone) return;

    const presetSlug = slug ?? getCurrentRingtoneSlug();
    const preset = PRESETS[presetSlug] ?? PRESETS[DEFAULT_RINGTONE];

    this.playing = true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      this.ctx = new Ctor();
    } catch (e) {
      console.warn('[ringtone] AudioContext unavailable', e);
      this.playing = false;
      return;
    }

    const ctx = this.ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(ctx.destination);

    // Build all the oscillators for this preset.
    for (const o of preset.oscs) {
      const osc = ctx.createOscillator();
      osc.frequency.value = o.freq;
      osc.type = o.type;
      osc.connect(this.gain);
      osc.start();
      this.oscs.push(osc);
    }

    // Schedule the gain envelope once per cycle. Re-armed every cycleSec.
    const cycle = () => {
      if (!this.playing || !this.gain || !this.ctx) return;
      const vol = Math.max(0, Math.min(1, getNotificationPrefs().ringtoneVolume));
      const peak = preset.peak * vol;
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0, now);
      // Attack: 0 → peak over attackSec
      this.gain.gain.linearRampToValueAtTime(peak, now + preset.attackSec);
      // Sustain at peak until the release window
      this.gain.gain.setValueAtTime(peak, now + preset.onSec - preset.releaseSec);
      // Release: peak → 0 over releaseSec
      this.gain.gain.linearRampToValueAtTime(0, now + preset.onSec);
    };

    cycle();
    this.interval = setInterval(cycle, preset.cycleSec * 1000);

    // Auto-stop for previews.
    if (typeof durationMs === 'number' && durationMs > 0) {
      this.autoStopTimer = setTimeout(() => this.stop(), durationMs);
    }
  }

  stop(): void {
    this.playing = false;
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.gain && this.ctx) {
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + 0.05);
    }
    for (const o of this.oscs) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        // already stopped
      }
    }
    this.oscs = [];
    if (this.gain) {
      try { this.gain.disconnect(); } catch { /* noop */ }
      this.gain = null;
    }
    if (this.ctx) {
      try { void this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
    }
  }
}

export const ringtone = new Ringtone();
