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
 * One row per finished Asteroids run.
 *
 * The score is submitted by the client: the game runs in the browser, so the
 * server cannot recompute it. Values are bounded and validated so garbage
 * cannot be stored, but a determined player can still POST any number they
 * like. That is accepted — this is a leaderboard among people who know each
 * other, not an anti-cheat system. Genuine anti-cheat would require simulating
 * the game server-side, which would defeat the point of a client-side arcade
 * game.
 *
 * `playerName` is denormalised on purpose: the leaderboard is visible to every
 * signed-in player, so it must show a chosen nickname and never an email
 * address, and it must not silently rewrite history when an account is renamed.
 */
export const score = pgTable(
  "score",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    // Leaderboard read is ORDER BY score DESC LIMIT n; rank is "how many rows
    // beat this score". Both are range scans over this index.
    index("score_ranking_idx").on(table.score),
    index("score_userId_createdAt_idx").on(table.userId, table.createdAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  notes: many(note),
  scores: many(score),
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

export const schema = {
  user,
  session,
  account,
  verification,
  note,
  score,
  userRelations,
  sessionRelations,
  accountRelations,
  noteRelations,
  scoreRelations,
};
