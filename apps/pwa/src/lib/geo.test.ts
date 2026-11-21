import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyParticipant,
  describeParticipant,
  distanceTo,
  formatAge,
  formatCountdown,
  formatDistance,
  haversineMeters,
  STALE_MS,
} from "./geo";

const SERVER_TIME = "2026-11-21T18:00:00.000Z";

function at(secondsAgo: number): string {
  return new Date(Date.parse(SERVER_TIME) - secondsAgo * 1000).toISOString();
}

describe("haversine", () => {
  it("measures London to Paris at roughly 343 km", () => {
    const distance = haversineMeters({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    assert.ok(distance > 340_000 && distance < 347_000, `got ${distance}`);
  });

  it("is zero for the same point", () => {
    assert.equal(haversineMeters({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
  });
});

describe("participant freshness", () => {
  it("calls recent positions live and old ones stale", () => {
    const fresh = classifyParticipant({ sharing: true, lastAt: at(8) }, SERVER_TIME);
    assert.equal(fresh.state, "live");

    const older = classifyParticipant({ sharing: true, lastAt: at(60) }, SERVER_TIME);
    assert.equal(older.state, "recent");

    const stale = classifyParticipant({ sharing: true, lastAt: at(91) }, SERVER_TIME);
    assert.equal(stale.state, "stale");
  });

  it("never treats a future timestamp as fresher than now", () => {
    const future = classifyParticipant({ sharing: true, lastAt: at(-120) }, SERVER_TIME);
    assert.equal(future.ageMs, 0);
    assert.equal(future.state, "live");
  });

  it("distinguishes paused from waiting for a first fix", () => {
    assert.equal(classifyParticipant({ sharing: false, lastAt: null }, SERVER_TIME).state, "paused");
    assert.equal(classifyParticipant({ sharing: true, lastAt: null }, SERVER_TIME).state, "waiting");
  });

  it("describes a stale participant without implying they are live", () => {
    const sentence = describeParticipant({ sharing: true, lastAt: at(4 * 60) }, SERVER_TIME);
    assert.ok(sentence.startsWith("Last seen 4m"), sentence);
    assert.ok(!sentence.startsWith("Live"));
  });

  it("formats ages in the largest useful unit", () => {
    assert.equal(formatAge(8_000), "8s");
    assert.equal(formatAge(59_000), "59s");
    assert.equal(formatAge(60_000), "1m");
    assert.equal(formatAge(4 * 60_000), "4m");
    assert.equal(formatAge(2 * 3_600_000), "2h");
    assert.equal(formatAge(26 * 3_600_000), "1d");
  });
});

describe("distances", () => {
  it("formats metres, kilometres and tens of kilometres", () => {
    assert.equal(formatDistance(240), "240 m");
    assert.equal(formatDistance(1_240), "1.2 km");
    assert.equal(formatDistance(14_400), "14 km");
  });

  it("returns no distance when either side has no fix", () => {
    assert.equal(distanceTo({ lat: 51.5, lng: -0.1 }, { lat: null, lng: null }), null);
  });

  it("measures a short walk", () => {
    const distance = distanceTo({ lat: 51.5, lng: -0.12 }, { lat: 51.501, lng: -0.12 });
    assert.ok(distance !== null && distance > 100 && distance < 115, `got ${distance}`);
  });
});

describe("countdowns", () => {
  it("counts minutes under an hour", () => {
    assert.equal(formatCountdown(12 * 60_000 + 4_000), "12:04");
  });

  it("adds hours above an hour and never goes negative", () => {
    assert.equal(formatCountdown(3_600_000 + 2 * 60_000 + 3_000), "1:02:03");
    assert.equal(formatCountdown(-5_000), "0:00");
  });

  it("keeps the stale threshold a named constant", () => {
    assert.equal(STALE_MS, 90_000);
  });
});
