/**
 * A stub AudioContext that records what a game schedules.
 *
 * The audio layer is testable without a browser, and that is the point: "there
 * is no sound" is indistinguishable from "my phone is muted" unless something
 * proves the game actually asked the audio API to make a noise.
 */

class FakeParam {
  value = 0;
  events: string[] = [];
  setValueAtTime(value: number): this {
    this.value = value;
    this.events.push(`set:${value}`);
    return this;
  }
  exponentialRampToValueAtTime(value: number): this {
    this.events.push(`exp:${value}`);
    return this;
  }
  linearRampToValueAtTime(value: number): this {
    this.events.push(`lin:${value}`);
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
}

export class FakeOscillator {
  type = "sine";
  frequency = new FakeParam();
  started = false;
  stopped = false;
  connect(): this {
    return this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeGain {
  gain = new FakeParam();
  connect(): this {
    return this;
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  oscillators: FakeOscillator[] = [];
  resumeCalls = 0;
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    return new FakeGain();
  }

  createBuffer(_channels: number, length: number): {
    getChannelData(): Float32Array;
  } {
    return { getChannelData: () => new Float32Array(length) };
  }

  createBufferSource(): {
    buffer: unknown;
    connect(): unknown;
    start(): void;
    stop(): void;
  } {
    return { buffer: null, connect: () => ({}), start: () => undefined, stop: () => undefined };
  }

  createBiquadFilter(): {
    type: string;
    frequency: FakeParam;
    connect(): unknown;
  } {
    return { type: "lowpass", frequency: new FakeParam(), connect: () => ({}) };
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/**
 * Install the stub on the (already reset) harness window. Call it inside a test,
 * before the game starts: audio contexts are created lazily on the first
 * gesture, so the game under test must be the one that constructs it.
 */
export function installFakeAudio(): void {
  FakeAudioContext.instances = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const fakeWindow = globals.window as Record<string, unknown> | undefined;
  if (fakeWindow) fakeWindow.AudioContext = FakeAudioContext;
  globals.AudioContext = FakeAudioContext;
}

/** The context a game created when it unlocked audio. */
export function lastAudioContext(): FakeAudioContext {
  const context = FakeAudioContext.instances.at(-1);
  if (!context) throw new Error("no AudioContext was created — did the game unlock audio?");
  return context;
}
