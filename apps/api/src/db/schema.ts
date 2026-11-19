import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Better Auth core tables (generated shape for better-auth 1.7.x).
 *
 * These four tables are owned by Better Auth — don't hand-edit column names
 * without regenerating against the installed version, because the adapter
 * looks them up by name.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * Application data. Everything below this line is yours; nothing here is
 * owned by the auth layer.
 */
export const note = pgTable(
  "note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("note_userId_createdAt_idx").on(table.userId, table.createdAt)],
);

/**
 * One row per finished run of any game.
 *
 * The score is submitted by the client: the game runs in the browser, so the
 * server cannot recompute it. Values are bounded and validated so garbage
 * cannot be stored, but a determined player can still POST any number they
 * like. That is accepted — this is a leaderboard among people who know each
 * other, not an anti-cheat system. Genuine anti-cheat would require simulating
 * each game server-side, which would defeat the point of a client-side arcade.
 *
 * `game` is the slug from the server's allowlist (`src/games.ts`), and it is
 * part of the *identity* of a score: every read and rank query is scoped by it,
 * so games never share a board. The default is what backfills rows written
 * before the portal had more than one game.
 *
 * `playerName` is denormalised on purpose: the leaderboard is visible to every
 * signed-in player, so it must show a chosen nickname and never an email
 * address, and it must not silently rewrite history when an account is renamed.
 */
export const score = pgTable(
  "score",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    game: text("game").notNull().default("asteroids"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    playerName: text("playerName").notNull(),
    score: integer("score").notNull(),
    level: integer("level").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Board read: WHERE game = ? ORDER BY score DESC LIMIT n. Rank:
    // "how many rows of this game beat this score". Both are range scans.
    index("score_game_ranking_idx").on(table.game, table.score),
    // "Your best in this game": WHERE game = ? AND userId = ? ORDER BY score DESC.
    index("score_game_user_idx").on(table.game, table.userId, table.score),
  ],
);

/**
 * One row per finished *match* of a versus game (Connect 4).
 *
 * A separate table rather than a nullable `outcome` column on `score` on
 * purpose: a run's score and a match's winner are different facts, and mixing
 * them would mean every score query carrying a `kind` filter and every reader
 * wondering whether `score` is points or a win flag.
 *
 * `outcome` is the **human player's** result — `win` / `loss` / `draw` — so the
 * board answers "how good is this player?" rather than "who won that game?".
 */
export const gameMatch = pgTable(
  "game_match",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    game: text("game").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    playerName: text("playerName").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The board aggregates per player: win/loss/draw counts grouped by user.
    index("game_match_game_user_idx").on(table.game, table.userId),
    index("game_match_game_createdAt_idx").on(table.game, table.createdAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  notes: many(note),
  scores: many(score),
  matches: many(gameMatch),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const noteRelations = relations(note, ({ one }) => ({
  user: one(user, { fields: [note.userId], references: [user.id] }),
}));

export const scoreRelations = relations(score, ({ one }) => ({
  user: one(user, { fields: [score.userId], references: [user.id] }),
}));

export const gameMatchRelations = relations(gameMatch, ({ one }) => ({
  user: one(user, { fields: [gameMatch.userId], references: [user.id] }),
}));

export const schema = {
  user,
  session,
  account,
  verification,
  note,
  score,
  gameMatch,
  userRelations,
  sessionRelations,
  accountRelations,
  noteRelations,
  scoreRelations,
  gameMatchRelations,
};
