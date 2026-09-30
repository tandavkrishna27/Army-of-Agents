import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, userNotes } from "@armyofagents/db";
import type { CreateUserNote, UpdateUserNote, UserNoteColor, UserNoteDto } from "@armyofagents/shared";
import { notFound } from "../errors.js";

type UserNoteRow = typeof userNotes.$inferSelect;

function toDto(row: UserNoteRow): UserNoteDto {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    title: row.title,
    body: row.body,
    color: row.color as UserNoteColor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function logNoteActivity(
  db: Db,
  companyId: string,
  userId: string,
  noteId: string,
  action: "user_note.created" | "user_note.updated" | "user_note.archived",
) {
  await db.insert(activityLog).values({
    companyId,
    actorType: "board",
    actorId: userId,
    action,
    entityType: "user_note",
    entityId: noteId,
  });
}

export function userNotesService(db: Db) {
  return {
    async list(companyId: string, userId: string): Promise<UserNoteDto[]> {
      const rows = await db
        .select()
        .from(userNotes)
        .where(
          and(
            eq(userNotes.companyId, companyId),
            eq(userNotes.userId, userId),
            isNull(userNotes.archivedAt),
          ),
        )
        .orderBy(desc(userNotes.updatedAt));

      return rows.map(toDto);
    },

    async create(companyId: string, userId: string, input: CreateUserNote): Promise<UserNoteDto> {
      const now = new Date();
      const [row] = await db
        .insert(userNotes)
        .values({
          companyId,
          userId,
          title: input.title ?? null,
          body: input.body,
          color: input.color ?? "yellow",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await logNoteActivity(db, companyId, userId, row.id, "user_note.created");
      return toDto(row);
    },

    async update(
      companyId: string,
      userId: string,
      noteId: string,
      input: UpdateUserNote,
    ): Promise<UserNoteDto> {
      const patch: Partial<typeof userNotes.$inferInsert> = {
        updatedAt: new Date(),
      };

      if ("title" in input) patch.title = input.title ?? null;
      if ("body" in input) patch.body = input.body;
      if ("color" in input) patch.color = input.color;

      const [row] = await db
        .update(userNotes)
        .set(patch)
        .where(
          and(
            eq(userNotes.id, noteId),
            eq(userNotes.companyId, companyId),
            eq(userNotes.userId, userId),
            isNull(userNotes.archivedAt),
          ),
        )
        .returning();

      if (!row) throw notFound("Note not found");

      await logNoteActivity(db, companyId, userId, row.id, "user_note.updated");
      return toDto(row);
    },

    async archive(companyId: string, userId: string, noteId: string): Promise<void> {
      const [row] = await db
        .update(userNotes)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(userNotes.id, noteId),
            eq(userNotes.companyId, companyId),
            eq(userNotes.userId, userId),
            isNull(userNotes.archivedAt),
          ),
        )
        .returning({ id: userNotes.id });

      if (!row) throw notFound("Note not found");

      await logNoteActivity(db, companyId, userId, row.id, "user_note.archived");
    },
  };
}
