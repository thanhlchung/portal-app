import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, schema } from "../db/index.js";
import type { AppEnv } from "../types.js";

/**
 * Validation is declared on the route rather than inside the handler. Besides
 * rejecting bad input before any work happens, it is what makes the PWA's
 * typed client able to see the request body shape: `zValidator('json', …)`
 * feeds Hono's route type, which `hc<AppType>` reads.
 */
export const createNoteBody = z.object({
  title: z.string().trim().min(1, "Give it a title").max(200),
  body: z.string().max(10_000).default(""),
});

export const updateNoteBody = z
  .object({
    title: z.string().trim().min(1, "Give it a title").max(200).optional(),
    body: z.string().max(10_000).optional(),
  })
  .refine((value) => value.title !== undefined || value.body !== undefined, {
    message: "nothing_to_update",
  });

const idParam = z.object({ id: z.uuid("Not a valid id") });

const json = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "invalid_body", issues: result.error.issues }, 400);
    }
  });

export const notesRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.note)
      .where(eq(schema.note.userId, user.id))
      .orderBy(desc(schema.note.updatedAt));
    return c.json({ notes: rows });
  })

  .post("/", json(createNoteBody), async (c) => {
    const user = c.get("user");
    const { title, body } = c.req.valid("json");

    const db = await getDb();
    const [row] = await db
      .insert(schema.note)
      .values({ userId: user.id, title, body })
      .returning();

    return c.json({ note: row! }, 201);
  })

  .patch(
    "/:id",
    zValidator("param", idParam, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_id" }, 400);
    }),
    json(updateNoteBody),
    async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");

      const db = await getDb();
      const [row] = await db
        .update(schema.note)
        .set({ ...patch, updatedAt: new Date() })
        // The userId predicate is the authorization check: matching on id alone
        // would let any signed-in user edit anyone else's row.
        .where(and(eq(schema.note.id, id), eq(schema.note.userId, user.id)))
        .returning();

      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json({ note: row });
    },
  )

  .delete(
    "/:id",
    zValidator("param", idParam, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_id" }, 400);
    }),
    async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");

      const db = await getDb();
      const [row] = await db
        .delete(schema.note)
        .where(and(eq(schema.note.id, id), eq(schema.note.userId, user.id)))
        .returning({ id: schema.note.id });

      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json({ deleted: row.id });
    },
  );

export type NotesRoutes = typeof notesRoutes;
