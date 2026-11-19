/**
 * Web Audio sound effects, ported from the original single-file game.
 *
 * Two things worth keeping in mind:
 * - Browsers start an AudioContext suspended until a user gesture. `unlock()`
 *   is called from the play button and from any control press, which is the
 *   gesture that permits sound.
 * - A failed AudioContext (unsupported browser, blocked, out of contexts) is
 *   non-fatal: the game must stay playable silently rather than throw inside
 *   the animation loop.
 */

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;

  private thrustOsc: OscillatorNode | null = null;
  private thrustFilter: BiquadFilterNode | null = null;
  private thrustGain: GainNode | null = null;

  private saucerOscA: OscillatorNode | null = null;
  private saucerOscB: OscillatorNode | null = null;
  private saucerGain: GainNode | null = null;
  private saucerSweep: number | null = null;

  /** Create or resume the context. Safe to call repeatedly. */
  unlock(): void {
    this.init();
    if (this.context?.state === "suspended") void this.context.resume();
  }

  private init(): void {
    if (this.context) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;

      const context = new Ctor();
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(context.destination);

      const length = Math.floor(context.sampleRate * 1);
      this.noise = context.createBuffer(1, length, context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      this.context = null;
      this.master = null;
      this.noise = null;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  shoot(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const t = context.currentTime;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(980, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  explosion(big: boolean): void {
    const context = this.context;
    const master = this.master;
    const noise = this.noise;
    if (!context || !master || !noise) return;
    const t = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    const duration = big ? 0.6 : 0.4;
    filter.frequency.setValueAtTime(big ? 950 : 850, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + duration);

    const gain = context.createGain();
    gain.gain.setValueAtTime(big ? 0.5 : 0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + duration + 0.05);
  }

  thrustOn(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || this.thrustOsc) return;
    const t = context.currentTime;

    const osc = context.createOscillator();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.07, t + 0.05);

    osc.type = "sawtooth";
    osc.frequency.value = 70;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(t);

    this.thrustOsc = osc;
    this.thrustFilter = filter;
    this.thrustGain = gain;
  }

  thrustOff(): void {
    const context = this.context;
    const osc = this.thrustOsc;
    const gain = this.thrustGain;
    if (!context || !osc || !gain) return;

    const t = context.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.06);
    window.setTimeout(() => {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
    }, 80);

    this.thrustOsc = null;
    this.thrustFilter = null;
    this.thrustGain = null;
  }

  saucerOn(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || this.saucerOscA) return;
    const t = context.currentTime;

    const oscA = context.createOscillator();
    const oscB = context.createOscillator();
    const gain = context.createGain();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = 320;
    oscB.frequency.value = 384;
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.045, t + 0.4);

    oscA.connect(gain);
    oscB.connect(gain);
    gain.connect(master);
    oscA.start(t);
    oscB.start(t);

    this.saucerOscA = oscA;
    this.saucerOscB = oscB;
    this.saucerGain = gain;
    this.saucerSweep = window.setInterval(() => {
      if (!this.saucerOscA) return;
      const base = 300 + Math.random() * 60;
      this.saucerOscA.frequency.setTargetAtTime(base, context.currentTime, 0.35);
      this.saucerOscB?.frequency.setTargetAtTime(base * 1.2, context.currentTime, 0.35);
    }, 400);
  }

  saucerOff(): void {
    const context = this.context;
    const oscA = this.saucerOscA;
    const oscB = this.saucerOscB;
    const gain = this.saucerGain;
    if (!context || !oscA || !oscB || !gain) return;

    const t = context.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.25);

    if (this.saucerSweep !== null) {
      window.clearInterval(this.saucerSweep);
      this.saucerSweep = null;
    }
    window.setTimeout(() => {
      try {
        oscA.stop();
        oscB.stop();
      } catch {
        // Already stopped.
      }
    }, 350);

    this.saucerOscA = null;
    this.saucerOscB = null;
    this.saucerGain = null;
  }

  /** Silence everything and release the context (a route change may never come back). */
  destroy(): void {
    this.thrustOff();
    this.saucerOff();
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noise = null;
    if (context) void context.close().catch(() => undefined);
  }
}
