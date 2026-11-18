import type { AuthSessionData, AuthUser } from "./auth.js";
import type { schema } from "./db/index.js";

/** Per-request values populated by the session middleware. */
export interface AppEnv {
  Variables: {
    user: AuthUser;
    session: AuthSessionData;
  };
}

export type Note = typeof schema.note.$inferSelect;
export type NewNote = typeof schema.note.$inferInsert;
