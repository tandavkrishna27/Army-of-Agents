import { z } from "zod";

export const INBOX_DISMISSAL_ITEM_KEY_REGEX =
  /^(approval|join|run|stale|alert|discussion|issue):.+$/;

export const inboxDismissalSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  companyId: z.string().uuid(),
  itemKey: z.string(),
  dismissedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type InboxDismissal = z.infer<typeof inboxDismissalSchema>;

export const createInboxDismissalSchema = z
  .object({
    itemKey: z
      .string()
      .trim()
      .min(1)
      .regex(INBOX_DISMISSAL_ITEM_KEY_REGEX, "Unsupported inbox item key"),
  })
  .strict();

export type CreateInboxDismissal = z.infer<typeof createInboxDismissalSchema>;
