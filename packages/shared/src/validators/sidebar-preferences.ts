import { z } from "zod";

const orderedIdSchema = z.string().uuid();

export const sidebarPreferencesSchema = z.object({
  departmentOrder: z.array(orderedIdSchema),
  projectOrder: z.array(orderedIdSchema),
  updatedAt: z.coerce.date().nullable(),
});

export type SidebarPreferences = z.infer<typeof sidebarPreferencesSchema>;

export const updateSidebarPreferencesSchema = z
  .object({
    departmentOrder: z.array(orderedIdSchema).optional(),
    projectOrder: z.array(orderedIdSchema).optional(),
  })
  .strict();

export type UpdateSidebarPreferences = z.infer<typeof updateSidebarPreferencesSchema>;
