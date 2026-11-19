/**
 * Tetris — canvas simulation.
 *
 * Ported from the original standalone `tetris.html`. The rules are the original's:
 * a 7-bag randomiser, SRS rotation with wall kicks, a 500 ms lock delay, a 210 ms
 * line-clear flash, hold-once-per-piece, back-to-back Tetris bonus, combo
 * counter, and the classic gravity curve.
 *
 * Two structural differences, both because the shell owns that furniture now:
 * the score / level / lines readout and every menu are DOM, and the best score
 * is the server-side board rather than `localStorage`. Hold and next are still
 * drawn on the canvas — they are part of the board's information, and a phone
 * needs to see the piece shapes, not the word "T".
 *
 * Inputs are flags, and *taps are rising edges*: rotate, hard drop and hold fire
 * once when the shell's `setInput(name, true)` arrives, which is exactly what a
 * pointer-down on a button produces. Held directions get DAS-style repeat from
 * the engine's own clock, so a keyboard key and a touch button behave the same.
 */

import { isActivationTarget, isTypingTarget } from "../shared/keys";
import { ToneSynth } from "../shared/toneSynth";
import {
  BOARD_COLORS,
  BOARD_H,
  BOARD_W,
  BOARD_X,
  BOARD_Y,
  CELL,
  CLEAR_TIME,
  COLS,
  DAS_DELAY,
  DAS_REPEAT,
  GAME_H,
  GAME_W,
  HARD_DROP_POINTS,
  LINES_PER_LEVEL,
  LINE_POINTS,
  LOCK_DELAY,
  PANEL,
  ROWS,
  SOFT_DROP_INTERVAL,
  SOFT_DROP_POINTS,
  fallInterval,
} from "./constants";
import { COLORS, KICKS, SHAPES, TYPES, cellsFromMatrix, rotateMatrix, type Cell, type PieceType } from "./pieces";
import type { ControlName, GameEvents, GamePhase, HudState } from "./types";

const CONTROL_FLAGS: readonly ControlName[] = [
  "left",
  "right",
  "rotate",
  "rotateCcw",
  "down",
  "hard",
  "hold",
];

interface Piece {
  type: PieceType;
  matrix: number[][];
  cells: Cell[];
  rot: number;
  x: number;
  y: number;
}

type Grid = (PieceType | null)[][];

function emptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => new Array<PieceType | null>(COLS).fill(null));
}

/** Lighten (`amount` > 0) or darken a `#rrggbb` colour, as the original did. */
function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const clampChannel = (channel: number) => Math.min(255, Math.max(0, channel + amount));
  const red = clampChannel((value >> 16) & 255);
  const green = clampChannel((value >> 8) & 255);
  const blue = clampChannel(value & 255);
  return `rgb(${red},${green},${blue})`;
}

export class TetrisGame {
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
  private grid: Grid = emptyGrid();
  private current: Piece | null = null;
  private heldType: PieceType | null = null;
  private canHold = true;
  private queue: PieceType[] = [];

  private score = 0;
  private lines = 0;
  private level = 1;
  private b2b = false;
  private combo = 0;

  private clearing = false;
  private clearRows: number[] = [];
  private clearCount = 0;
  private clearTimer = 0;

  private dropTimer = 0;
  private softTimer = 0;
  private lockTimer = 0;
  private dasDir = 0;
  private dasTimer = 0;

  private readonly input: Record<ControlName, boolean> = {
    left: false,
    right: false,
    rotate: false,
    rotateCcw: false,
    down: false,
    hard: false,
    hold: false,
  };
  private previous: Record<ControlName, boolean> = { ...this.input };

