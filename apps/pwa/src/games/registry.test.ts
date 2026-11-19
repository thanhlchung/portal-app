/**
 * Registry and route-matching tests.
 *
 * These guard the two ways the games hub can rot silently: a game added to the
 * registry but not to the shared slug list (so the server rejects its board),
 * and a route pattern that stops matching the URL the app actually links to.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GAME, GAME_SLUGS, findGame, games } from "./registry";
import { matchPath } from "../lib/router";

describe("game registry", () => {
  it("uses URL-safe slugs", () => {
    for (const game of games) {
      assert.match(game.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${game.slug} is not URL-safe`);
    }
  });

  it("registers each game exactly once", () => {
    const slugs = games.map((game) => game.slug);
    assert.equal(new Set(slugs).size, slugs.length, "duplicate slug in the registry");
  });

  it("keeps the registry and the shared slug list in step", () => {
    // slugs.ts is what the API's tests import to prove the server accepts a
    // board for every game the client can play. If they drift, that check is
    // worthless — or worse, a game ships with a board that 404s.
    assert.deepEqual([...games.map((game) => game.slug)].sort(), [...GAME_SLUGS].sort());
  });

  it("has a default game that exists", () => {
    assert.ok(GAME_SLUGS.includes(DEFAULT_GAME));
  });

  it("resolves known slugs and rejects everything else", () => {
    const asteroids = findGame("asteroids");
    assert.equal(asteroids?.slug, "asteroids");
    assert.ok(asteroids?.title);
    assert.ok(asteroids?.blurb);
    assert.equal(findGame("doom"), undefined);
    assert.equal(findGame(""), undefined);
    assert.equal(findGame(undefined), undefined);
  });
});

describe("route matching", () => {
  it("matches a game URL", () => {
    assert.deepEqual(matchPath("/play/:slug", "/play/asteroids"), { slug: "asteroids" });
    assert.deepEqual(matchPath("/play/:slug", "/play/space-invaders"), { slug: "space-invaders" });
  });

  it("matches a game board URL", () => {
    assert.deepEqual(matchPath("/play/:slug/scores", "/play/asteroids/scores"), {
      slug: "asteroids",
    });
  });

  it("does not match a different depth", () => {
    // The board pattern must not swallow "/play/asteroids"...
    assert.equal(matchPath("/play/:slug/scores", "/play/asteroids"), null);
    // ...and the play pattern must not swallow the board route.
    assert.equal(matchPath("/play/:slug", "/play/asteroids/scores"), null);
  });

  it("does not match unrelated or truncated paths", () => {
    assert.equal(matchPath("/play/:slug", "/play"), null);
    assert.equal(matchPath("/play/:slug", "/"), null);
    assert.equal(matchPath("/play/:slug", "/play/asteroids/extra"), null);
    assert.equal(matchPath("/play/:slug/scores", "/scores"), null);
  });

  it("decodes percent-escaped segments", () => {
    assert.deepEqual(matchPath("/play/:slug", "/play/space%2Dinvaders"), {
      slug: "space-invaders",
    });
  });
});
