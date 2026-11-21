/**
 * Tests for the shared audio layer.
 *
 * A silent portal is the kind of failure no amount of engine testing catches, so
 * this proves the layer actually asks the audio API for sound — and that it
 * recovers when the browser suspends the context.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FakeAudioContext, installFakeAudio, lastAudioContext } from "./fakeAudio";
import { resetHarness } from "./testHarness";
import { ToneSynth } from "./toneSynth";

let synth: ToneSynth;

beforeEach(() => {
  resetHarness();
  synth = new ToneSynth();
});

afterEach(() => {
  synth.destroy();
});

describe("tone synth", () => {
  it("makes no sound before a user gesture unlocks it", () => {
    synth.tone(440, 0.1);
    assert.equal(FakeAudioContext.instances.length, 0, "no context should be created yet");
  });

  it("creates and resumes the context on unlock", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    assert.equal(context.resumeCalls, 1, "a fresh context starts suspended and must be resumed");
    assert.equal(context.state, "running");
  });

  it("schedules a tone with the requested frequency", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    synth.tone(440, 0.1, "square", 0.2);

    assert.equal(context.oscillators.length, 1);
    const oscillator = context.oscillators[0]!;
    assert.equal(oscillator.type, "square");
    assert.equal(oscillator.frequency.value, 440);
    assert.ok(oscillator.started, "the tone must be started");
    assert.ok(oscillator.stopped, "the tone must be scheduled to stop");
  });

  it("silences a muted synth", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    synth.setMuted(true);
    synth.tone(440, 0.1);
    assert.equal(context.oscillators.length, 0);
  });

  it("beeps when unmuted, so a player can tell sound works", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    synth.setMuted(true);
    const before = context.oscillators.length;
    synth.setMuted(false);
    assert.equal(context.oscillators.length, before + 1, "unmuting should play a confirmation");
  });

  it("re-resumes a context the browser suspended mid-session", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    // The browser suspends audio when a tab is backgrounded or a call arrives.
    context.state = "suspended";
    const before = context.resumeCalls;

    synth.tone(440, 0.1);

    assert.equal(context.resumeCalls, before + 1, "each sound should retry the resume");
    assert.ok(context.oscillators.length > 0, "and still play when the context comes back");
  });

  it("closes the context on destroy", () => {
    installFakeAudio();
    synth.unlock();
    const context = lastAudioContext();
    synth.destroy();
    assert.ok(context.closed);
  });
});
