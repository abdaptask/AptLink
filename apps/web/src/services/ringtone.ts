// Classic North-American phone ring synthesized via Web Audio API.
// 440 Hz + 480 Hz mixed, 2 seconds on / 4 seconds off, looped.
// No audio asset needed — the SDK can crank it in any browser.

class Ringtone {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private oscs: any[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private playing = false;

  start(): void {
    if (this.playing) return;
    this.playing = true;

    // Lazy-create AudioContext (must happen in a user-gesture-induced path
    // for browsers; React event handlers count, and SDK ring notifications
    // happen within a websocket callback after the user already interacted
    // with the page so we're fine in practice).
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

    const osc1 = ctx.createOscillator();
    osc1.frequency.value = 440;
    osc1.type = 'sine';
    const osc2 = ctx.createOscillator();
    osc2.frequency.value = 480;
    osc2.type = 'sine';
    osc1.connect(this.gain);
    osc2.connect(this.gain);
    osc1.start();
    osc2.start();
    this.oscs = [osc1, osc2];

    // Envelope: 2s ring on, 4s silent, loop.
    const cycle = () => {
      if (!this.playing || !this.gain || !this.ctx) return;
      const now = this.ctx.currentTime;
      // Ring on: ramp up to 0.2 over 20 ms, hold for 2s.
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0, now);
      this.gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
      // Ring off: ramp down at 2s, hold 0 until 6s.
      this.gain.gain.setValueAtTime(0.2, now + 2);
      this.gain.gain.linearRampToValueAtTime(0, now + 2.02);
    };

    cycle();
    // Re-schedule every 6 s.
    this.interval = setInterval(cycle, 6000);
  }

  stop(): void {
    this.playing = false;
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
