import { z } from "zod";

/** WS6 — content-size cap enforced at capture time (DB write). This is
 *  larger than the prompt-injection cap (BRAINDUMP_CONTENT_PROMPT_CAP=12000
 *  in server/.../aoa-trigger-prompt.ts) — the full text is stored even
 *  though only the head of it is ever injected into a single wakeup prompt. */
export const BRAINDUMP_CONTENT_MAX_LENGTH = 20000;

/** Which memory scope a capture seeds. "company" → identity-layer proposals
 *  filed under the "Company" seed folder; "department" → domain-layer under
 *  the department's urlKey folder. */
export const braindumpScopeSchema = z.enum(["company", "department"]);
export type BraindumpScope = z.infer<typeof braindumpScopeSchema>;

/**
 * Item 5 (multi-scope memory): a capture is seeded by TEXT, FILES, or both.
 *
 * `content` deliberately has NO `.min(1)` — a file-only card (drop a PDF, type
 * nothing) is a valid capture, and requiring non-empty text would 400 it. The
 * "at least one source" rule is enforced by the refine below instead.
 */
export const submitBraindumpSchema = z
  .object({
    scope: braindumpScopeSchema.default("department"),
    /** NULL/omitted for company scope; required for department scope. */
    departmentId: z.string().uuid().nullable().default(null),
    content: z.string().trim().max(BRAINDUMP_CONTENT_MAX_LENGTH),
    /** `memory_assets.id`s already created by /memory/assets/upload. */
    assetIds: z.array(z.string().uuid()).default([]),
    idempotencyKey: z.string().min(1).max(200),
  })
  .refine(
    (v) => (v.scope === "department" ? v.departmentId !== null : v.departmentId === null),
    {
      message:
        'departmentId is required when scope is "department" and must be null when scope is "company"',
      path: ["departmentId"],
    },
  )
  .refine((v) => v.content.length > 0 || v.assetIds.length > 0, {
    message: "Provide some text or at least one file",
    path: ["content"],
  });

export type SubmitBraindump = z.infer<typeof submitBraindumpSchema>;
