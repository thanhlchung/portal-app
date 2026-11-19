/**
 * Asteroids — canvas simulation.
 *
 * Ported from the original standalone `asteroids.html` with the DOM overlay
 * responsibilities removed: the engine draws *entities* and reports state, and
 * the React shell draws the HUD, menus and game-over panel. That split is what
 * turns a single-file demo into something a component tree can own: the frame
 * loop never touches React, and React never touches simulation state.
 */

import { GameAudio } from "./audio";
import {
  ASTEROID_SIZES,
  BULLET_LIFE,
  BULLET_MAX,
  BULLET_SPD,
  DIFFICULTY,
  EXTRA_LIFE_AT,
  FIRE_CD,
  FLAME_SHAPE,
  ROT_SPEED,
  SHIP_ACCEL,
  SHIP_MAXV,
  SHIP_R,
  SHIP_SHAPE,
  STAR_AREA_PER_STAR,
  STARTING_LIVES,
  TAU,
  UFO_POINTS,
  type AsteroidSize,
  type Point,
} from "./constants";
import type { ControlName, GameEvents, GamePhase, HudState } from "./types";

interface Star {
  x: number;
  y: number;
  size: number;
  twinkle: number;
}

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

interface Asteroid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: AsteroidSize;
  r: number;
  pts: number;
  rot: number;
  rotSpeed: number;
  verts: Point[];
}

interface Ufo {
  x: number;
  y: number;
  vx: number;
  /** Small saucers track the ship; large ones wobble. */
  small: boolean;
  timer: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

interface Ship {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  alive: boolean;
  respawn: number;
  invuln: number;
  thrusting: boolean;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Toroidal space: leaving one edge re-enters on the opposite one. */
function wrapCoord(value: number, maximum: number): number {
  if (maximum <= 0) return 0;
  return ((value % maximum) + maximum) % maximum;
}

function circleHit(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

const KEYMAP: Record<string, ControlName> = {
  ArrowLeft: "left",
  a: "left",
  A: "left",
  ArrowRight: "right",
  d: "right",
  D: "right",
  ArrowUp: "thrust",
  w: "thrust",
  W: "thrust",
  " ": "fire",
  Spacebar: "fire",
};

/** Keys whose default browser behaviour (scrolling, button activation) must not fire. */
const SWALLOWED_KEYS = new Set([" ", "Spacebar", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Keyboard shortcuts must not hijack typing in the nickname field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Elements that already do something on Enter. The game must not start a new
 * run in the same keystroke that presses "Save score".
 */
function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName);
}

function emptyShip(): Ship {
  return {
    x: 0,
    y: 0,
    angle: -Math.PI / 2,
    vx: 0,
    vy: 0,
    alive: false,
    respawn: 0,
    invuln: 0,
    thrusting: false,
  };
}

export class AsteroidsGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly events: GameEvents;
  private readonly audio = new GameAudio();

  private width = 0;
  private height = 0;
  private dpr = 1;
  private stars: Star[] = [];
  private starTime = 0;
  private readonly reduceMotion: boolean;

  private phase: GamePhase = "idle";
  private score = 0;
  private lives = STARTING_LIVES;
  private level = 1;

  private ship: Ship = emptyShip();
  private bullets: Bullet[] = [];
  private asteroids: Asteroid[] = [];
  private ufos: Ufo[] = [];
  private particles: Particle[] = [];

  private fireTimer = 0;
  private ufoTimer = 0;
  private levelBannerTimer = 0;
  private readonly input: Record<ControlName, boolean> = {
    left: false,
    right: false,
    thrust: false,
    fire: false,
  };

  private raf = 0;
  private lastFrame = 0;
  private destroyed = false;
  private readonly timers = new Set<number>();
  private readonly observer: ResizeObserver | null;

  constructor(canvas: HTMLCanvasElement, events: GameEvents = {}) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d canvas context unavailable");

    this.canvas = canvas;
    this.ctx = context;
    this.events = events;
    this.reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("orientationchange", this.handleOrientationChange);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resize()) : null;
    this.observer?.observe(canvas);

    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ------------------------------------------------------------------ API */

  get currentPhase(): GamePhase {
    return this.phase;
  }

  get muted(): boolean {
    return this.audio.isMuted;
  }

  get hud(): HudState {
    return { score: this.score, lives: this.lives, level: this.level };
  }

