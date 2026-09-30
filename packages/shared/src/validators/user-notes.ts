import { z } from "zod";
import { USER_NOTE_COLORS } from "../user-notes.js";

export const userNoteColorSchema = z.enum(USER_NOTE_COLORS);

export const createUserNoteSchema = z
  .object({
    title: z.string().trim().max(120).nullable().optional(),
    body: z.string().max(10_000).default(""),
    color: userNoteColorSchema.optional(),
  })
  .strict();

export const updateUserNoteSchema = z
  .object({
    title: z.string().trim().max(120).nullable().optional(),
    body: z.string().max(10_000).optional(),
    color: userNoteColorSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type CreateUserNote = z.infer<typeof createUserNoteSchema>;
export type UpdateUserNote = z.infer<typeof updateUserNoteSchema>;