  /** The HUD is throttled: soft drop changes the score every 30 ms. */
  private hudDirty = false;
  private hudTimer = 0;

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
    return { score: this.score, level: this.level, lines: this.lines };
  }

  start(): void {
    this.audio.unlock();
    this.clearInput();
    this.resetRun();
    this.setPhase("playing");
    this.emitHud();
  }

  pause(): void {
    if (this.phase !== "playing") return;
    // Held directions must not survive the pause: the shell's pad disappears
    // while paused, so a finger-down would never report its release.
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

  setInput(name: string, down: boolean): void {
    if (!(CONTROL_FLAGS as readonly string[]).includes(name)) return;
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
    this.hudDirty = false;
    this.hudTimer = 0;
    this.events.onHud?.(this.hud);
  }

  /** Mark the HUD stale; it is flushed at most ten times a second. */
  private markHud(): void {
    this.hudDirty = true;
  }

  private toast(message: string): void {
    this.events.onToast?.(message);
  }

  /* ----------------------------------------------------------------- input */

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    this.audio.unlock();

    const key = event.key;

    if (key === "ArrowLeft" || key === "a" || key === "A") {
      event.preventDefault();
      this.input.left = true;
      return;
    }
    if (key === "ArrowRight" || key === "d" || key === "D") {
      event.preventDefault();
      this.input.right = true;
      return;
    }
    // Everything below is a tap: a held key must not auto-repeat it.
    if (event.repeat) return;

    if (key === "ArrowDown" || key === "s" || key === "S") {
      event.preventDefault();
      this.input.down = true;
      return;
    }
    if (key === "ArrowUp" || key === "w" || key === "W" || key === "x" || key === "X") {
      event.preventDefault();
      this.input.rotate = true;
      return;
    }
    if (key === "z" || key === "Z") {
      this.input.rotateCcw = true;
      return;
    }
    if (key === " " || key === "Spacebar") {
      event.preventDefault();
      this.input.hard = true;
      return;
    }
    if (key === "c" || key === "C" || key === "Shift") {
      this.input.hold = true;
      return;
    }
    if (key === "p" || key === "P" || key === "Escape") {
      this.togglePause();
      return;
    }
    if (key === "m" || key === "M") {
      this.toggleMute();
      return;
    }
    if (key === "Enter") {
      // A focused button already activates on Enter; starting a run at the same
      // time would fight the button the user just pressed.
      if (isActivationTarget(event.target)) return;
      this.primaryAction();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const key = event.key;
    if (key === "ArrowLeft" || key === "a" || key === "A") this.input.left = false;
    else if (key === "ArrowRight" || key === "d" || key === "D") this.input.right = false;
    else if (key === "ArrowDown" || key === "s" || key === "S") this.input.down = false;
    else if (key === "ArrowUp" || key === "w" || key === "W" || key === "x" || key === "X") {
      this.input.rotate = false;
    } else if (key === "z" || key === "Z") this.input.rotateCcw = false;
    else if (key === " " || key === "Spacebar") this.input.hard = false;
    else if (key === "c" || key === "C" || key === "Shift") this.input.hold = false;
  };

  private handleBlur = (): void => {
    this.clearInput();
    if (this.phase === "playing") this.pause();
  };

  private handleVisibility = (): void => {
    if (document.visibilityState === "hidden" && this.phase === "playing") this.pause();
  };

  private clearInput(): void {
    for (const flag of CONTROL_FLAGS) this.input[flag] = false;
    this.previous = { ...this.input };
    this.dasDir = 0;
    this.dasTimer = 0;
  }

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

  /* ------------------------------------------------------------ game state */

  private resetRun(): void {
    this.grid = emptyGrid();
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.b2b = false;
    this.combo = 0;
    this.heldType = null;
    this.canHold = true;
    this.queue = [];
    this.current = null;
    this.clearing = false;
    this.clearRows = [];
    this.clearCount = 0;
    this.clearTimer = 0;
    this.dropTimer = 0;
    this.softTimer = 0;
    this.lockTimer = 0;
    this.dasDir = 0;
    this.dasTimer = 0;
    this.spawnPiece();
  }

  private makePiece(type: PieceType, rot: number): Piece {
    let matrix: number[][] = (SHAPES[type] ?? SHAPES.T).map((row) => [...row]);
    for (let turn = 0; turn < rot; turn += 1) matrix = rotateMatrix(matrix, 1);

    const cells = cellsFromMatrix(matrix);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    for (const cell of cells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
      minY = Math.min(minY, cell.y);
    }
    const width = maxX - minX + 1;
    return {
      type,
      matrix,
      cells,
      rot,
      x: Math.floor((COLS - width) / 2) - minX,
      y: -minY,
    };
  }

  private collides(cells: readonly Cell[], x: number, y: number): boolean {
    for (const cell of cells) {
      const cellX = x + cell.x;
      const cellY = y + cell.y;
      if (cellX < 0 || cellX >= COLS || cellY >= ROWS) return true;
      const row = cellY >= 0 ? this.grid[cellY] : undefined;
      if (row?.[cellX]) return true;
    }
    return false;
  }

  private isGrounded(): boolean {
    const piece = this.current;
    if (!piece) return false;
    return this.collides(piece.cells, piece.x, piece.y + 1);
  }

  private tryMove(dx: number, dy: number): boolean {
    const piece = this.current;
    if (!piece) return false;
    if (this.collides(piece.cells, piece.x + dx, piece.y + dy)) return false;
    piece.x += dx;
    piece.y += dy;
    this.lockTimer = 0;
    return true;
  }

  private moveHorizontal(dx: number): void {
    if (this.phase !== "playing" || !this.current) return;
    if (this.tryMove(dx, 0)) this.audio.tone(190, 0.04, "square", 0.04);
  }

  private rotatePiece(direction: number): void {
    const piece = this.current;
    if (!piece || piece.type === "O") return;

    const from = piece.rot;
    const to = (from + direction + 4) % 4;
    const matrix = rotateMatrix(piece.matrix, direction);
    const cells = cellsFromMatrix(matrix);
    const kicks = KICKS[piece.type]?.[`${from}>${to}`] ?? [[0, 0]];

    for (const kick of kicks) {
      const [dx, dyUp] = kick;
      const x = piece.x + dx;
      const y = piece.y - dyUp; // kick tables use y-up; screen y is down
      if (this.collides(cells, x, y)) continue;
      piece.matrix = matrix;
      piece.cells = cells;
      piece.rot = to;
      piece.x = x;
      piece.y = y;
      this.lockTimer = 0;
      this.audio.tone(330, 0.05, "square", 0.05);
      return;
    }
  }

  private hardDrop(): void {
    if (this.phase !== "playing" || !this.current) return;
    let dropped = 0;
    while (this.tryMove(0, 1)) dropped += 1;
    if (dropped > 0) {
      this.score += dropped * HARD_DROP_POINTS;
      this.markHud();
    }
    this.audio.tone(120, 0.09, "square", 0.1);
    this.lock();
  }

  private holdPiece(): void {
    const piece = this.current;
    if (this.phase !== "playing" || !piece || !this.canHold) return;

    const currentType = piece.type;
    let replacement: PieceType;
    if (this.heldType) {
      replacement = this.heldType;
      this.heldType = currentType;
    } else {
      this.heldType = currentType;
      replacement = this.nextType();
    }
    this.canHold = false;
    this.current = this.makePiece(replacement, 0);
    this.dropTimer = 0;
    this.softTimer = 0;
    this.lockTimer = 0;
    this.audio.tone(260, 0.06, "square", 0.06);

    const spawned = this.current;
    if (this.collides(spawned.cells, spawned.x, spawned.y)) this.finishRun();
  }

  /* ------------------------------------------------------- queue / pieces */

  private fillQueue(): void {
    const bag = [...TYPES];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = bag[i]!;
      const b = bag[j]!;
      bag[i] = b;
      bag[j] = a;
    }
    this.queue.push(...bag);
  }

  private nextType(): PieceType {
    if (this.queue.length < 1) this.fillQueue();
    const next = this.queue.shift();
    if (next) return next;
    this.fillQueue();
    return this.queue.shift() ?? "T";
  }

  private queuePreview(count: number): PieceType[] {
    while (this.queue.length < count) this.fillQueue();
    return this.queue.slice(0, count);
  }

  private spawnPiece(): void {
    const piece = this.makePiece(this.nextType(), 0);
    this.current = piece;
    this.dropTimer = 0;
    this.softTimer = 0;
    this.lockTimer = 0;
    if (this.collides(piece.cells, piece.x, piece.y)) this.finishRun();
  }

  private fullRows(): number[] {
    const rows: number[] = [];
    this.grid.forEach((row, index) => {
      if (row.every((cell) => cell !== null)) rows.push(index);
    });
    return rows;
  }

  private lock(): void {
    const piece = this.current;
    if (!piece) return;

    let toppedOut = false;
    for (const cell of piece.cells) {
      const y = piece.y + cell.y;
      if (y < 0) {
        toppedOut = true;
        continue;
      }
      const row = this.grid[y];
      if (row) row[piece.x + cell.x] = piece.type;
    }

    this.current = null;
    this.canHold = true;
    this.softTimer = 0;
    this.lockTimer = 0;

    if (toppedOut) {
      this.finishRun();
      return;
    }

    const full = this.fullRows();
    if (full.length > 0) {
      this.clearing = true;
      this.clearRows = full;
      this.clearCount = full.length;
      this.clearTimer = 0;
      this.playClearSound(full.length);
    } else {
      this.spawnPiece();
    }
  }

  private finishClear(): void {
    if (this.clearRows.length > 0) {
      const cleared = new Set(this.clearRows);
      this.grid = this.grid.filter((_, row) => !cleared.has(row));
      while (this.grid.length < ROWS) this.grid.unshift(new Array<PieceType | null>(COLS).fill(null));
      this.addScoreForClear(this.clearCount);
    }
    this.clearing = false;
    this.clearRows = [];
    this.clearCount = 0;
    this.spawnPiece();
  }

  private addScoreForClear(count: number): void {
    const base = LINE_POINTS[count] ?? 0;
    let gained = base * this.level;
    let message = "";

    if (count === 4) {
      if (this.b2b) {
        gained = Math.floor(gained * 1.5);
        message = "B2B Tetris!";
      } else {
        message = "Tetris!";
      }
      this.b2b = true;
    } else if (count > 0) {
      this.b2b = false;
    }

    this.combo = count > 0 ? this.combo + 1 : 0;
    this.score += gained;
    this.lines += count;

    const nextLevel = Math.floor(this.lines / LINES_PER_LEVEL) + 1;
    if (nextLevel > this.level) {
      this.level = nextLevel;
      this.audio.tone(392, 0.1, "square", 0.08);
      this.audio.tone(523, 0.1, "square", 0.08, 0.1);
      this.audio.tone(659, 0.1, "square", 0.08, 0.2);
      this.toast(`Level ${this.level}`);
    }

    if (count > 0) {
      let text = message;
      if (this.combo >= 2) text = text ? `${text} · Combo x${this.combo}` : `Combo x${this.combo}`;
      if (text) this.toast(text);
    }

    this.emitHud();
  }

  private finishRun(): void {
    if (this.phase === "over") return;
    this.clearInput();
    this.audio.tone(392, 0.22, "sawtooth", 0.09);
    this.audio.tone(330, 0.22, "sawtooth", 0.09, 0.18);
    this.audio.tone(262, 0.22, "sawtooth", 0.09, 0.36);
    this.audio.tone(196, 0.22, "sawtooth", 0.09, 0.54);
    this.setPhase("over");
    this.events.onGameOver?.({ score: this.score, level: this.level });
  }

  private playClearSound(count: number): void {
    const notes = [523, 659, 784];
    for (let i = 0; i < Math.min(4, count + 1); i += 1) {
      this.audio.tone(notes[i % 3] ?? 523, 0.09, "triangle", 0.09, i * 0.06);
    }
  }

  /* --------------------------------------------------------------- update */

  private frame = (now: number): void => {
    if (this.destroyed) return;
    const previous = this.lastFrame || now;
    let dt = (now - previous) / 1000;
    this.lastFrame = now;
    // A backgrounded tab resumes with a huge delta; clamping keeps gravity sane.
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;

    if (this.phase === "playing") this.update(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    if (this.clearing) {
      this.clearTimer += dt;
      if (this.clearTimer >= CLEAR_TIME) this.finishClear();
      this.flushHud(dt);
      return;
    }

    if (!this.current) {
      this.spawnPiece();
      this.flushHud(dt);
      return;
    }

    // Taps: one action per rising edge, whatever the input source.
    if (this.rising("rotate")) this.rotatePiece(1);
    if (this.rising("rotateCcw")) this.rotatePiece(-1);
    if (this.rising("hard")) this.hardDrop();
    if (this.rising("hold")) this.holdPiece();

    if (this.phase !== "playing" || !this.current) {
      this.snapshot();
      this.flushHud(dt);
      return;
    }

    this.handleHorizontal(dt);

    if (this.isGrounded()) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY) this.lock();
    } else {
      this.lockTimer = 0;
      if (this.input.down) {
        this.softTimer += dt;
        let guard = 0;
        while (this.softTimer >= SOFT_DROP_INTERVAL && guard < 32) {
          guard += 1;
          this.softTimer -= SOFT_DROP_INTERVAL;
          if (!this.tryMove(0, 1)) {
            this.softTimer = 0;
            break;
          }
          this.score += SOFT_DROP_POINTS;
          this.markHud();
        }
      } else {
        this.softTimer = 0;
        this.dropTimer += dt;
        const fall = fallInterval(this.level);
        if (this.dropTimer >= fall) {
          this.dropTimer -= fall;
          this.tryMove(0, 1);
        }
      }
    }

    this.snapshot();
    this.flushHud(dt);
  }

  private rising(name: ControlName): boolean {
    return this.input[name] && !this.previous[name];
  }

  private snapshot(): void {
    this.previous = { ...this.input };
  }

  /** Emit at most every 100 ms — soft drop would otherwise re-render 30×/s. */
  private flushHud(dt: number): void {
    this.hudTimer += dt;
    if (this.hudDirty && this.hudTimer >= 0.1) this.emitHud();
  }

  /** Held-direction repeat: a pause first, then a fast, steady cadence. */
  private handleHorizontal(dt: number): void {
    const direction = this.input.left && !this.input.right ? -1 : this.input.right && !this.input.left ? 1 : 0;
    if (direction === 0) {
      this.dasDir = 0;
      this.dasTimer = 0;
      return;
    }
    if (direction !== this.dasDir) {
      this.dasDir = direction;
      this.dasTimer = DAS_DELAY;
      this.moveHorizontal(direction);
      return;
    }
    this.dasTimer -= dt;
    if (this.dasTimer <= 0) {
      this.moveHorizontal(direction);
      this.dasTimer = DAS_REPEAT;
    }
  }

  /* ----------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx } = this;

    // Letterbox in device space, so the bars are true black.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.setTransform(
      this.dpr * this.scale,
      0,
      0,
      this.dpr * this.scale,
      this.dpr * this.offsetX,
      this.dpr * this.offsetY,
    );

    this.drawBoard();
    this.drawPanels();
  }

  private drawBoard(): void {
    const { ctx } = this;

    ctx.fillStyle = BOARD_COLORS.background;
    ctx.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H);

    // Settled cells.
    this.grid.forEach((row, y) => {
      row.forEach((type, x) => {
        if (type) this.drawBlock(BOARD_X + x * CELL, BOARD_Y + y * CELL, CELL, COLORS[type]);
      });
    });

    if (this.clearing) {
      const fraction = Math.min(1, this.clearTimer / CLEAR_TIME);
      const alpha = (0.35 * Math.sin(fraction * Math.PI)).toFixed(3);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      for (const row of this.clearRows) {
        ctx.fillRect(BOARD_X, BOARD_Y + row * CELL, BOARD_W, CELL);
      }
    } else if (this.current) {
      const piece = this.current;

      // Ghost: where the piece would land.
      let ghostY = piece.y;
      while (!this.collides(piece.cells, piece.x, ghostY + 1)) ghostY += 1;
      if (ghostY !== piece.y) {
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS[piece.type];
        for (const cell of piece.cells) {
          const y = ghostY + cell.y;
          if (y < 0) continue;
          ctx.strokeRect(
            BOARD_X + (piece.x + cell.x) * CELL + 2,
            BOARD_Y + y * CELL + 2,
            CELL - 4,
            CELL - 4,
          );
        }
        ctx.globalAlpha = 1;
      }

      for (const cell of piece.cells) {
        const y = piece.y + cell.y;
        if (y < 0) continue;
        this.drawBlock(BOARD_X + (piece.x + cell.x) * CELL, BOARD_Y + y * CELL, CELL, COLORS[piece.type]);
      }
    }

    // Faint grid, then the frame.
    ctx.strokeStyle = BOARD_COLORS.grid;
    ctx.lineWidth = 1;
    for (let col = 1; col < COLS; col += 1) {
      ctx.beginPath();
      ctx.moveTo(BOARD_X + col * CELL + 0.5, BOARD_Y);
      ctx.lineTo(BOARD_X + col * CELL + 0.5, BOARD_Y + BOARD_H);
      ctx.stroke();
    }
    for (let row = 1; row < ROWS; row += 1) {
      ctx.beginPath();
      ctx.moveTo(BOARD_X, BOARD_Y + row * CELL + 0.5);
      ctx.lineTo(BOARD_X + BOARD_W, BOARD_Y + row * CELL + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = BOARD_COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(BOARD_X + 1, BOARD_Y + 1, BOARD_W - 2, BOARD_H - 2);
  }

  private drawPanels(): void {
    const nextTypes = this.queuePreview(2);
    this.drawPanel(0, "HOLD", this.heldType);
    this.drawPanel(1, "NEXT", nextTypes[0] ?? null);
    this.drawPanel(2, "NEXT", nextTypes[1] ?? null);
  }

  private drawPanel(index: number, label: string, type: PieceType | null): void {
    const y = PANEL.ys[index];
    if (y === undefined) return;
    const { ctx } = this;

    ctx.fillStyle = BOARD_COLORS.panel;
    ctx.fillRect(PANEL.x, y, PANEL.w, PANEL.h);
    ctx.strokeStyle = BOARD_COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(PANEL.x + 0.5, y + 0.5, PANEL.w - 1, PANEL.h - 1);

    ctx.fillStyle = BOARD_COLORS.label;
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, PANEL.x + PANEL.w / 2, y + 6);

    if (type) this.drawMini(type, PANEL.x, y + 22, PANEL.w, PANEL.h - 26);
  }

  /** A piece scaled to sit inside a preview box, centred. */
  private drawMini(type: PieceType, boxX: number, boxY: number, boxW: number, boxH: number): void {
    const cells = cellsFromMatrix(SHAPES[type] ?? SHAPES.T);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const cell of cells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
      minY = Math.min(minY, cell.y);
      maxY = Math.max(maxY, cell.y);
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const size = Math.max(2, Math.floor(Math.min((boxW - 8) / width, (boxH - 4) / height)));
    const originX = boxX + (boxW - width * size) / 2 - minX * size;
    const originY = boxY + (boxH - height * size) / 2 - minY * size;

    for (const cell of cells) {
      this.drawBlock(originX + cell.x * size, originY + cell.y * size, size, COLORS[type]);
    }
  }

  /** A bevelled block: light top-left, dark bottom-right, thin outline. */
  private drawBlock(x: number, y: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = shade(color, 36);
    ctx.fillRect(x, y, size, size * 0.16);
    ctx.fillRect(x, y, size * 0.16, size);

    ctx.fillStyle = shade(color, -44);
    ctx.fillRect(x, y + size * 0.84, size, size * 0.16);
    ctx.fillRect(x + size * 0.84, y, size * 0.16, size);

    ctx.strokeStyle = "rgba(0,0,0,.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }
}
