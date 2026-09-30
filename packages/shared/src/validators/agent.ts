import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

const adapterConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-family + shell-safety refinement helpers (pure; no server imports)
// ---------------------------------------------------------------------------

// NOTE: intentionally duplicated from server/src/services/internal-agent/codex-model.ts
// (SAFE_MODEL_RE) — the shared package cannot import from server. Keep the two in sync:
// if you change this, change codex-model.ts too (and vice versa).
// `:` is allowed as a shell-safe tag separator: OpenCode/Pi discover ollama-style
// tagged ids verbatim (e.g. `ollama/llama3.1:8b`), and `:` is not a shell
// metacharacter mid-argument — so it must pass this gate, not be rejected (Codex P2).
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

// Shell-safety consistent with the server's isShellSafeModel (Unit B): a model
// may be a provider/model slash id (opencode); validate EACH segment (no
// segment-count cap). Exported so the route layer can reject a model-only PATCH
// (no adapterType in the body → the schema refine below early-returns) with the
// SAME rule the schema uses — route and schema must never diverge (Codex P2).
export function isShellSafeModelId(model: string): boolean {
  // Validate EACH slash segment for shell-safety, with NO segment-count cap:
  // OpenCode ids can carry a nested provider namespace (e.g.
  // openrouter/anthropic/claude-sonnet-4), which the adapter's own discovery
  // validates. Each segment must still be a plain identifier (SAFE_MODEL_RE), so
  // the joined id stays shell-safe. Keep in sync with codex-model.ts isShellSafeModel.
  const segments = model.split("/");
  return segments.every((s) => SAFE_MODEL_RE.test(s));
}

function modelFamily(model: string): "claude" | "openai" | "gemini" | "unknown" {
  const m = model.includes("/") ? model.split("/").pop()! : model; // opencode openai/<id>
  if (/^claude-/i.test(m)) return "claude";
  // gpt-*, o<N>, chatgpt-*, AND codex-* (api-key-only Codex models). Mirrors
  // codex-model.ts CODEX_FAMILY_RE so the save-side family guard rejects a Codex
  // model on a non-OpenAI adapter (e.g. claude_local + codex-mini-latest).
  if (/^(gpt-|o\d|chatgpt|codex)/i.test(m)) return "openai";
  if (/^gemini-|^auto$/i.test(m)) return "gemini";
  return "unknown";
}

const ADAPTER_FAMILY: Record<string, "claude" | "openai" | "gemini"> = {
  claude_local: "claude",
  codex_local: "openai",
  // opencode_local is intentionally NOT family-pinned: OpenCode is multi-provider
  // (provider/model slash ids, e.g. anthropic/claude-..., google/gemini-...).
  // Compatibility is validated by OpenCode's own ensureOpenCodeModelConfiguredAndAvailable
  // (run on create/hire/patch); shell-safety still applies via isShellSafeModelId.
  gemini_local: "gemini",
};

// Pure family-compatibility check, shared by the schema refinement (create / hire /
// update) and the route's adapter-only PATCH guard so the rule lives in ONE place.
// Returns a human-readable reason string on a genuine cross-family mismatch, else null.
// Returns null when adapterType/model is absent, the model family is unknown, or the
// adapter has no pinned family (opencode_local is intentionally exempt — see ADAPTER_FAMILY).
export function adapterModelFamilyMismatch(
  adapterType: string | undefined,
  model: string | undefined,
): string | null {
  if (!adapterType || typeof model !== "string" || model.length === 0) return null;
  const fam = modelFamily(model);
  const expected = ADAPTER_FAMILY[adapterType];
  if (expected && fam !== "unknown" && fam !== expected) {
    return `Model "${model}" (${fam}) does not match adapter ${adapterType} (${expected}).`;
  }
  return null;
}

// `val` is loosely typed because this refinement runs across the create / hire /
// (partial) update shapes — all of which carry adapterType + adapterConfig.
function refineAdapterModel(
  val: { adapterType?: string; adapterConfig?: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const at = val.adapterType;
  const model = val.adapterConfig?.model;
  if (!at || typeof model !== "string" || model.length === 0) return;

  if (!isShellSafeModelId(model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adapterConfig", "model"],
      message: `Unsafe model identifier: ${model}`,
    });
    return;
  }

  const mismatch = adapterModelFamilyMismatch(at, model);
  if (mismatch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adapterConfig", "model"],
      message: mismatch,
    });
  }
}

// ---------------------------------------------------------------------------
// Base object — NOT exported directly; derived schemas all chain from this.
// ZodEffects (.superRefine) does not have .extend/.omit, so we apply
// superRefine LAST on each exported schema after any structural transforms.
// ---------------------------------------------------------------------------

const _createAgentBase = z.object({
  name: z.string().min(1),
  kind: z.enum(["org", "aoa"]).optional().default("org"),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  parentType: z.enum(["agent", "user"]).nullable().optional(),
  parentId: z.string().nullable().optional(),
  capabilities: z.string().optional().nullable(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES).optional().default("process"),
  adapterConfig: adapterConfigSchema.optional().default({}),
  runtimeConfig: z.record(z.unknown()).optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  skillKeys: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const createAgentSchema = _createAgentBase.superRefine(refineAdapterModel);

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = _createAgentBase
  .extend({
    sourceIssueId: z.string().uuid().optional().nullable(),
    sourceIssueIds: z.array(z.string().uuid()).optional(),
  })
  .superRefine(refineAdapterModel);

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = _createAgentBase
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    skillKeys: z.array(z.string()).optional(),
    defaultEnvironmentId: z.string().uuid().optional().nullable(),
    // Optimistic-concurrency token. OPTIONAL: when present, the update is
    // guarded against `agents.updatedAt` (atomic conditional UPDATE → 409 on
    // mismatch). When absent, the write is last-write-wins (full back-compat).
    // Token = the agent row's `updatedAt` as a millisecond-precision ISO string.
    // The server compares it at ms precision (date_trunc) because the stored
    // column is microsecond-precision — see Decision #104.
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine(refineAdapterModel);

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const updateAgentInstructionsBundleSchema = z.object({
  mode: z.enum(["managed", "external"]).optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  environmentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
