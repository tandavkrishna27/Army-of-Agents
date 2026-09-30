import { z } from "zod";

export const FORMAT_DISPOSITIONS = ["native", "converted", "source_only", "download_only"] as const;
export const FORMAT_FAILURES = [
  "unsupported", "locked", "damaged", "too_large", "codec_unavailable",
  "font_substitution", "resource_limit", "denied",
] as const;

export const formatCapabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  version: z.number().int().positive(),
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1).readonly(),
  preview: z.enum(FORMAT_DISPOSITIONS),
  extraction: z.enum(["text", "structured", "provider_gated", "none"]),
  nativeExport: z.enum(["qualified_writer", "original_only"]),
  processorId: z.string().min(1).nullable(),
  processorBuild: z.string().min(1).nullable(),
  maxInputBytes: z.number().int().positive(),
  limitations: z.array(z.string().min(1).max(500)).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.processorBuild && !value.processorId) {
    ctx.addIssue({ code: "custom", message: "processorBuild requires processorId" });
  }
});

export type FormatDisposition = z.infer<typeof formatCapabilitySchema>["preview"];
export type FormatCapability = z.infer<typeof formatCapabilitySchema>;
export type FormatFailure = (typeof FORMAT_FAILURES)[number];

