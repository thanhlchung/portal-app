/**
 * Connect 4 — canvas simulation.
 *
 * Ported from the original standalone `connect4.html`: a 7×6 board, a
 * heuristic alpha-beta opponent that first takes an immediate win and then
 * blocks one, and the same evaluation over 4-cell windows.
 *
 * Two structural differences, both because the shell owns the surrounding
 * furniture:
 *
 * 1. **One human, one computer.** The original also offered local two-player
 *    mode; a versus board ranks *people*, and a two-player game on one device
 *    cannot attribute a win, so the portal version is you against the computer
 *    at medium difficulty.
 * 2. **The board is the input.** `pointerAt` receives a tap in canvas
 *    coordinates and drops into the column under it, which is what the shell's
 *    optional hook exists for. Digits 1–7 do the same thing from a keyboard.
 */

import { isActivationTarget, isTypingTarget } from "../shared/keys";
import { ToneSynth } from "../shared/toneSynth";
import {
  AI_THINK_DELAY,
  AIM_MARGIN,
  BOARD_H,
  BOARD_W,
  BOARD_X,
  BOARD_Y,
  CELL,
  COLORS,
  COLS,
  DIFFICULTY,
  FALL_TIME,
  GAME_H,
  GAME_W,
  INVALID_COLUMN_TIME,
  ROWS,
  type Difficulty,
} from "./constants";
import type { Disc, GameEvents, GamePhase, HudState, MatchOutcome } from "./types";

const EMPTY = 0;
const YOU: Disc = 1;
const COMPUTER: Disc = 2;
const WIN = 1_000_000;

type Cell = Disc | 0;
type Board = Cell[][];

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => new Array<Cell>(COLS).fill(EMPTY));
}

function topRowOf(board: Board, col: number): number {
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    if (board[row]?.[col] === EMPTY) return row;
  }
  return -1;
}

function boardFull(board: Board): boolean {
  for (let col = 0; col < COLS; col += 1) if (topRowOf(board, col) !== -1) return false;
  return true;
}

function winsAt(board: Board, row: number, col: number): boolean {
  const player = board[row]?.[col];
  if (!player) return false;
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let step = 1; step < 4; step += 1) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
        if (board[r]?.[c] !== player) break;
        count += 1;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

/** The four-plus cells of a winning line, for the highlight. */
function winLine(board: Board, row: number, col: number): [number, number][] | null {
  const player = board[row]?.[col];
  if (!player) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const cells: [number, number][] = [[row, col]];
    for (let step = 1; step < 6; step += 1) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[r]?.[c] !== player) break;
      cells.push([r, c]);
    }
    for (let step = 1; step < 6; step += 1) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[r]?.[c] !== player) break;
      cells.unshift([r, c]);
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

/* ------------------------------------------------------------ evaluation */

/** All 4-cell windows, built once: horizontal, vertical and both diagonals. */
const WINDOWS: readonly (readonly [number, number][])[] = (() => {
  const windows: [number, number][][] = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      windows.push([[r, c], [r, c + 1], [r, c + 2], [r, c + 3]]);
    }
  }
  for (let c = 0; c < COLS; c += 1) {
    for (let r = 0; r <= ROWS - 4; r += 1) {
      windows.push([[r, c], [r + 1, c], [r + 2, c], [r + 3, c]]);
    }
  }
  for (let r = 0; r <= ROWS - 4; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      windows.push([[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]]);
    }
  }
  for (let r = 3; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      windows.push([[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]]);
    }
  }
  return windows;
})();

const WEIGHTS = [0, 1, 8, 90, 10_000];

function evaluate(board: Board): number {
  let score = 0;
  // The centre column is worth holding.
  for (let row = 0; row < ROWS; row += 1) {
    const centre = board[row]?.[3];
    if (centre === COMPUTER) score += 4;
    else if (centre === YOU) score -= 4;
  }
  for (const window of WINDOWS) {
    let computer = 0;
    let human = 0;
    for (const [r, c] of window) {
      const value = board[r]?.[c];
      if (value === COMPUTER) computer += 1;
      else if (value === YOU) human += 1;
    }
    if (computer && human) continue;
    if (computer) score += WEIGHTS[computer] ?? 0;
    else if (human) score -= WEIGHTS[human] ?? 0;
  }
  return score;
}

function orderedColumns(board: Board): number[] {
  const order = [3, 2, 4, 1, 5, 0, 6];
  return order.filter((col) => topRowOf(board, col) !== -1);
}

const SEARCH_ABORT = Symbol("search-abort");

interface SearchState {
  nodes: number;
}

