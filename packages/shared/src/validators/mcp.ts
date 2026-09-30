import { z } from "zod";

export const createMcpApiKeySchema = z.object({
  name: z.string().min(1).max(120),
});

export type CreateMcpApiKey = z.infer<typeof createMcpApiKeySchema>;

export const updateMcpSettingsSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateMcpSettings = z.infer<typeof updateMcpSettingsSchema>;
