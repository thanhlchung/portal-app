/**
 * A stub DOM and a virtual clock, so a browser game's simulation can be driven
 * from Node.
 *
 * No browser exists on the build machine. Rather than skip testing the parts
 * that only fail at runtime, every engine is driven through this harness: a
 * canvas whose 2d context is a no-op proxy, `requestAnimationFrame` replaced by
 * an explicit `step()`, and `window.setTimeout` backed by a queue the test
 * advances. Time is virtual, so a 400-frame run takes milliseconds and is
 * perfectly repeatable.
 *
 * Shared rather than copied per game: a second game must be testable the same
 * way, and this is the hardest part of the setup to get right.
 */

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

let now = 0;
let frameCallback: ((time: number) => void) | null = null;
let timers: FakeTimer[] = [];
let nextTimerId = 1;

const listeners = new Map<string, Set<() => void>>();

function addListener(type: string, handler: () => void): void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)?.add(handler);
}

function removeListener(type: string, handler: () => void): void {
  listeners.get(type)?.delete(handler);
}

/** Every 2d method is a no-op; every property is settable. */
function fakeContext(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => undefined;
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** A canvas with a real measurable size and a fake 2d context. */
export function fakeCanvas(width = 390, height = 844): HTMLCanvasElement {
  const context = fakeContext();
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement;
}

function installStubs(): void {
  const fakeWindow = {
    devicePixelRatio: 2,
    addEventListener: addListener,
    removeEventListener: removeListener,
    // Audio is exercised through the real class in a browser only; leaving the
    // constructor absent is exactly the "no Web Audio" path.
    AudioContext: undefined,
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
  };

  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: addListener,
    removeEventListener: removeListener,
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = fakeWindow;
  globals.document = fakeDocument;
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    frameCallback = callback;
    return 1;
  };
  globals.cancelAnimationFrame = () => {
    frameCallback = null;
  };
  globals.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

/**
 * Install fresh stubs, reset the clock and forget every registered listener.
 * Call in `beforeEach`, before constructing an engine.
 */
export function resetHarness(): void {
  now = 0;
  frameCallback = null;
  timers = [];
  nextTimerId = 1;
  listeners.clear();
  installStubs();
}

/**
 * Advance the virtual clock, fire due timers, then run one animation frame.
 * Throws if nothing scheduled a frame, which is itself a bug worth catching.
 */
export function step(frames = 1, ms = 16): void {
  for (let index = 0; index < frames; index += 1) {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
    for (const timer of due) timer.fn();

    if (!frameCallback) throw new Error("no frame was scheduled");
    const callback = frameCallback;
    frameCallback = null;
    callback(now);
  }
}

/** How many listeners are attached to a window/document event type. */
export function listenerCount(type: string): number {
  return listeners.get(type)?.size ?? 0;
}