function alphaBeta(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  maximising: boolean,
  deadline: number,
  state: SearchState,
): number {
  state.nodes += 1;
  // Check the clock every so often rather than on every node.
  if ((state.nodes & 1023) === 0 && Date.now() > deadline) throw SEARCH_ABORT;

  const columns = orderedColumns(board);
  if (maximising) {
    let best = Number.NEGATIVE_INFINITY;
    for (const col of columns) {
      const row = topRowOf(board, col);
      const line = board[row];
      if (!line) continue;
      line[col] = COMPUTER;
      let value: number;
      try {
        if (winsAt(board, row, col)) value = WIN - (depth - 1);
        else if (boardFull(board)) value = 0;
        else if (depth <= 1) value = evaluate(board);
        else value = alphaBeta(board, depth - 1, alpha, beta, false, deadline, state);
      } finally {
        line[col] = EMPTY;
      }
      if (value > best) best = value;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Number.POSITIVE_INFINITY;
  for (const col of columns) {
    const row = topRowOf(board, col);
    const line = board[row];
    if (!line) continue;
    line[col] = YOU;
    let value: number;
    try {
      if (winsAt(board, row, col)) value = -(WIN - (depth - 1));
      else if (boardFull(board)) value = 0;
      else if (depth <= 1) value = evaluate(board);
      else value = alphaBeta(board, depth - 1, alpha, beta, true, deadline, state);
    } finally {
      line[col] = EMPTY;
    }
    if (value < best) best = value;
    if (best < beta) beta = best;
    if (beta <= alpha) break;
  }
  return best;
}

function findBestMove(board: Board, maxDepth: number, budgetMs: number): number {
  const columns = orderedColumns(board);
  if (columns.length === 0) return -1;
  if (columns.length === 1) return columns[0] ?? -1;

  const start = Date.now();
  const deadline = start + budgetMs;
  const state: SearchState = { nodes: 0 };
  let bestMove = columns[0] ?? -1;

  // Iterative deepening: each completed depth replaces the answer, so a timeout
  // still leaves a usable move from the last full iteration.
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    let bestScore = Number.NEGATIVE_INFINITY;
    let move: number | null = null;
    let completed = true;
    try {
      for (const col of columns) {
        const row = topRowOf(board, col);
        const line = board[row];
        if (!line) continue;
        line[col] = COMPUTER;
        let value: number;
        try {
          if (winsAt(board, row, col)) value = WIN - (depth - 1);
          else if (boardFull(board)) value = 0;
          else if (depth <= 1) value = evaluate(board);
          else value = alphaBeta(board, depth - 1, -Infinity, Infinity, false, deadline, state);
        } finally {
          line[col] = EMPTY;
        }
        if (value > bestScore) {
          bestScore = value;
          move = col;
        }
        if (Date.now() - start > budgetMs) {
          completed = false;
          break;
        }
      }
    } catch (error) {
      if (error !== SEARCH_ABORT) throw error;
      completed = false;
    }

    if (completed && move !== null) bestMove = move;
    else break;
    if (bestScore >= WIN - 10) break;
    if (Date.now() - start > budgetMs) break;
  }
  return bestMove;
}

/* ---------------------------------------------------------------- engine */

interface Fall {
  col: number;
  row: number;
  player: Disc;
  t: number;
}

export class Connect4Game {
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
  private board: Board = emptyBoard();
  private current: Disc = YOU;
  private wins = 0;
  private losses = 0;
  private draws = 0;

  private falling: Fall | null = null;
  private winCells: [number, number][] = [];
  private invalidColumn = -1;
  private invalidTimer = 0;

  private aiPending = false;
  private time = 0;
  private difficulty: Difficulty = "medium";

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

    window.addEventListener("keydown", this.handleKeyDown);
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
    const turn = this.phase === "over" ? "over" : this.current === YOU ? "you" : "computer";
    return { turn, wins: this.wins, losses: this.losses, draws: this.draws };
  }

  start(): void {
    this.audio.unlock();
    this.clearTimers();
    this.board = emptyBoard();
    this.current = YOU;
    this.falling = null;
    this.winCells = [];
    this.invalidColumn = -1;
    this.invalidTimer = 0;
    this.aiPending = false;
    this.wins = 0;
    this.losses = 0;
    this.draws = 0;
    this.setPhase("playing");
    this.emitHud();
  }

  pause(): void {
    if (this.phase !== "playing") return;
    this.clearTimers();
    this.aiPending = false;
    this.setPhase("paused");
  }

  resume(): void {
    if (this.phase !== "paused") return;
    this.audio.unlock();
    this.setPhase("playing");
    // The computer's turn was interrupted; pick it back up.
    if (this.current === COMPUTER && !this.falling) this.scheduleAiMove();
  }

  togglePause(): void {
    if (this.phase === "playing") this.pause();
    else if (this.phase === "paused") this.resume();
  }

  primaryAction(): void {
    if (this.phase === "idle" || this.phase === "over") this.start();
    else if (this.phase === "paused") this.resume();
  }

  /** No on-screen controls: the board itself is the input. */
  setInput(_name: string, down: boolean): void {
    if (down) this.audio.unlock();
  }

  /**
   * A tap on the canvas: column under the pointer, in CSS pixels relative to
   * the canvas. Returns true when the game handled it.
   */
  pointerAt(x: number, y: number): boolean {
    if (this.phase !== "playing") return false;

    const logicalX = (x - this.offsetX) / this.scale;
    const logicalY = (y - this.offsetY) / this.scale;
    if (logicalX < BOARD_X || logicalX >= BOARD_X + BOARD_W) return false;
    if (logicalY < BOARD_Y - AIM_MARGIN || logicalY >= BOARD_Y + BOARD_H) return false;

    const col = Math.floor((logicalX - BOARD_X) / CELL);
    if (col < 0 || col >= COLS) return false;
    this.playHumanMove(col);
    return true;
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
    this.clearTimers();
    window.removeEventListener("keydown", this.handleKeyDown);
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

  private schedule(callback: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) callback();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }

  /* ----------------------------------------------------------------- input */

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    this.audio.unlock();

    // 1–7 pick a column, the keyboard equivalent of tapping the board.
    const cell = Number.parseInt(event.key, 10);
    if (!Number.isNaN(cell) && cell >= 1 && cell <= COLS && this.phase === "playing") {
      event.preventDefault();
      this.playHumanMove(cell - 1);
      return;
    }

    if (event.key === "p" || event.key === "P" || event.key === "Escape") {
      this.togglePause();
      return;
    }
    if (event.key === "m" || event.key === "M") {
      this.toggleMute();
      return;
    }
    if (event.key === "Enter") {
      if (isActivationTarget(event.target)) return;
      this.primaryAction();
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

  /* ------------------------------------------------------------ game flow */

  /** Column of the lowest empty cell, or -1 when the column is full. */
  private landingRow(col: number): number {
    return topRowOf(this.board, col);
  }

  private playHumanMove(col: number): void {
    if (this.phase !== "playing" || this.falling || this.aiPending) return;
    if (this.current !== YOU) return;
    const row = this.landingRow(col);
    if (row === -1) {
      this.invalidColumn = col;
      this.invalidTimer = INVALID_COLUMN_TIME;
      this.audio.tone(160, 0.12, "square", 0.12);
      return;
    }
    this.drop(col, row, YOU);
  }

  private drop(col: number, row: number, player: Disc): void {
    const line = this.board[row];
    if (!line) return;
    line[col] = player;
    this.falling = { col, row, player, t: 0 };
    this.invalidColumn = -1;
    // Soft thud: a falling pitch, like the original's.
    this.audio.tone(player === YOU ? 180 : 150, 0.16, "sine", 0.3);
  }

  private resolveDrop(fall: Fall): void {
    const line = winLine(this.board, fall.row, fall.col);
    if (line) {
      this.winCells = line;
      this.finish(fall.player === YOU ? "win" : "loss");
      return;
    }
    if (boardFull(this.board)) {
      this.finish("draw");
      return;
    }

    this.current = this.current === YOU ? COMPUTER : YOU;
    this.emitHud();
    if (this.current === COMPUTER) this.scheduleAiMove();
  }

  private scheduleAiMove(): void {
    this.aiPending = true;
    this.schedule(() => {
      this.aiPending = false;
      this.aiTurn();
    }, AI_THINK_DELAY * 1000);
  }

  private aiTurn(): void {
    if (this.phase !== "playing" || this.falling) return;
    if (this.current !== COMPUTER) return;

    const col = this.chooseAiColumn();
    if (col === -1) {
      if (boardFull(this.board)) this.finish("draw");
      return;
    }
    const row = this.landingRow(col);
    if (row === -1) return;
    this.drop(col, row, COMPUTER);
  }

  private finish(outcome: MatchOutcome): void {
    if (this.phase === "over") return;
    if (outcome === "win") this.wins += 1;
    else if (outcome === "loss") this.losses += 1;
    else this.draws += 1;

    this.clearTimers();
    this.aiPending = false;
    this.setPhase("over");
    this.emitHud();

    if (outcome === "win") {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
        this.audio.tone(freq, 0.4, "triangle", 0.3, index * 0.12);
      });
    } else if (outcome === "draw") {
      this.audio.tone(330, 0.4, "sine", 0.22);
      this.audio.tone(220, 0.4, "sine", 0.22, 0.12);
    } else {
      this.audio.tone(220, 0.3, "sawtooth", 0.2);
      this.audio.tone(165, 0.4, "sawtooth", 0.18, 0.15);
    }

    this.events.onGameOver?.({ outcome });
  }

  /** The computer's move: take a win, block one, otherwise search. */
  private chooseAiColumn(): number {
    const columns = orderedColumns(this.board);
    if (columns.length === 0) return -1;

    // 1) Win now if possible.
    for (const col of columns) {
      const row = this.landingRow(col);
      const line = this.board[row];
      if (!line) continue;
      line[col] = COMPUTER;
      const wins = winsAt(this.board, row, col);
      line[col] = EMPTY;
      if (wins) return col;
    }

    // 2) Otherwise block the human's immediate win.
    for (const col of columns) {
      const row = this.landingRow(col);
      const line = this.board[row];
      if (!line) continue;
      line[col] = YOU;
      const wins = winsAt(this.board, row, col);
      line[col] = EMPTY;
      if (wins) return col;
    }

    const preset = DIFFICULTY[this.difficulty];
    if (preset.random > 0 && Math.random() < preset.random) {
      return columns[Math.floor(Math.random() * columns.length)] ?? columns[0] ?? -1;
    }
    return findBestMove(this.board, preset.depth, preset.budget);
  }

  /* --------------------------------------------------------------- update */

  private frame = (now: number): void => {
    if (this.destroyed) return;
    const previous = this.lastFrame || now;
    let dt = (now - previous) / 1000;
    this.lastFrame = now;
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;

    this.time += dt;
    if (this.invalidTimer > 0) this.invalidTimer -= dt;

    if (this.phase === "playing" && this.falling) {
      this.falling.t += dt;
      if (this.falling.t >= FALL_TIME) {
        const finished = this.falling;
        this.falling = null;
        this.resolveDrop(finished);
      }
    }

    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  /* ----------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx } = this;

    // Letterbox in device space, so the bars are true black.
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

    this.drawFrame();
    this.drawDiscs();
    this.drawWinLine();
  }

  private drawFrame(): void {
    const { ctx } = this;
    const padding = 10;

    ctx.fillStyle = COLORS.frame;
    ctx.beginPath();
    ctx.roundRect(
      BOARD_X - padding,
      BOARD_Y - padding,
      BOARD_W + padding * 2,
      BOARD_H + padding * 2,
      18,
    );
    ctx.fill();
    ctx.strokeStyle = COLORS.frameEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Holes, tinted red while an invalid column is being refused.
    for (let row = 0; row < ROWS; row += 1) {
      if (this.invalidColumn !== -1 && this.invalidTimer > 0) {
        const x = BOARD_X + this.invalidColumn * CELL;
        ctx.fillStyle = COLORS.invalid;
        ctx.globalAlpha = Math.max(0, this.invalidTimer / INVALID_COLUMN_TIME) * 0.35;
        ctx.fillRect(x, BOARD_Y, CELL, BOARD_H);
        ctx.globalAlpha = 1;
      }
      for (let col = 0; col < COLS; col += 1) {
        const cx = BOARD_X + col * CELL + CELL / 2;
        const cy = BOARD_Y + row * CELL + CELL / 2;
        const radius = CELL * 0.38;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.hole;
        ctx.fill();
      }
    }
  }

  private drawDiscs(): void {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const cell = this.board[row]?.[col];
        if (!cell) continue;
        // The disc in flight is drawn separately, so it is not in two places.
        if (this.falling && this.falling.col === col && this.falling.row === row) continue;
        this.drawDisc(col, row, cell);
      }
    }

    if (this.falling) {
      const progress = Math.min(1, this.falling.t / FALL_TIME);
      // Ease-in, like gravity.
      const eased = progress * progress;
      const targetY = BOARD_Y + this.falling.row * CELL + CELL / 2;
      const startY = BOARD_Y - CELL + CELL / 2;
      const cx = BOARD_X + this.falling.col * CELL + CELL / 2;
      const cy = startY + (targetY - startY) * eased;
      this.drawDiscAt(cx, cy, this.falling.player);
    }
  }

  private drawDisc(col: number, row: number, player: Disc): void {
    const cx = BOARD_X + col * CELL + CELL / 2;
    const cy = BOARD_Y + row * CELL + CELL / 2;
    this.drawDiscAt(cx, cy, player);
  }

  private drawDiscAt(cx: number, cy: number, player: Disc): void {
    const { ctx } = this;
    const radius = CELL * 0.36;
    const color = player === YOU ? COLORS.you : COLORS.computer;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // A highlight up and to the left reads as a glossy counter.
    ctx.beginPath();
    ctx.arc(cx - radius * 0.3, cy - radius * 0.35, radius * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.fill();
  }

  private drawWinLine(): void {
    if (this.winCells.length === 0) return;
    const { ctx } = this;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 6);

    ctx.strokeStyle = COLORS.winRing;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 3;
    for (const [row, col] of this.winCells) {
      const cx = BOARD_X + col * CELL + CELL / 2;
      const cy = BOARD_Y + row * CELL + CELL / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.44, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
