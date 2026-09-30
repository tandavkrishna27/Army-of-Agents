import { z } from "zod";

export const USER_ENTITY_FOLLOW_TYPES = ["task", "project", "goal"] as const;
export type UserEntityFollowType = (typeof USER_ENTITY_FOLLOW_TYPES)[number];

export const createUserEntityFollowSchema = z.object({
  entityType: z.enum(USER_ENTITY_FOLLOW_TYPES),
  entityId: z.string().uuid(),
}).strict();

export type CreateUserEntityFollow = z.infer<typeof createUserEntityFollowSchema>;

export interface UserEntityFollow {
  id: string;
  userId: string;
  companyId: string;
  entityType: UserEntityFollowType;
  entityId: string;
  followedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
