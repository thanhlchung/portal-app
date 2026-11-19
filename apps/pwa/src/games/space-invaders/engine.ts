/**
 * Space Invaders — canvas simulation.
 *
 * Ported from the original standalone `space_invaders.html`. Two deliberate
 * differences from that file, both because the shared arcade shell now owns the
 * surrounding furniture:
 *
 * 1. **HUD, menus, pause and game-over screens are the shell's.** The engine
 *    draws the playfield, the level banner and the score popups; the score /
 *    level / lives readout is DOM, and the high score is the server-side board
 *    rather than `localStorage`.
 * 2. **No drag-to-steer.** The shell renders hold-to-press controls, so the
 *    ship moves with left/right and fires with a button — the original's own
 *    on-screen pads — instead of following a finger.
 *
 * The playfield keeps its fixed 640×720 logical resolution and is letterboxed
 * into the canvas, so every spacing, speed and collision threshold below is the
 * original's number unchanged.
 */

import { isActivationTarget, isTypingTarget } from "../shared/keys";
import { ToneSynth } from "../shared/toneSynth";
import {
  ALIEN_BULLET,
  BOARD,
  COLORS,
  EXTRA_LIFE_AT,
  FLEET,
  GAME_H,
  GAME_W,
  INVADER_POINTS,
  LEVEL_CLEAR_DELAY,
  MARCH_NOTES,
  MAX_LIVES,
  PLAYER,
  SHIELD,
  STAR_COUNT,
  STARTING_LIVES,
  UFO,
  UFO_POINTS,
} from "./constants";
import {
  INVADER_SPRITES,
  PLAYER_SPRITE,
  PLAYER_TIP_SPRITE,
  SHIELD_SHAPE,
  SPRITE_PIXEL,
  UFO_SPRITE,
  type PixelRun,
  type Sprite,
} from "./sprites";
import type { ControlName, GameEvents, GamePhase, HudState } from "./types";

interface Alien {
  type: number;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  alive: boolean;
}

interface Bullet {
  x: number;
  y: number;
  w: number;
  h: number;
  vy: number;
}

interface Ufo {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
}

interface Shield {
  x: number;
  y: number;
  w: number;
  h: number;
  /** `cells[row][col]` — true while that pixel block of the shield survives. */
  cells: boolean[][];
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface Star {
  x: number;
  y: number;
  size: number;
  speed: number;
  twinkle: number;
}

const KEYMAP: Record<string, ControlName> = {
  ArrowLeft: "left",
  a: "left",
  A: "left",
  ArrowRight: "right",
  d: "right",
  D: "right",
  " ": "fire",
  Spacebar: "fire",
};

const SWALLOWED_KEYS = new Set([" ", "Spacebar", "ArrowLeft", "ArrowRight"]);

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Row of the fleet → sprite type (0 squid on top, 2 octopus at the bottom). */
function rowType(row: number): number {
  if (row < 1) return 0;
  if (row < 3) return 1;
  return 2;
}

export class SpaceInvadersGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly events: GameEvents;
  private readonly audio = new ToneSynth();

  private width = 0;
  private height = 0;
  private dpr = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  private phase: GamePhase = "idle";
  private score = 0;
  private lives: number = STARTING_LIVES;
  private level = 1;
  private time = 0;

  private player = { x: GAME_W / 2 - PLAYER.w / 2, y: PLAYER.y, w: PLAYER.w, h: PLAYER.h, cooldown: 0 };
  private playerAlive = true;
  private playerBullets: Bullet[] = [];
  private alienBullets: Bullet[] = [];

  private aliens: Alien[] = [];
  private alienDir = 1;
  private alienMoveTimer = 0;
  private alienMoveInterval = 0.78;
  private alienFireTimer = 0;
  private frameIndex = 0;
  private frameTimer = 0;
  private marchIndex = 0;

  private shields: Shield[] = [];

  private ufo: Ufo | null = null;
  private ufoTimer: number = UFO.firstDelay;
  private ufoSoundTimer = 0;

  private nextLifeAt: number = EXTRA_LIFE_AT;
  /** Time accumulated since the last invader died, for the level banner. */
  private killDelay = 0;