  /** Begin a run. Safe to call from an overlay button — it resets everything. */
  start(): void {
    this.audio.unlock();
    // A control held when the previous run ended must not carry into this one.
    this.clearInput();
    this.score = 0;
    this.lives = STARTING_LIVES;
    this.level = 1;
    this.ship = emptyShip();
    this.fireTimer = 0;
    this.particles = [];
    this.setPhase("playing");
    this.startLevel();
    this.emitHud();
  }

  pause(): void {
    if (this.phase !== "playing") return;
    this.audio.thrustOff();
    this.audio.saucerOff();
    // The shell hides the touch controls while paused, so any pointer that was
    // down will never report its release. Clearing here is what stops a stuck
    // "thrust" from flying the ship the moment the game resumes.
    this.clearInput();
    this.setPhase("paused");
  }

  resume(): void {
    if (this.phase !== "paused") return;
    this.audio.unlock();
    this.setPhase("playing");
  }

  togglePause(): void {
    if (this.phase === "playing") this.pause();
    else if (this.phase === "paused") this.resume();
  }

  /** Enter / tap on the canvas: start, or resume. */
  primaryAction(): void {
    if (this.phase === "idle" || this.phase === "over") this.start();
    else if (this.phase === "paused") this.resume();
  }

  setInput(name: ControlName, down: boolean): void {
    if (down) this.audio.unlock();
    this.input[name] = down;
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.events.onMutedChange?.(this.audio.isMuted);
  }

  toggleMute(): void {
    this.audio.unlock();
    this.setMuted(!this.audio.isMuted);
  }

  /** Release the canvas, listeners, timers and audio context. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("orientationchange", this.handleOrientationChange);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.observer?.disconnect();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.audio.destroy();
  }

  /* --------------------------------------------------------------- events */

  private setPhase(next: GamePhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.events.onPhaseChange?.(next);
  }

  private emitHud(): void {
    this.events.onHud?.(this.hud);
  }

  private toast(message: string): void {
    this.events.onToast?.(message);
  }

