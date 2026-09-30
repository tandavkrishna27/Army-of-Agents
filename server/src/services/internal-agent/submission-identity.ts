import { createHash } from "node:crypto";
import type { CommanderContextScope, UniverseContext } from "@armyofagents/shared";

export interface CommanderSubmissionIdentityInput {
  conversationId: string;
  message: string;
  attachmentAssetIds?: string[];
  departmentContext?: string | null;
  contextScope?: CommanderContextScope | null;
  universeContext?: UniverseContext;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/** Ambient pageContext is intentionally absent: it may change without changing
 * the frozen instruction. Ordered attachment identity and explicit context are
 * part of the admitted intent. */
export function hashCommanderSubmission(input: CommanderSubmissionIdentityInput): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    conversationId: input.conversationId,
    message: input.message,
    attachmentAssetIds: input.attachmentAssetIds ?? [],
    departmentContext: input.departmentContext ?? null,
    contextScope: input.contextScope ?? null,
    universeContext: input.universeContext ?? null,
  }))).digest("hex");
}