  private particles: Particle[] = [];
  private floats: FloatText[] = [];
  private stars: Star[] = [];

  private readonly input: Record<ControlName, boolean> = { left: false, right: false, fire: false };
  private raf = 0;
  private lastFrame = 0;
  private destroyed = false;
  private readonly observer: ResizeObserver | null;

  constructor(canvas: HTMLCanvasElement, events: GameEvents = {}) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d canvas context unavailable");

    this.canvas = canvas;
    this.ctx = context;
    this.events = events;
    this.ctx.imageSmoothingEnabled = false;

    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("orientationchange", this.handleOrientationChange);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resize()) : null;
    this.observer?.observe(canvas);

    this.buildStars();
    this.resetRun();
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

  start(): void {
    this.audio.unlock();
    // A control held when the last run ended must not carry into this one.
    this.clearInput();
    this.resetRun();
    this.setPhase("playing");
    this.emitHud();
  }

  pause(): void {
    if (this.phase !== "playing") return;
    // The shell hides the touch controls while paused, so a pointer that was
    // down never reports its release. Clearing stops a stuck "left" or "fire".
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

  primaryAction(): void {
    if (this.phase === "idle" || this.phase === "over") this.start();
    else if (this.phase === "paused") this.resume();
  }

  /** `name` is a string because the shell renders controls from a generic spec. */
  setInput(name: string, down: boolean): void {
    if (!(name in this.input)) return;
    if (down) this.audio.unlock();
    this.input[name as ControlName] = down;
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.events.onMutedChange?.(this.audio.isMuted);
  }

  toggleMute(): void {
    this.audio.unlock();
    this.setMuted(!this.audio.isMuted);
  }

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
      // A focused button already activates on Enter; starting a run at the same
      // time would fight the button the user just pressed.
      if (isActivationTarget(event.target)) return;
      this.primaryAction();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const control = KEYMAP[event.key];
    if (control) this.input[control] = false;
  };

  /** Losing focus mid-press otherwise leaves the ship drifting or firing. */
  private handleBlur = (): void => {
    this.clearInput();
    if (this.phase === "playing") this.pause();
  };

  /** Coming back from another app should not cost a life in the meantime. */
  private handleVisibility = (): void => {
    if (document.visibilityState === "hidden" && this.phase === "playing") this.pause();
  };

  private clearInput(): void {
    this.input.left = false;
    this.input.right = false;
    this.input.fire = false;
  }

  private handleResize = (): void => {
    this.resize();
  };

  private handleOrientationChange = (): void => {
    // iOS reports the pre-rotation viewport for a frame or two.
    window.setTimeout(() => this.resize(), 140);
  };

  /* --------------------------------------------------------------- sizing */

  /**
   * Fit the fixed 640×720 playfield into the canvas and remember the transform.
   * The game never re-lays-out its contents: letterboxing is what keeps the
   * original's spacing and collision numbers valid on any screen.
   */
  private resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    this.dpr = Math.min(devicePixelRatio, 2.5);
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);

    this.scale = Math.min(this.width / GAME_W, this.height / GAME_H);
    this.offsetX = (this.width - GAME_W * this.scale) / 2;
    this.offsetY = (this.height - GAME_H * this.scale) / 2;
  }

  private buildStars(): void {
    this.stars = [];
    for (let i = 0; i < STAR_COUNT; i += 1) {
      this.stars.push({
        x: Math.random() * GAME_W,
        y: Math.random() * GAME_H,
        size: Math.random() < 0.2 ? 2 : 1,
        speed: 8 + Math.random() * 26,
        twinkle: Math.random() * Math.PI * 2,
      });
    }
  }

  /* ------------------------------------------------------------ game state */

  private resetRun(): void {
    this.score = 0;
    this.level = 1;
    this.lives = STARTING_LIVES;
    this.player = {
      x: GAME_W / 2 - PLAYER.w / 2,
      y: PLAYER.y,
      w: PLAYER.w,
      h: PLAYER.h,
      cooldown: 0,
    };
    this.playerAlive = true;
    this.playerBullets = [];
    this.alienBullets = [];
    this.particles = [];
    this.floats = [];
    this.ufo = null;
    this.ufoTimer = UFO.firstDelay;
    this.killDelay = 0;
    this.marchIndex = 0;
    this.nextLifeAt = EXTRA_LIFE_AT;
    this.alienFireTimer = 1.2;
    this.alienMoveTimer = 0;
    this.buildAliens();
    this.buildShields();
  }

  private buildAliens(): void {
    this.aliens = [];
    for (let row = 0; row < BOARD.rows; row += 1) {
      for (let col = 0; col < BOARD.cols; col += 1) {
        const type = rowType(row);
        const sprite = INVADER_SPRITES[type]?.[0] ?? INVADER_SPRITES[2]![0];
        const cellX = BOARD.startX + col * BOARD.hspace;
        const cellY = BOARD.startY + row * BOARD.vspace;
        this.aliens.push({
          type,
          row,
          col,
          // Centre the sprite in its column cell.
          x: cellX + Math.round((BOARD.hspace - sprite.w) / 2),
          y: cellY,
          w: sprite.w,
          h: sprite.h,
          alive: true,
        });
      }
    }
    this.alienDir = 1;
    this.alienMoveTimer = 0;
    this.alienMoveInterval = this.alienInterval();
  }

  private buildShields(): void {
    this.shields = SHIELD.xs.map((x) => {
      const cells = SHIELD_SHAPE.map((row) => [...row].map((char) => char === "#"));
      const cols = SHIELD_SHAPE[0]?.length ?? 0;
      return { x, y: SHIELD.y, w: cols * SHIELD.cell, h: SHIELD_SHAPE.length * SHIELD.cell, cells };
    });
  }

  private aliveAliens(): Alien[] {
    return this.aliens.filter((alien) => alien.alive);
  }

  /** The fleet speeds up as it thins out, and by a step each level. */
  private alienInterval(): number {
    const alive = this.aliveAliens().length;
    return Math.max(0.05, 0.78 - 0.012 * (55 - alive) - 0.1 * (this.level - 1));
  }

  private alienFireInterval(): number {
    const alive = this.aliveAliens().length;
    return Math.max(0.32, 1.4 - 0.02 * (55 - alive) - 0.12 * (this.level - 1));
  }

  /**
   * One fleet step: sideways, or drop and reverse at the wall. The frame and
   * the march note advance with it, which is what makes the fleet feel like it
   * is marching rather than sliding.
   */
  private moveAliens(): void {
    const alive = this.aliveAliens();
    if (alive.length === 0) return;

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const alien of alive) {
      if (alien.x < left) left = alien.x;
      if (alien.x + alien.w > right) right = alien.x + alien.w;
    }

    const step = FLEET.step * this.alienDir;
    let hitWall = false;
    if (left + step < FLEET.margin) {
      this.alienDir = 1;
      hitWall = true;
    } else if (right + step > GAME_W - FLEET.margin) {
      this.alienDir = -1;
      hitWall = true;
    }

    const dx = hitWall ? 0 : step;
    const drop = hitWall ? FLEET.drop : 0;
    for (const alien of alive) {
      alien.x += dx;
      alien.y += drop;
    }

    this.frameIndex = 1 - this.frameIndex;
    this.audio.tone(MARCH_NOTES[this.marchIndex % MARCH_NOTES.length] ?? 110, 0.06, "square", 0.18);
    this.marchIndex += 1;
  }

  /** The lowest invader in a random column fires — the classic behaviour. */
  private spawnAlienBullet(): void {
    const alive = this.aliveAliens();
    if (alive.length === 0) return;

    const lowestByColumn = new Map<number, Alien>();
    for (const alien of alive) {
      const current = lowestByColumn.get(alien.col);
      if (!current || alien.row > current.row) lowestByColumn.set(alien.col, alien);
    }

    const columns = [...lowestByColumn.keys()];
    const column = columns[Math.floor(Math.random() * columns.length)];
    if (column === undefined) return;
    const source = lowestByColumn.get(column);
    if (!source) return;

    this.alienBullets.push({
      x: source.x + source.w / 2,
      y: source.y + source.h,
      w: ALIEN_BULLET.w,
      h: ALIEN_BULLET.h,
      vy: 130 + this.level * 26 + Math.random() * 30,
    });
  }

  private firePlayerBullet(): void {
    if (this.playerBullets.length >= PLAYER.maxBullets) return;
    this.playerBullets.push({
      x: this.player.x + this.player.w / 2 - PLAYER.bulletW / 2,
      y: this.player.y - PLAYER.bulletH,
      w: PLAYER.bulletW,
      h: PLAYER.bulletH,
      vy: PLAYER.bulletSpeed,
    });
    this.audio.tone(880, 0.12, "square", 0.12);
    this.audio.tone(1320, 0.08, "square", 0.05, 0.04);
  }

  private spawnUfo(): void {
    const fromLeft = Math.random() < 0.5;
    this.ufo = {
      x: fromLeft ? -UFO_SPRITE.w : GAME_W,
      y: UFO.y,
      w: UFO_SPRITE.w,
      h: UFO_SPRITE.h,
      vx: (fromLeft ? 1 : -1) * (UFO.speed + this.level * UFO.speedPerLevel),
    };
    this.ufoSoundTimer = 0;
  }

  private spawnExplosion(x: number, y: number, color: string, count: number, speed: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.4 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: 0.5 + Math.random() * 0.3,
        maxLife: 0.8,
        color,
        size: Math.random() < 0.5 ? 2 : 3,
      });
    }
  }

  private addFloat(x: number, y: number, text: string, color: string): void {
    this.floats.push({ x, y, text, color, life: 0.9, maxLife: 0.9 });
  }

  private addScore(points: number): void {
    this.score += points;
    if (this.score >= this.nextLifeAt) {
      if (this.lives < MAX_LIVES) {
        this.lives += 1;
        this.toast("EXTRA LIFE!");
        this.audio.tone(660, 0.1, "square", 0.12);
        this.audio.tone(880, 0.1, "square", 0.12, 0.09);
        this.audio.tone(1100, 0.15, "square", 0.12, 0.18);
      }
      this.nextLifeAt += EXTRA_LIFE_AT;
    }
    this.emitHud();
  }

  private playerHurt(): void {
    this.lives -= 1;
    this.playerBullets = [];
    this.alienBullets = [];
    this.spawnExplosion(
      this.player.x + this.player.w / 2,
      this.player.y + this.player.h / 2,
      "#ffffff",
      18,
      160,
    );
    this.audio.tone(440, 0.18, "sawtooth", 0.22);
    this.audio.tone(120, 0.35, "square", 0.12, 0.05);
    this.emitHud();

    if (this.lives <= 0) this.finishRun();
  }

  private finishRun(): void {
    if (this.phase === "over") return;
    this.playerAlive = false;
    this.clearInput();
    this.setPhase("over");
    this.events.onGameOver?.({ score: this.score, level: this.level });
  }

  private nextLevel(): void {
    this.level += 1;
    this.player.y = PLAYER.y;
    this.playerBullets = [];
    this.alienBullets = [];
    this.ufo = null;
    this.ufoTimer = 4;
    this.buildAliens();
    this.buildShields();
    this.addFloat(GAME_W / 2, GAME_H / 2 - 40, `LEVEL ${this.level}`, "#ffffff");
    this.emitHud();
  }

  /**
   * Carve a hole in whichever shield the bullet is inside.
   *
   * The blast is centred on the bullet's *leading* edge and clamped into the
   * shield, so repeated shots drill through instead of grinding the outer face.
   */
  private bulletVsShield(bullet: Bullet): boolean {
    for (const shield of this.shields) {
      if (
        bullet.x + bullet.w < shield.x ||
        bullet.x > shield.x + shield.w ||
        bullet.y + bullet.h < shield.y ||
        bullet.y > shield.y + shield.h
      ) {
        continue;
      }

      const cols = shield.cells[0]?.length ?? 0;
      const rows = shield.cells.length;
      const c0 = Math.max(0, Math.floor((bullet.x - shield.x) / SHIELD.cell));
      const c1 = Math.min(cols - 1, Math.floor((bullet.x + bullet.w - shield.x) / SHIELD.cell));
      const r0 = Math.max(0, Math.floor((bullet.y - shield.y) / SHIELD.cell));
      const r1 = Math.min(rows - 1, Math.floor((bullet.y + bullet.h - shield.y) / SHIELD.cell));

      let hit = false;
      for (let row = r0; row <= r1; row += 1) {
        for (let col = c0; col <= c1; col += 1) {
          if (shield.cells[row]?.[col]) hit = true;
        }
      }
      if (!hit) continue;

      const centerX = Math.max(shield.x, Math.min(shield.x + shield.w, bullet.x + bullet.w / 2));
      const leadingY = bullet.vy < 0 ? bullet.y : bullet.y + bullet.h;
      const centerY = Math.max(shield.y, Math.min(shield.y + shield.h, leadingY));
      const blastRadius = SHIELD.blastCells * SHIELD.cell;

      for (let row = r0 - 2; row <= r1 + 2; row += 1) {
        if (row < 0 || row >= rows) continue;
        for (let col = c0 - 2; col <= c1 + 2; col += 1) {
          if (col < 0 || col >= cols) continue;
          const cellX = shield.x + (col + 0.5) * SHIELD.cell;
          const cellY = shield.y + (row + 0.5) * SHIELD.cell;
          if (Math.hypot(cellX - centerX, cellY - centerY) <= blastRadius) {
            const targetRow = shield.cells[row];
            if (targetRow) targetRow[col] = false;
          }
        }
      }
      return true;
    }
    return false;
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

    this.time += dt;

    if (this.phase === "playing") this.update(dt);

    // Effects keep animating on the game-over screen so the final explosion is
    // visible; only pause freezes them.
    if (this.phase !== "paused") {
      this.updateParticles(dt);
      this.updateFloats(dt);
    }

    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    const player = this.player;

    /* ---- movement ---- */
    if (this.input.left) player.x -= PLAYER.speed * dt;
    if (this.input.right) player.x += PLAYER.speed * dt;
    player.x = clamp(player.x, PLAYER.margin, GAME_W - player.w - PLAYER.margin);

    /* ---- firing ---- */
    player.cooldown -= dt;
    if (this.input.fire && player.cooldown <= 0) {
      this.firePlayerBullet();
      player.cooldown = PLAYER.fireCooldown;
    }

    /* ---- player bullets ---- */
    for (let i = this.playerBullets.length - 1; i >= 0; i -= 1) {
      const bullet = this.playerBullets[i];
      if (!bullet) continue;
      bullet.y += bullet.vy * dt;
      if (bullet.y + bullet.h < 0) {
        this.playerBullets.splice(i, 1);
        continue;
      }

      if (this.bulletVsShield(bullet)) {
        this.playerBullets.splice(i, 1);
        this.audio.tone(220, 0.12, "sawtooth", 0.18);
        continue;
      }

      let consumed = false;
      for (const alien of this.aliens) {
        if (!alien.alive || !rectsOverlap(bullet, alien)) continue;
        alien.alive = false;
        const points = INVADER_POINTS[alien.type] ?? 10;
        this.addFloat(alien.x + alien.w / 2, alien.y, `+${points}`, "#ffffff");
        this.spawnExplosion(
          alien.x + alien.w / 2,
          alien.y + alien.h / 2,
          COLORS.invader[alien.type] ?? COLORS.invader[2],
          10,
          110,
        );
        this.audio.tone(220, 0.12, "sawtooth", 0.18);
        this.audio.tone(90, 0.18, "square", 0.1, 0.02);
        this.addScore(points);
        this.playerBullets.splice(i, 1);
        consumed = true;
        break;
      }
      if (consumed) continue;

      if (this.ufo && rectsOverlap(bullet, this.ufo)) {
        const points = UFO_POINTS[Math.floor(Math.random() * UFO_POINTS.length)] ?? 100;
        this.addFloat(this.ufo.x + this.ufo.w / 2, this.ufo.y, `+${points}`, COLORS.ufo);
        this.spawnExplosion(
          this.ufo.x + this.ufo.w / 2,
          this.ufo.y + this.ufo.h / 2,
          COLORS.ufo,
          18,
          140,
        );
        this.audio.tone(220, 0.12, "sawtooth", 0.18);
        this.addScore(points);
        this.ufo = null;
        this.playerBullets.splice(i, 1);
      }
    }

    /* ---- fleet march ---- */
    if (this.aliveAliens().length > 0) {
      this.alienMoveTimer += dt;
      this.alienMoveInterval = this.alienInterval();
      if (this.alienMoveTimer >= this.alienMoveInterval) {
        this.alienMoveTimer = 0;
        this.moveAliens();
      }
    }

    /* ---- frame animation ---- */
    this.frameTimer += dt;
    if (this.frameTimer > 0.5) {
      this.frameTimer = 0;
      this.frameIndex = 1 - this.frameIndex;
    }

    /* ---- alien fire ---- */
    if (this.aliveAliens().length > 0) {
      this.alienFireTimer -= dt;
      if (this.alienFireTimer <= 0) {
        this.spawnAlienBullet();
        this.alienFireTimer = this.alienFireInterval() * (0.6 + Math.random() * 0.8);
      }
    } else {
      this.alienFireTimer = 0.3;
    }

    /* ---- alien bullets ---- */
    for (let i = this.alienBullets.length - 1; i >= 0; i -= 1) {
      const bullet = this.alienBullets[i];
      if (!bullet) continue;
      bullet.y += bullet.vy * dt;
      if (bullet.y > GAME_H) {
        this.alienBullets.splice(i, 1);
        continue;
      }
      if (this.bulletVsShield(bullet)) {
        this.alienBullets.splice(i, 1);
        this.audio.tone(220, 0.12, "sawtooth", 0.18);
        continue;
      }
      if (rectsOverlap(bullet, player)) {
        this.alienBullets.splice(i, 1);
        this.playerHurt();
        if (this.phase === "over") return;
      }
    }

    /* ---- UFO ---- */
    if (this.ufo) {
      this.ufo.x += this.ufo.vx * dt;
      this.ufoSoundTimer -= dt;
      if (this.ufoSoundTimer <= 0) {
        this.audio.tone(590, 0.07, "sine", 0.1);
        this.ufoSoundTimer = UFO.warbleInterval;
      }
      const leaving = this.ufo.vx > 0 ? this.ufo.x > GAME_W : this.ufo.x + this.ufo.w < 0;
      if (leaving) this.ufo = null;
    } else {
      this.ufoTimer -= dt;
      if (this.ufoTimer <= 0) {
        this.spawnUfo();
        this.ufoTimer = UFO.spawnMin + Math.random() * (UFO.spawnMax - UFO.spawnMin);
      }
    }

    /* ---- invasion: the fleet reached the player's line ---- */
    for (const alien of this.aliens) {
      if (alien.alive && alien.y + alien.h >= player.y) {
        this.finishRun();
        return;
      }
    }

    /* ---- wave cleared ---- */
    if (this.aliveAliens().length === 0) {
      this.killDelay += dt;
      if (this.killDelay > LEVEL_CLEAR_DELAY) {
        this.nextLevel();
        this.killDelay = 0;
      }
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      if (!particle) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 180 * dt;
    }
  }

  private updateFloats(dt: number): void {
    for (let i = this.floats.length - 1; i >= 0; i -= 1) {
      const float = this.floats[i];
      if (!float) continue;
      float.life -= dt;
      float.y -= 24 * dt;
      if (float.life <= 0) this.floats.splice(i, 1);
    }
  }

  /* ----------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx } = this;

    // Letterbox in device space, so the bars are true black.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, this.width, this.height);

    // Everything else is in the fixed 640×720 playfield.
    ctx.setTransform(
      this.dpr * this.scale,
      0,
      0,
      this.dpr * this.scale,
      this.dpr * this.offsetX,
      this.dpr * this.offsetY,
    );

    this.drawStars();

    if (this.phase === "idle") return;

    this.drawShields();
    this.drawAliens();
    this.drawUfo();
    this.drawBullets();
    this.drawPlayer();
    this.drawParticles();
    this.drawFloats();

    // The shell's overlay takes over on pause; only the wave banner is drawn
    // here, because it is part of the playfield's rhythm.
    if (this.killDelay > 0 && this.aliveAliens().length === 0 && this.phase === "playing") {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, GAME_H / 2 - 40, GAME_W, 80);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("LEVEL CLEARED", GAME_W / 2, GAME_H / 2);
    }
  }

  private drawStars(): void {
    const { ctx } = this;
    const dt = this.phase === "paused" ? 0 : 0.016;
    ctx.fillStyle = "#ffffff";
    for (const star of this.stars) {
      star.y += star.speed * dt;
      if (star.y > GAME_H) {
        star.y = -2;
        star.x = Math.random() * GAME_W;
      }
      ctx.globalAlpha = Math.min(1, 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 2 + star.twinkle)));
      ctx.fillRect(star.x | 0, star.y | 0, star.size, star.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawSprite(sprite: Sprite, x: number, y: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    for (const run of sprite.runs as readonly PixelRun[]) {
      ctx.fillRect(x + run.x, y + run.y, run.w, SPRITE_PIXEL);
    }
  }

  private drawAliens(): void {
    for (const alien of this.aliens) {
      if (!alien.alive) continue;
      const sprite = INVADER_SPRITES[alien.type]?.[this.frameIndex] ?? INVADER_SPRITES[2]![0];
      const left = (alien.x + (alien.w - sprite.w) / 2) | 0;
      this.drawSprite(sprite, left, alien.y | 0, COLORS.invader[alien.type] ?? COLORS.invader[2]);
    }
  }

  private drawShields(): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.shield;
    for (const shield of this.shields) {
      for (let row = 0; row < shield.cells.length; row += 1) {
        const cells = shield.cells[row];
        if (!cells) continue;
        for (let col = 0; col < cells.length; col += 1) {
          if (cells[col]) {
            ctx.fillRect(
              shield.x + col * SHIELD.cell,
              shield.y + row * SHIELD.cell,
              SHIELD.cell,
              SHIELD.cell,
            );
          }
        }
      }
    }
  }

  private drawPlayer(): void {
    if (!this.playerAlive) return;
    const { ctx } = this;
    const player = this.player;
    this.drawSprite(PLAYER_SPRITE, player.x, player.y, COLORS.player);
    this.drawSprite(PLAYER_TIP_SPRITE, player.x, player.y, "#ffffff");
    ctx.fillStyle = "rgba(255,120,40,0.6)";
    const flicker = Math.sin(this.time * 60) * 2;
    ctx.fillRect(player.x + player.w / 2 - 1, player.y + player.h, 2, 4 + flicker * 0.5);
  }

  private drawUfo(): void {
    if (!this.ufo) return;
    this.drawSprite(UFO_SPRITE, this.ufo.x | 0, this.ufo.y, COLORS.ufo);
  }

  private drawBullets(): void {
    const { ctx } = this;

    for (const bullet of this.playerBullets) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(bullet.x - 1, bullet.y, bullet.w + 2, bullet.h);
      ctx.fillStyle = COLORS.bullet;
      ctx.fillRect(bullet.x, bullet.y, bullet.w, bullet.h);
    }

    ctx.fillStyle = COLORS.alienBullet;
    for (const bullet of this.alienBullets) {
      // The classic zig-zag: alternate 3px segments left and right.
      for (let offset = 0; offset < bullet.h; offset += 3) {
        const shift = Math.floor(this.time * 30 + offset) % 2 ? 1 : 0;
        ctx.fillRect(bullet.x + shift * 3 - 1, bullet.y + offset, bullet.w, Math.min(3, bullet.h - offset));
      }
    }
  }

  private drawParticles(): void {
    const { ctx } = this;
    for (const particle of this.particles) {
      ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawFloats(): void {
    const { ctx } = this;
    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const float of this.floats) {
      ctx.globalAlpha = Math.max(0, float.life / float.maxLife);
      ctx.fillStyle = float.color;
      ctx.fillText(float.text, float.x, float.y);
    }
    ctx.globalAlpha = 1;
  }
}
