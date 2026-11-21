/**
 * Pac-Man — canvas simulation.
 *
 * Ported from the original standalone `pacman.html`: the same 28×31 maze, the
 * same four ghosts with their arcade personalities (Blinky chases, Pinky aims
 * four tiles ahead, Inky uses Blinky as a pivot, Clyde breaks off when close),
 * the same scatter/chase schedule, frightened ghosts worth 200/400/800/1600, and
 * a fruit that appears twice a level.
 *
 * The original ran on a fixed 60 Hz step with an accumulator, and speeds in
 * "pixels per tick" — so this port keeps that step rather than switching to
 * dt-scaled physics. The shell's frame supplies elapsed time, the engine drains
 * it in whole ticks, and a test can call `tick()` directly.
 *
 * The overlays are the shell's; what stays on the canvas is the maze, the
 * actors, the READY! beat, the level-clear flash and the score popups.
 */

import { isActivationTarget, isTypingTarget } from "../shared/keys";
import {
  CLEAR_TICKS,
  COLORS,
  COLS,
  DEATH_TICKS,
  DIRS,
  DIR_ORDER,
  DOOR_TILE,
  FREEZE_TICKS,
  FRUIT_POS,
  FRUIT_TICKS,
  GAME_H,
  GAME_W,
  GHOST_DEFS,
  MAP_SRC,
  MODE_PLAN,
  OPPOSITE,
  PAC_START,
  PEN_CENTER,
  POINTS,
  READY_TICKS,
  ROWS,
  STARTING_LIVES,
  T,
  baseGhostSpeed,
  frightSeconds,
  pacSpeed,
  type Direction,
  type GhostDefinition,
} from "./constants";
import type { ControlName, GameEvents, GamePhase, HudState } from "./types";

const STEP_MS = 1000 / 60;

type Stage = "ready" | "play" | "dead" | "clear";

interface Ghost {
  def: GhostDefinition;
  x: number;
  y: number;
  dir: Direction;
  /** normal | home (waiting in the pen) | exiting | entering | eyes */
  state: "normal" | "home" | "exiting" | "entering" | "eyes";
  fright: boolean;
  bob: number;
  releaseTimer: number;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  t: number;
}

interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function wrapCol(col: number): number {
  return ((col % COLS) + COLS) % COLS;
}

function tileCentre(tile: { c: number; r: number }): { x: number; y: number } {
  return { x: tile.c * T + T / 2, y: tile.r * T + T / 2 };
}