  private schedule(callback: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) callback();
    }, ms);
    this.timers.add(id);
  }

  /* ----------------------------------------------------------------- input */

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    this.audio.unlock();

    if (SWALLOWED_KEYS.has(event.key)) event.preventDefault();

    const control = KEYMAP[event.key];
    if (control) this.input[control] = true;

    if (event.key === "p" || event.key === "P") this.togglePause();
    else if (event.key === "m" || event.key === "M") this.toggleMute();
    else if (event.key === "Enter") {
      // A focused button already activates on Enter; restarting the run at the
      // same time would fight the button the user just pressed.
      if (isActivationTarget(event.target)) return;
      this.primaryAction();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const control = KEYMAP[event.key];
    if (control) this.input[control] = false;
  };

  /** Losing focus mid-press otherwise leaves thrust or fire held down forever. */
  private handleBlur = (): void => {
    this.clearInput();
    this.audio.thrustOff();
  };

  /** Coming back from another app should not cost a life in the meantime. */
  private handleVisibility = (): void => {
    if (document.visibilityState === "hidden" && this.phase === "playing") this.pause();
  };

  private clearInput(): void {
    this.input.left = false;
    this.input.right = false;
    this.input.thrust = false;
    this.input.fire = false;
  }

  private handleResize = (): void => {
    this.resize();
  };

  private handleOrientationChange = (): void => {
    // iOS reports the pre-rotation viewport for a frame or two.
    this.schedule(() => this.resize(), 140);
  };

  /* --------------------------------------------------------------- sizing */

  private resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    // An unmeasured canvas (display:none, before layout) would divide by zero
    // and produce NaN entity positions that never recover.
    if (rect.width < 1 || rect.height < 1) return;

    const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    this.dpr = Math.min(devicePixelRatio, 2.5);
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.makeStars();
  }

  private makeStars(): void {
    const count = Math.max(30, Math.floor((this.width * this.height) / STAR_AREA_PER_STAR));
    this.stars = [];
    for (let i = 0; i < count; i += 1) {
      this.stars.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        size: rand(0.4, 1.6),
        twinkle: Math.random() * TAU,
      });
    }
  }

  /* ------------------------------------------------------------ game state */

  private spawnShip(): void {
    this.ship.x = this.width / 2;
    this.ship.y = this.height / 2;
    this.ship.vx = 0;
    this.ship.vy = 0;
    this.ship.angle = -Math.PI / 2;
    this.ship.alive = true;
    this.ship.invuln = 2.2;
    this.ship.respawn = 0;
    this.ship.thrusting = false;
  }

  private asteroidVerts(radius: number): Point[] {
    const count = randInt(10, 14);
    const verts: Point[] = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * TAU;
      const r = radius * rand(0.66, 1.18);
      verts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    return verts;
  }

  private createAsteroid(x: number, y: number, size: AsteroidSize): Asteroid {
    const spec = ASTEROID_SIZES[size];
    const speed = DIFFICULTY.baseVel + (this.level - 1) * DIFFICULTY.velPerLvl;
    const velocity = rand(-1, 1) * speed;
    const asteroid: Asteroid = {
      x,
      y,
      vx: velocity,
      vy: rand(-1, 1) * speed,
      size,
      r: spec.r,
      pts: spec.pts,
      rot: rand(0, TAU),
      rotSpeed: rand(-1, 1) * (DIFFICULTY.baseRot + (this.level - 1) * DIFFICULTY.rotPerLvl),
      verts: this.asteroidVerts(spec.r),
    };

    // A rock that drifts almost nowhere is a stationary target: enforce a floor.
    const drift = Math.hypot(asteroid.vx, asteroid.vy);
    if (drift < 40) {
      if (drift < 0.001) {
        // Both axes landed on exactly zero, where scaling by 40/drift would
        // produce NaN positions. Pick a direction instead of dividing by zero.
        asteroid.vx = rand(0.4, 1) * 40 * (Math.random() < 0.5 ? -1 : 1);
        asteroid.vy = rand(-1, 1) * 40;
      } else {
        const factor = 40 / drift;
        asteroid.vx *= factor;
        asteroid.vy *= factor;
      }
    }
    return asteroid;
  }

  private startLevel(): void {
    this.bullets = [];
    this.ufos = [];
    this.particles = [];
    this.ufoTimer = rand(12, 20);
    this.audio.saucerOff();

    // Keep a surviving ship where the player left it (classic arcade behaviour),
    // and only respawn when the previous life was actually lost.
    if (!this.ship.alive && this.ship.respawn <= 0) this.spawnShip();

    this.asteroids = [];
    const count = Math.min(
      DIFFICULTY.baseCount + (this.level - 1) * DIFFICULTY.countPerLvl,
      DIFFICULTY.maxCount,
    );
    const cx = this.width / 2;
    const cy = this.height / 2;
    const minDistance = Math.min(this.width, this.height) / 2 + ASTEROID_SIZES.large.r + 30;

    for (let i = 0; i < count; i += 1) {
      let x = 0;
      let y = 0;
      let tries = 0;
      do {
        x = rand(-ASTEROID_SIZES.large.r, this.width + ASTEROID_SIZES.large.r);
        y = rand(-ASTEROID_SIZES.large.r, this.height + ASTEROID_SIZES.large.r);
        tries += 1;
      } while (Math.hypot(x - cx, y - cy) < minDistance && tries < 50);
      this.asteroids.push(this.createAsteroid(x, y, "large"));
    }

    this.levelBannerTimer = 2;
  }

  private addScore(points: number): void {
    const before = Math.floor(this.score / EXTRA_LIFE_AT);
    this.score += points;
    if (Math.floor(this.score / EXTRA_LIFE_AT) > before) {
      this.lives += 1;
      this.toast("EXTRA SHIP!");
    }
    this.emitHud();
  }

  private spawnBurst(
    x: number,
    y: number,
    color: string,
    count: number,
    speed: number,
    life: number,
  ): void {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TAU;
      const magnitude = rand(speed * 0.25, speed);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        life: rand(life * 0.5, life),
        maxLife: life,
        color,
      });
    }
  }

  private spawnUfo(): void {
    const fromLeft = Math.random() < 0.5;
    const baseSpeed = this.level < 4 ? 95 : this.level < 7 ? 125 : 155;
    this.ufos.push({
      x: fromLeft ? -30 : this.width + 30,
      y: rand(this.height * 0.16, this.height * 0.82),
      vx: baseSpeed * (Math.random() < 0.4 ? -1 : 1),
      small: Math.random() < clamp((this.level - 1) * 0.12, 0, 0.65),
      timer: rand(0.5, 1.4),
    });
    this.audio.saucerOn();
  }

  private fireBullet(): void {
    if (this.bullets.length >= BULLET_MAX) return;
    const cos = Math.cos(this.ship.angle);
    const sin = Math.sin(this.ship.angle);
    this.bullets.push({
      x: this.ship.x + cos * (SHIP_R + 4),
      y: this.ship.y + sin * (SHIP_R + 4),
      vx: this.ship.vx + cos * BULLET_SPD,
      vy: this.ship.vy + sin * BULLET_SPD,
      life: BULLET_LIFE,
    });
    this.audio.shoot();
  }

  private ufoShoot(ufo: Ufo): void {
    if (!this.ship.alive) return;
    const wobble = ufo.small
      ? rand(-0.06, 0.06)
      : Math.random() < 0.5
        ? rand(-0.5, 0.5)
        : rand(-0.25, 0.25);
    const angle = Math.atan2(this.ship.y - ufo.y, this.ship.x - ufo.x) + wobble;
    this.bullets.push({
      x: ufo.x,
      y: ufo.y,
      vx: Math.cos(angle) * BULLET_SPD * 0.85,
      vy: Math.sin(angle) * BULLET_SPD * 0.85,
      life: BULLET_LIFE + 0.4,
    });
    this.audio.shoot();
  }

  private destroyAsteroid(asteroid: Asteroid, index: number): void {
    this.addScore(asteroid.pts);
    this.audio.explosion(asteroid.size === "large");
    this.spawnBurst(
      asteroid.x,
      asteroid.y,
      "#cfe8d8",
      asteroid.size === "large" ? 26 : asteroid.size === "medium" ? 16 : 10,
      asteroid.size === "large" ? 260 : 200,
      asteroid.size === "large" ? 0.6 : 0.45,
    );
    this.asteroids.splice(index, 1);
    if (asteroid.size === "large") {
      this.asteroids.push(
        this.createAsteroid(asteroid.x, asteroid.y, "medium"),
        this.createAsteroid(asteroid.x, asteroid.y, "medium"),
      );
    } else if (asteroid.size === "medium") {
      this.asteroids.push(
        this.createAsteroid(asteroid.x, asteroid.y, "small"),
        this.createAsteroid(asteroid.x, asteroid.y, "small"),
      );
    }
  }

  private destroyUfo(ufo: Ufo, index: number): void {
    this.addScore(ufo.small ? UFO_POINTS.small : UFO_POINTS.large);
    this.audio.explosion(false);
    this.spawnBurst(ufo.x, ufo.y, "#ffb37c", 20, 220, 0.5);
    this.ufos.splice(index, 1);
    this.audio.saucerOff();
  }

  private hitShip(): void {
    this.spawnBurst(this.ship.x, this.ship.y, "#cfe8d8", 30, 260, 0.6);
    this.audio.explosion(false);
    this.lives -= 1;
    this.emitHud();
    this.ship.alive = false;
    this.ship.thrusting = false;
    this.audio.thrustOff();

    if (this.lives <= 0) {
      // A short beat before the panel appears, so the explosion is visible.
      this.schedule(() => this.finishRun(), 180);
    } else {
      this.ship.respawn = 1.6;
    }
  }

  private finishRun(): void {
    // Not gated on `playing`: the end of a run is already scheduled when the
    // last life is lost, and pausing during that 180 ms must not strand the
    // shell without a game-over panel.
    if (this.phase === "over") return;
    this.audio.thrustOff();
    this.audio.saucerOff();
    // The controls disappear with the game-over panel, taking any pointer-up
    // with them; drop the held state rather than carrying it into the next run.
    this.clearInput();
    this.setPhase("over");
    this.events.onGameOver?.({ score: this.score, level: this.level });
  }

  /* --------------------------------------------------------------- update */

  private frame = (now: number): void => {
    if (this.destroyed) return;
    const previous = this.lastFrame || now;
    let dt = (now - previous) / 1000;
    this.lastFrame = now;
    // A backgrounded tab resumes with a huge delta; clamping keeps physics same.
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;

    if (this.levelBannerTimer > 0) this.levelBannerTimer -= dt;

    this.starTime += dt;
    if (this.phase === "playing") this.updatePlaying(dt);

    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private updatePlaying(dt: number): void {
    const ship = this.ship;

    if (this.input.left) ship.angle -= ROT_SPEED * dt;
    if (this.input.right) ship.angle += ROT_SPEED * dt;

    ship.thrusting = this.input.thrust && ship.alive && ship.invuln <= 0;
    if (ship.thrusting) {
      ship.vx += Math.cos(ship.angle) * SHIP_ACCEL * dt;
      ship.vy += Math.sin(ship.angle) * SHIP_ACCEL * dt;
      this.audio.thrustOn();
    } else {
      this.audio.thrustOff();
    }

    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > SHIP_MAXV) {
      const factor = SHIP_MAXV / speed;
      ship.vx *= factor;
      ship.vy *= factor;
    }

    ship.x = wrapCoord(ship.x + ship.vx * dt, this.width);
    ship.y = wrapCoord(ship.y + ship.vy * dt, this.height);
    if (ship.invuln > 0) ship.invuln -= dt;
    if (ship.respawn > 0) {
      ship.respawn -= dt;
      if (ship.respawn <= 0 && !ship.alive) this.spawnShip();
    }

    if (this.input.fire && ship.alive) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.fireBullet();
        this.fireTimer = FIRE_CD;
      }
    } else {
      // Reset so the next press fires immediately rather than after a cooldown.
      this.fireTimer = 0;
    }

    for (let i = this.bullets.length - 1; i >= 0; i -= 1) {
      const bullet = this.bullets[i];
      if (!bullet) continue;
      bullet.x = wrapCoord(bullet.x + bullet.vx * dt, this.width);
      bullet.y = wrapCoord(bullet.y + bullet.vy * dt, this.height);
      bullet.life -= dt;
      if (bullet.life <= 0) this.bullets.splice(i, 1);
    }

    for (const asteroid of this.asteroids) {
      asteroid.x = wrapCoord(asteroid.x + asteroid.vx * dt, this.width);
      asteroid.y = wrapCoord(asteroid.y + asteroid.vy * dt, this.height);
      asteroid.rot += asteroid.rotSpeed * dt;
    }

    for (const ufo of this.ufos) {
      ufo.x = wrapCoord(ufo.x + ufo.vx * dt, this.width);
      ufo.timer -= dt;
      if (ufo.timer <= 0) {
        ufo.timer = rand(0.7, 1.6);
        this.ufoShoot(ufo);
      }
    }

    this.ufoTimer -= dt;
    if (this.ufoTimer <= 0 && this.ufos.length < 1 && ship.alive) {
      this.spawnUfo();
      this.ufoTimer = rand(14, 24);
    }

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      if (!particle) continue;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt;
      particle.vx *= 0.985;
      particle.vy *= 0.985;
      if (particle.life <= 0) this.particles.splice(i, 1);
    }

    if (ship.alive && ship.invuln <= 0) {
      for (let i = this.asteroids.length - 1; i >= 0; i -= 1) {
        const asteroid = this.asteroids[i];
        if (
          asteroid &&
          circleHit(ship.x, ship.y, SHIP_R, asteroid.x, asteroid.y, asteroid.r * 0.86)
        ) {
          this.hitShip();
          break;
        }
      }
      if (ship.alive && ship.invuln <= 0) {
        for (let i = this.ufos.length - 1; i >= 0; i -= 1) {
          const ufo = this.ufos[i];
          if (ufo && circleHit(ship.x, ship.y, SHIP_R, ufo.x, ufo.y, 17)) {
            this.hitShip();
            break;
          }
        }
      }
    }

    for (let b = this.bullets.length - 1; b >= 0; b -= 1) {
      const bullet = this.bullets[b];
      if (!bullet) continue;
      let hit = -1;
      for (let i = this.asteroids.length - 1; i >= 0; i -= 1) {
        const asteroid = this.asteroids[i];
        if (
          asteroid &&
          circleHit(bullet.x, bullet.y, 4, asteroid.x, asteroid.y, asteroid.r * 0.86)
        ) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) {
        const asteroid = this.asteroids[hit];
        this.bullets.splice(b, 1);
        if (asteroid) this.destroyAsteroid(asteroid, hit);
      }
    }

    for (let b = this.bullets.length - 1; b >= 0; b -= 1) {
      const bullet = this.bullets[b];
      if (!bullet) continue;
      for (let i = this.ufos.length - 1; i >= 0; i -= 1) {
        const ufo = this.ufos[i];
        if (ufo && circleHit(bullet.x, bullet.y, 4, ufo.x, ufo.y, 17)) {
          this.bullets.splice(b, 1);
          this.destroyUfo(ufo, i);
          break;
        }
      }
    }

    // Wave cleared. Not while the last life is being lost: a run that is about
    // to end must not spawn a fresh ship and a new wave in the same frame.
    if (this.asteroids.length === 0 && this.phase === "playing" && this.lives > 0) {
      this.level += 1;
      this.startLevel();
      this.emitHud();
    }
  }

  /* ----------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawStars();

    // Menus and the game-over panel are DOM overlays; the engine keeps drawing
    // only the starfield behind them.
    if (this.phase === "idle" || this.phase === "over") return;

    this.drawShip();
    for (const asteroid of this.asteroids) this.drawAsteroid(asteroid);
    for (const ufo of this.ufos) this.drawUfo(ufo);
    for (const bullet of this.bullets) this.drawBullet(bullet);
    this.drawParticles();

    if (this.levelBannerTimer > 0) this.drawLevelBanner();
  }

  private drawStars(): void {
    const { ctx } = this;
    ctx.save();
    for (const star of this.stars) {
      const twinkle = this.reduceMotion
        ? 0.6
        : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.starTime * 2 + star.twinkle));
      ctx.globalAlpha = twinkle * 0.6;
      ctx.fillStyle = "rgba(180,220,210,1)";
      ctx.fillRect(star.x, star.y, star.size, star.size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawShip(): void {
    const { ctx, ship } = this;
    if (!ship.alive) return;
    // Invulnerability flashes: the ship is briefly drawn every other ~80 ms.
    if (ship.invuln > 0 && Math.floor(ship.invuln * 12) % 2 === 0) return;

    const angle = ship.angle + Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#d6f5e3";

    if (ship.thrusting) {
      const flick = rand(0.7, 1);
      ctx.beginPath();
      FLAME_SHAPE.forEach((point, index) => {
        const x = point.x * cos - point.y * sin;
        const y = (point.x * sin + point.y * cos) * flick;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "rgba(255,178,110,.9)";
      ctx.stroke();
      ctx.strokeStyle = "#d6f5e3";
    }

    ctx.beginPath();
    SHIP_SHAPE.forEach((point, index) => {
      const x = point.x * cos - point.y * sin;
      const y = point.x * sin + point.y * cos;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawAsteroid(asteroid: Asteroid): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(asteroid.x, asteroid.y);
    ctx.rotate(asteroid.rot);
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#b9d4c4";
    ctx.beginPath();
    asteroid.verts.forEach((vert, index) => {
      if (index === 0) ctx.moveTo(vert.x, vert.y);
      else ctx.lineTo(vert.x, vert.y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawUfo(ufo: Ufo): void {
    const { ctx } = this;
    const color = ufo.small ? "#ffb37c" : "#e8b0d8";
    ctx.save();
    ctx.translate(ufo.x, ufo.y);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(0, -2, 9, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 2, 17, 8, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = color;
    for (let i = 0; i < 3; i += 1) ctx.fillRect(-11 + i * 11 - 2, 8, 4, 3);
    ctx.restore();
  }

  private drawBullet(bullet: Bullet): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.fillStyle = "#eafcff";
    ctx.shadowColor = "rgba(180,245,255,.9)";
    ctx.shadowBlur = 8;
    ctx.fillRect(-1.5, -1.5, 3, 3);
    ctx.restore();
  }

  private drawParticles(): void {
    const { ctx } = this;
    ctx.save();
    for (const particle of this.particles) {
      ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x - 1.5, particle.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawLevelBanner(): void {
    const { ctx } = this;
    // Scales with the smaller viewport edge so it fits a phone in landscape.
    const size = clamp(Math.min(this.width, this.height) * 0.1, 26, 48);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#7cf5c1";
    ctx.shadowColor = "rgba(124,245,193,.5)";
    ctx.shadowBlur = 18;
    ctx.font = `600 ${size}px ui-monospace, monospace`;
    ctx.fillText(`LEVEL ${this.level}`, this.width / 2, this.height * 0.26);
    ctx.restore();
  }
}
