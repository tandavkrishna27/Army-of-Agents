import { z } from "zod";

export const createUserEntityPinSchema = z
  .object({
    entityType: z.enum(["task", "artifact", "goal"]),
    entityId: z.string().uuid(),
  })
  .strict();

export type CreateUserEntityPin = z.infer<typeof createUserEntityPinSchema>;
