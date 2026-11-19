/**
 * A tiny oscillator synth for games whose sounds are just tones.
 *
 * Space Invaders' whole soundtrack is short shaped beeps — the march, shots,
 * hits, the UFO warble — so a general synthesiser is unnecessary and a
 * per-game copy would be pointless. (Asteroids keeps its own `audio.ts`: it
 * needs filtered noise and sustained loops, which are a different problem.)
 *
 * Two browser realities are handled here rather than in each game: an
 * AudioContext starts suspended until a user gesture, and a missing or blocked
 * AudioContext must leave the game playable in silence instead of throwing
 * inside the frame loop.
 */

export type Waveform = "sine" | "square" | "sawtooth" | "triangle";

export class ToneSynth {
  private context: AudioContext | null = null;
  private muted = false;

  /** Create or resume the context. Safe to call on every gesture. */
  unlock(): void {
    if (!this.context) {
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.context = new Ctor();
      } catch {
        this.context = null;
        return;
      }
    }
    if (this.context.state === "suspended") void this.context.resume();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * One shaped beep. `offset` schedules it relative to now, so a two-note
   * flourish is two calls rather than a queue.
   */
  tone(freq: number, duration: number, type: Waveform = "square", volume = 0.15, offset = 0): void {
    const context = this.context;
    if (this.muted || !context) return;

    const start = context.currentTime + offset;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  destroy(): void {
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => undefined);
  }
}
