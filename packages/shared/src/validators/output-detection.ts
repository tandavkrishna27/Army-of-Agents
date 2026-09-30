import { z } from "zod";
import { ARTIFACT_TYPES } from "../constants.js";

export const confirmDetectedOutputSchema = z.object({
  artifactId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  type: z.enum(ARTIFACT_TYPES).optional(),
  changelog: z.string().optional().nullable(),
});

export type ConfirmDetectedOutput = z.infer<typeof confirmDetectedOutputSchema>;
