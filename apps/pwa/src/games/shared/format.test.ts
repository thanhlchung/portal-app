import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDay, formatScore } from "./format";

describe("score formatting", () => {
  it("pads to four digits like an arcade marquee", () => {
    assert.equal(formatScore(0), "0000");
    assert.equal(formatScore(7), "0007");
    assert.equal(formatScore(123), "0123");
  });

  it("never truncates a larger score", () => {
    assert.equal(formatScore(12345), "12345");
    assert.equal(formatScore(1_000_000), "1000000");
  });

  it("floors fractions and clamps negatives", () => {
    assert.equal(formatScore(3.9), "0003");
    assert.equal(formatScore(-5), "0000");
  });
});

describe("date formatting", () => {
  it("formats a real timestamp", () => {
    const formatted = formatDay("2026-03-12T10:00:00.000Z");
    assert.match(formatted, /\d/);
    assert.match(formatted, /[A-Za-z\u00C0-\u024F]/);
  });

  it("returns nothing for junk rather than 'Invalid Date'", () => {
    assert.equal(formatDay("not-a-date"), "");
    assert.equal(formatDay(""), "");
  });
});