export class PacmanGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly events: GameEvents;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  private phase: GamePhase = "idle";
  private stage: Stage = "ready";
  private stageTimer = 0;

  private tiles: string[][] = [];
  private dotsLeft = 0;
  private dotsTotal = 0;
  private wallSegments: WallSegment[] = [];

  private score = 0;
  private level = 1;
  private lives = STARTING_LIVES;

  private pac = {
    x: PAC_START.x,
    y: PAC_START.y,
    dir: "left" as Direction,
    nextDir: null as Direction | null,
    moving: false,
    mouth: 0,
    dead: 0,
  };

  private ghosts: Ghost[] = [];
  private frightTimer = 0;
  private ghostCombo = 0;
  private freeze = 0;
  private modeIndex = 0;
  private modeTimer = 0;
  private globalTick = 0;
  private readonly popups: Popup[] = [];
  private fruit = { active: false, timer: 0, value: 100, spawned: 0 };
  /** The original is silent; mute is tracked so the shell's button stays truthful. */
  private mutedFlag = false;

  private accumulator = 0;
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

    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("orientationchange", this.handleOrientationChange);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resize()) : null;
    this.observer?.observe(canvas);

    this.buildMaze();
    this.placeActors();
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ------------------------------------------------------------------ API */

  get currentPhase(): GamePhase {
    return this.phase;
  }

  get hud(): HudState {
    return { score: this.score, level: this.level, lives: this.lives };
  }

  start(): void {
    this.score = 0;
    this.level = 1;
    this.lives = STARTING_LIVES;
    this.setPhase("playing");
    this.startLevel(true);
    this.emitHud();
  }

  pause(): void {
    if (this.phase !== "playing") return;
    this.setPhase("paused");
  }

  resume(): void {
    if (this.phase !== "paused") return;
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

  /**
   * A direction press. Pac-Man keeps a *requested* direction, so this only
   * records where he should turn next — releasing does nothing.
   */
  setInput(name: string, down: boolean): void {
    if (!down) return;
    if (!(name in DIRS)) return;
    this.pac.nextDir = name as Direction;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    this.events.onMutedChange?.(muted);
  }

  toggleMute(): void {
    this.setMuted(!this.muted);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("orientationchange", this.handleOrientationChange);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.observer?.disconnect();
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

  private finishRun(): void {
    if (this.phase === "over") return;
    this.setPhase("over");
    this.events.onGameOver?.({ score: this.score, level: this.level });
  }

  /* ----------------------------------------------------------------- input */

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;

    const dir = KEY_MAP[event.key];
    if (dir) {
      event.preventDefault();
      this.pac.nextDir = dir;
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      if (isActivationTarget(event.target)) return;
      event.preventDefault();
      this.primaryAction();
      return;
    }
    if (event.key === "p" || event.key === "P" || event.key === "Escape") {
      this.togglePause();
      return;
    }
    if (event.key === "m" || event.key === "M") {
      this.toggleMute();
    }
  };

  private handleBlur = (): void => {
    if (this.phase === "playing") this.pause();
  };

  private handleVisibility = (): void => {
    if (document.visibilityState === "hidden" && this.phase === "playing") this.pause();
  };

  private handleResize = (): void => {
    this.resize();
  };

  private handleOrientationChange = (): void => {
    window.setTimeout(() => this.resize(), 140);
  };

  /* --------------------------------------------------------------- sizing */

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

  /* ------------------------------------------------------------ maze setup */

  private buildMaze(): void {
    this.tiles = MAP_SRC.map((row) => [...row]);
    this.dotsLeft = 0;
    for (const row of this.tiles) {
      for (const char of row) if (char === "." || char === "o") this.dotsLeft += 1;
    }
    this.dotsTotal = this.dotsLeft;
    this.wallSegments = this.collectWallSegments();
  }

  /**
   * Precompute the maze outline as line segments: for every wall tile, draw the
   * edge facing each open neighbour. The original painted this into an offscreen
   * canvas once per level; keeping it as data gets the same look without a DOM.
   */
  private collectWallSegments(): WallSegment[] {
    const segments: WallSegment[] = [];
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (this.tiles[row]?.[col] !== "#") continue;
        const x = col * T;
        const y = row * T;
        if (!this.isWall(col, row - 1)) segments.push({ x1: x, y1: y, x2: x + T, y2: y });
        if (!this.isWall(col, row + 1)) segments.push({ x1: x, y1: y + T, x2: x + T, y2: y + T });
        if (!this.isWall(col - 1, row)) segments.push({ x1: x, y1: y, x2: x, y2: y + T });
        if (!this.isWall(col + 1, row)) segments.push({ x1: x + T, y1: y, x2: x + T, y2: y + T });
      }
    }
    return segments;
  }

  private tileAt(col: number, row: number): string {
    if (row < 0 || row >= ROWS) return "#";
    return this.tiles[row]?.[wrapCol(col)] ?? "#";
  }

  private isWall(col: number, row: number): boolean {
    return this.tileAt(col, row) === "#";
  }

  private isBlocked(col: number, row: number): boolean {
    const char = this.tileAt(col, row);
    return char === "#" || char === "-";
  }

  private tileOf(entity: { x: number; y: number }): { c: number; r: number } {
    return { c: Math.floor(entity.x / T), r: Math.floor(entity.y / T) };
  }

  private wrapX(entity: { x: number }): void {
    if (entity.x < 0) entity.x += GAME_W;
    else if (entity.x >= GAME_W) entity.x -= GAME_W;
  }

  private placeActors(): void {
    this.pac.x = PAC_START.x;
    this.pac.y = PAC_START.y;
    this.pac.dir = "left";
    this.pac.nextDir = null;
    this.pac.moving = false;
    this.pac.mouth = 0;
    this.pac.dead = 0;

    this.ghosts = GHOST_DEFS.map((def) => ({
      def,
      x: def.home.x,
      y: def.home.y,
      dir: def.startOut ? "left" : "up",
      state: def.startOut ? "normal" : "home",
      fright: false,
      bob: 1,
      releaseTimer: def.release,
    }));

    this.frightTimer = 0;
    this.ghostCombo = 0;
    this.modeIndex = 0;
    this.modeTimer = 0;
    this.freeze = 0;
    this.popups.length = 0;
  }

  private startLevel(newMaze: boolean): void {
    if (newMaze) this.buildMaze();
    this.placeActors();
    this.fruit.active = false;
    this.fruit.spawned = 0;
    this.fruit.value = POINTS.fruit[Math.min(this.level - 1, POINTS.fruit.length - 1)] ?? 100;
    this.stage = "ready";
    this.stageTimer = READY_TICKS;
    this.emitHud();
  }

  private addScore(points: number): void {
    this.score += points;
    this.emitHud();
  }

  private popup(x: number, y: number, text: string): void {
    this.popups.push({ x, y, text, t: 60 });
  }

  /* ------------------------------------------------------------- updating */

  private frame = (now: number): void => {
    if (this.destroyed) return;
    const previous = this.lastFrame || now;
    this.lastFrame = now;
    this.accumulator += now - previous;
    // A backgrounded tab resumes with a huge gap; do not fast-forward the game.
    if (this.accumulator > 250) this.accumulator = 250;

    if (this.phase === "playing") {
      while (this.accumulator >= STEP_MS) {
        this.tick();
        this.accumulator -= STEP_MS;
      }
    } else {
      this.accumulator = 0;
    }

    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  /** One 60 Hz step — the original's `update()`. */
  private tick(): void {
    // The frame loop already gates on the phase, but a tick after the run ends
    // would keep decrementing lives past zero. Be defensive.
    if (this.phase !== "playing") return;
    this.globalTick += 1;

    for (let i = this.popups.length - 1; i >= 0; i -= 1) {
      const popup = this.popups[i];
      if (!popup) continue;
      popup.t -= 1;
      if (popup.t <= 0) this.popups.splice(i, 1);
    }

    if (this.stage === "ready") {
      this.stageTimer -= 1;
      if (this.stageTimer <= 0) this.stage = "play";
      return;
    }

    if (this.stage === "dead") {
      this.stageTimer += 1;
      if (this.stageTimer > 40) this.pac.dead = Math.min(1, (this.stageTimer - 40) / 70);
      if (this.stageTimer > DEATH_TICKS) {
        this.lives -= 1;
        this.emitHud();
        if (this.lives <= 0) {
          this.finishRun();
        } else {
          this.placeActors();
          this.fruit.active = false;
          this.stage = "ready";
          this.stageTimer = 110;
        }
      }
      return;
    }

    if (this.stage === "clear") {
      this.stageTimer -= 1;
      if (this.stageTimer <= 0) {
        this.level += 1;
        this.startLevel(true);
      }
      return;
    }

    if (this.freeze > 0) {
      this.freeze -= 1;
      return;
    }

    this.updatePac();
    if (this.stage !== "play") return; // the level may have just been cleared
    for (const ghost of this.ghosts) this.updateGhost(ghost);
    this.updateModes();
    this.updateFruit();
    this.checkCollisions();
  }

  private canPacGo(tile: { c: number; r: number }, dir: Direction): boolean {
    const delta = DIRS[dir];
    return !this.isBlocked(tile.c + delta.x, tile.r + delta.y);
  }

  private updatePac(): void {
    const speed = pacSpeed(this.level);
    const tile = this.tileOf(this.pac);
    const centre = tileCentre(tile);
    const centred =
      Math.abs(this.pac.x - centre.x) <= speed / 2 + 0.001 &&
      Math.abs(this.pac.y - centre.y) <= speed / 2 + 0.001;

    if (centred) {
      this.pac.x = centre.x;
      this.pac.y = centre.y;
      if (this.pac.nextDir && this.canPacGo(tile, this.pac.nextDir)) {
        this.pac.dir = this.pac.nextDir;
        this.pac.nextDir = null;
      }
      this.pac.moving = this.canPacGo(tile, this.pac.dir);
    } else if (this.pac.nextDir && this.pac.nextDir === OPPOSITE[this.pac.dir]) {
      // Reversing mid-corridor is always legal: the tile behind is open.
      this.pac.dir = this.pac.nextDir;
      this.pac.nextDir = null;
      this.pac.moving = true;
    } else {
      this.pac.moving = true;
    }

    if (this.pac.moving) {
      this.pac.x += DIRS[this.pac.dir].x * speed;
      this.pac.y += DIRS[this.pac.dir].y * speed;
      this.wrapX(this.pac);
      this.pac.mouth += 0.28;
    }

    this.eatTile();
  }

  private eatTile(): void {
    const tile = this.tileOf(this.pac);
    const row = this.tiles[tile.r];
    const char = row?.[tile.c];
    if (!row || (char !== "." && char !== "o")) return;

    row[tile.c] = " ";
    this.dotsLeft -= 1;

    if (char === ".") {
      this.addScore(POINTS.dot);
    } else {
      this.addScore(POINTS.pellet);
      this.frightTimer = Math.round(frightSeconds(this.level) * 60);
      this.ghostCombo = 0;
      for (const ghost of this.ghosts) {
        if (ghost.state === "normal") {
          ghost.fright = true;
          ghost.dir = OPPOSITE[ghost.dir] ?? ghost.dir;
        } else if (ghost.state === "home" || ghost.state === "exiting") {
          ghost.fright = true;
        }
      }
    }

    const eaten = this.dotsTotal - this.dotsLeft;
    if ((eaten === 70 && this.fruit.spawned === 0) || (eaten === 170 && this.fruit.spawned === 1)) {
      this.fruit.spawned += 1;
      this.fruit.active = true;
      this.fruit.timer = FRUIT_TICKS;
    }

    if (this.dotsLeft === 0) {
      this.stage = "clear";
      this.stageTimer = CLEAR_TICKS;
    }
  }

  /* --------------------------------------------------------------- ghosts */

  private targetTile(ghost: Ghost): { c: number; r: number } {
    const pacTile = this.tileOf(this.pac);
    const delta = DIRS[this.pac.dir];
    const mode = MODE_PLAN[this.modeIndex]?.[0] ?? "chase";

    if (mode === "scatter") return ghost.def.scatter;

    switch (ghost.def.name) {
      case "blinky":
        return pacTile;
      case "pinky":
        return { c: pacTile.c + delta.x * 4, r: pacTile.r + delta.y * 4 };
      case "inky": {
        const blinky = this.ghosts[0];
        if (!blinky) return pacTile;
        const pivot = this.tileOf(blinky);
        const ahead = { c: pacTile.c + delta.x * 2, r: pacTile.r + delta.y * 2 };
        return { c: ahead.c * 2 - pivot.c, r: ahead.r * 2 - pivot.r };
      }
      case "clyde": {
        const own = this.tileOf(ghost);
        const distance = (own.c - pacTile.c) ** 2 + (own.r - pacTile.r) ** 2;
        return distance > 64 ? pacTile : ghost.def.scatter;
      }
    }
  }

  /** Breadth-first search, used only by eaten ghosts heading back to the pen. */
  private bfsDir(startCol: number, startRow: number, targetCol: number, targetRow: number): Direction | null {
    const dist = new Array<number>(COLS * ROWS).fill(-1);
    const queue: [number, number][] = [[targetCol, targetRow]];
    dist[targetRow * COLS + targetCol] = 0;

    for (let head = 0; head < queue.length; head += 1) {
      const entry = queue[head];
      if (!entry) continue;
      const [col, row] = entry;
      const distance = dist[row * COLS + col] ?? 0;
      for (const key of DIR_ORDER) {
        const nextCol = wrapCol(col + DIRS[key].x);
        const nextRow = row + DIRS[key].y;
        if (nextRow < 0 || nextRow >= ROWS) continue;
        if (this.isBlocked(nextCol, nextRow)) continue;
        const index = nextRow * COLS + nextCol;
        if (dist[index] !== -1) continue;
        dist[index] = distance + 1;
        queue.push([nextCol, nextRow]);
      }
    }

    let best: Direction | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const key of DIR_ORDER) {
      const nextCol = wrapCol(startCol + DIRS[key].x);
      const nextRow = startRow + DIRS[key].y;
      if (nextRow < 0 || nextRow >= ROWS) continue;
      if (this.isBlocked(nextCol, nextRow)) continue;
      const distance = dist[nextRow * COLS + nextCol] ?? -1;
      if (distance >= 0 && distance < bestDistance) {
        bestDistance = distance;
        best = key;
      }
    }
    return best;
  }

  private chooseGhostDir(ghost: Ghost, tile: { c: number; r: number }): Direction {
    const options: Direction[] = [];
    for (const key of DIR_ORDER) {
      if (ghost.dir && key === OPPOSITE[ghost.dir]) continue;
      const delta = DIRS[key];
      if (this.isBlocked(tile.c + delta.x, tile.r + delta.y)) continue;
      options.push(key);
    }
    if (options.length === 0) return OPPOSITE[ghost.dir] ?? "up";

    if (ghost.state === "eyes") {
      const step = this.bfsDir(tile.c, tile.r, DOOR_TILE.c, DOOR_TILE.r);
      if (step) return step;
    }
    if (ghost.fright) return options[Math.floor(Math.random() * options.length)] ?? "up";

    const target = this.targetTile(ghost);
    let best = options[0] ?? "up";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const key of options) {
      const delta = DIRS[key];
      const col = tile.c + delta.x;
      const row = tile.r + delta.y;
      const distance = (col - target.c) ** 2 + (row - target.r) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = key;
      }
    }
    return best;
  }

  private ghostSpeed(ghost: Ghost): number {
    if (ghost.state === "eyes") return 4;
    if (ghost.state === "home" || ghost.state === "exiting" || ghost.state === "entering") return 1.2;
    if (ghost.fright) return 1.1;
    const tile = this.tileOf(ghost);
    // The tunnel slows ghosts down, as in the arcade.
    if (tile.r === 14 && (tile.c < 6 || tile.c > 21)) return baseGhostSpeed(this.level) * 0.55;
    return baseGhostSpeed(this.level);
  }

  private updateGhost(ghost: Ghost): void {
    if (ghost.state === "home") {
      ghost.y += ghost.bob * 0.55;
      if (ghost.y > ghost.def.home.y + 5) {
        ghost.y = ghost.def.home.y + 5;
        ghost.bob = -1;
      }
      if (ghost.y < ghost.def.home.y - 5) {
        ghost.y = ghost.def.home.y - 5;
        ghost.bob = 1;
      }
      ghost.dir = ghost.bob > 0 ? "down" : "up";
      ghost.releaseTimer -= 1;
      if (ghost.releaseTimer <= 0) ghost.state = "exiting";
      return;
    }

    if (ghost.state === "exiting") {
      const targetX = DOOR_TILE.c * T + T / 2;
      if (Math.abs(ghost.x - targetX) > 1.2) {
        ghost.x += Math.sign(targetX - ghost.x) * 1.2;
        ghost.dir = targetX > ghost.x ? "right" : "left";
      } else {
        ghost.x = targetX;
        ghost.y -= 1.2;
        ghost.dir = "up";
        if (ghost.y <= DOOR_TILE.r * T + T / 2) {
          ghost.y = DOOR_TILE.r * T + T / 2;
          ghost.state = "normal";
          ghost.dir = "left";
        }
      }
      return;
    }

    if (ghost.state === "entering") {
      ghost.y += 1.6;
      ghost.dir = "down";
      if (ghost.y >= PEN_CENTER.y) {
        ghost.y = PEN_CENTER.y;
        ghost.x = ghost.def.home.x;
        ghost.state = "home";
        ghost.bob = 1;
        ghost.releaseTimer = 50;
        ghost.fright = false;
      }
      return;
    }

    const speed = this.ghostSpeed(ghost);
    const tile = this.tileOf(ghost);
    const centre = tileCentre(tile);
    const centred =
      Math.abs(ghost.x - centre.x) <= speed / 2 + 0.001 &&
      Math.abs(ghost.y - centre.y) <= speed / 2 + 0.001;

    if (centred) {
      ghost.x = centre.x;
      ghost.y = centre.y;
      if (ghost.state === "eyes" && tile.c === DOOR_TILE.c && tile.r === DOOR_TILE.r) {
        ghost.state = "entering";
        return;
      }
      ghost.dir = this.chooseGhostDir(ghost, tile);
    }

    ghost.x += DIRS[ghost.dir].x * speed;
    ghost.y += DIRS[ghost.dir].y * speed;
    this.wrapX(ghost);
  }

  private updateModes(): void {
    if (this.frightTimer > 0) {
      this.frightTimer -= 1;
      if (this.frightTimer === 0) {
        for (const ghost of this.ghosts) ghost.fright = false;
        this.ghostCombo = 0;
      }
      // The scatter/chase clock pauses while ghosts are frightened.
      return;
    }

    const span = MODE_PLAN[this.modeIndex]?.[1] ?? Infinity;
    if (span === Infinity) return;
    this.modeTimer += 1;
    if (this.modeTimer >= span * 60) {
      this.modeTimer = 0;
      this.modeIndex = Math.min(this.modeIndex + 1, MODE_PLAN.length - 1);
      for (const ghost of this.ghosts) {
        if (ghost.state === "normal" && !ghost.fright) ghost.dir = OPPOSITE[ghost.dir] ?? ghost.dir;
      }
    }
  }

  private checkCollisions(): void {
    for (const ghost of this.ghosts) {
      if (ghost.state === "eyes" || ghost.state === "entering" || ghost.state === "home") continue;
      const dx = ghost.x - this.pac.x;
      const dy = ghost.y - this.pac.y;
      if (dx * dx + dy * dy > 121) continue;

      if (ghost.fright) {
        this.ghostCombo = Math.min(this.ghostCombo + 1, 4);
        const value = POINTS.ghost * 2 ** (this.ghostCombo - 1);
        this.addScore(value);
        this.popup(ghost.x, ghost.y, String(value));
        ghost.fright = false;
        ghost.state = "eyes";
        this.freeze = FREEZE_TICKS;
      } else {
        this.stage = "dead";
        this.stageTimer = 0;
        this.pac.dead = 0;
      }
      return;
    }
  }

  private updateFruit(): void {
    if (!this.fruit.active) return;
    this.fruit.timer -= 1;
    if (this.fruit.timer <= 0) {
      this.fruit.active = false;
      return;
    }
    const dx = this.pac.x - FRUIT_POS.x;
    const dy = this.pac.y - FRUIT_POS.y;
    if (dx * dx + dy * dy < 100) {
      this.fruit.active = false;
      this.addScore(this.fruit.value);
      this.popup(FRUIT_POS.x, FRUIT_POS.y, String(this.fruit.value));
    }
  }

  /* ----------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx } = this;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.setTransform(
      this.dpr * this.scale,
      0,
      0,
      this.dpr * this.scale,
      this.dpr * this.offsetX,
      this.dpr * this.offsetY,
    );

    // The level-clear flash alternates the maze colour, as the arcade did.
    const flashing = this.stage === "clear" && Math.floor(this.stageTimer / 12) % 2 === 0;
    this.drawWalls(flashing ? COLORS.wallFlash : COLORS.wall);
    if (this.stage !== "clear") this.drawDots();
    this.drawFruit();
    if (this.stage === "clear") return;

    for (const ghost of this.ghosts) this.drawGhost(ghost);
    this.drawPac();
    this.drawPopups();

    if (this.stage === "ready") this.centerText("READY!", 20 * T + 8, 15, COLORS.text);
  }

  private drawWalls(color: string): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const segment of this.wallSegments) {
      ctx.moveTo(segment.x1, segment.y1);
      ctx.lineTo(segment.x2, segment.y2);
    }
    ctx.stroke();

    // The ghost-house door.
    ctx.strokeStyle = COLORS.door;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(13 * T, 12 * T + 8);
    ctx.lineTo(15 * T, 12 * T + 8);
    ctx.stroke();
  }

  private drawDots(): void {
    const { ctx } = this;
    const blink = Math.floor(this.globalTick / 12) % 2 === 0;
    ctx.fillStyle = COLORS.pellet;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const char = this.tiles[row]?.[col];
        if (char === ".") {
          ctx.fillRect(col * T + 7, row * T + 7, 2.5, 2.5);
        } else if (char === "o" && blink) {
          ctx.beginPath();
          ctx.arc(col * T + T / 2, row * T + T / 2, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawPac(): void {
    const { ctx } = this;
    const radius = 7.4;

    let open: number;
    if (this.stage === "dead" && this.pac.dead > 0) open = this.pac.dead * Math.PI;
    else if (this.stage === "dead") open = 0.25;
    else open = this.pac.moving ? 0.02 + Math.abs(Math.sin(this.pac.mouth)) * 0.34 : 0.28;

    if (open >= Math.PI - 0.02) return; // swallowed whole

    const angles: Record<Direction, number> = {
      right: 0,
      down: Math.PI / 2,
      left: Math.PI,
      up: -Math.PI / 2,
    };

    ctx.save();
    ctx.translate(this.pac.x, this.pac.y);
    ctx.rotate(angles[this.pac.dir] ?? 0);
    ctx.fillStyle = COLORS.pac;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, open, Math.PI * 2 - open);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawGhost(ghost: Ghost): void {
    const { ctx } = this;
    const radius = 7.4;
    const { x, y } = ghost;
    const eyesOnly = ghost.state === "eyes" || ghost.state === "entering";

    if (!eyesOnly) {
      const flashing =
        this.frightTimer > 0 &&
        this.frightTimer < 120 &&
        Math.floor(this.frightTimer / 14) % 2 === 0;

      ctx.fillStyle = ghost.fright
        ? flashing
          ? COLORS.frightenedFlash
          : COLORS.frightened
        : ghost.def.color;
      ctx.beginPath();
      ctx.arc(x, y - 1, radius, Math.PI, 0);
      ctx.lineTo(x + radius, y + radius - 1);

      // Scalloped skirt, animated between two phases.
      const wobble = Math.floor(this.globalTick / 8) % 2;
      const feet = 3;
      const span = (radius * 2) / feet;
      for (let i = 0; i < feet; i += 1) {
        const x0 = x + radius - i * span;
        const dip = i % 2 === wobble ? radius - 1 : radius - 5;
        ctx.lineTo(x0 - span / 2, y + dip);
        ctx.lineTo(x0 - span, y + radius - 1);
      }
      ctx.closePath();
      ctx.fill();

      if (ghost.fright) {
        ctx.fillStyle = flashing ? "#d81515" : COLORS.frightenedFlash;
        ctx.fillRect(x - 4, y - 3, 2.4, 2.4);
        ctx.fillRect(x + 1.8, y - 3, 2.4, 2.4);
        ctx.beginPath();
        ctx.moveTo(x - 4.5, y + 3.5);
        for (let i = 0; i < 4; i += 1) {
          ctx.lineTo(x - 4.5 + i * 2.4 + 1.2, y + 1.8);
          ctx.lineTo(x - 4.5 + (i + 1) * 2.4, y + 3.5);
        }
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = flashing ? "#d81515" : COLORS.frightenedFlash;
        ctx.stroke();
        return;
      }
    }

    // Eyes, looking the way the ghost is going.
    const look = DIRS[ghost.dir] ?? DIRS.left;
    ctx.fillStyle = COLORS.ghostEyes;
    ctx.beginPath();
    ctx.ellipse(x - 2.8, y - 2, 2.6, 3.2, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 2.8, y - 2, 2.6, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ghostPupil;
    ctx.beginPath();
    ctx.arc(x - 2.8 + look.x * 1.2, y - 2 + look.y * 1.4, 1.4, 0, Math.PI * 2);
    ctx.arc(x + 2.8 + look.x * 1.2, y - 2 + look.y * 1.4, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFruit(): void {
    if (!this.fruit.active) return;
    const { ctx } = this;
    const { x, y } = FRUIT_POS;

    ctx.fillStyle = COLORS.fruit;
    ctx.beginPath();
    ctx.arc(x - 3, y + 3, 3.6, 0, Math.PI * 2);
    ctx.arc(x + 3.4, y + 2, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = COLORS.fruitStem;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - 3, y + 1);
    ctx.quadraticCurveTo(x + 1, y - 6, x + 5, y - 5);
    ctx.moveTo(x + 3.4, y);
    ctx.quadraticCurveTo(x + 4, y - 3, x + 5, y - 5);
    ctx.stroke();
  }

  private drawPopups(): void {
    const { ctx } = this;
    ctx.font = "700 11px Menlo, 'DejaVu Sans Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.popup;
    for (const popup of this.popups) {
      ctx.fillText(popup.text, popup.x, popup.y - (60 - popup.t) * 0.12);
    }
  }

  private centerText(text: string, y: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.font = `700 ${size}px Menlo, 'DejaVu Sans Mono', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, GAME_W / 2, y);
  }
}

const KEY_MAP: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  a: "left",
  s: "down",
  d: "right",
  W: "up",
  A: "left",
  S: "down",
  D: "right",
};
