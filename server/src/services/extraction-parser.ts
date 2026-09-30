/**
 * Pure parser module for discussion-entry extraction output.
 *
 * Kept separate from extraction.ts so that extraction-cli.ts (which calls
 * parseExtractedItems) can import this module without creating a circular
 * dependency: extraction-cli → extraction-parser (here), while
 * extraction.ts re-exports these symbols for existing importers.
 *
 * No database imports. No side-effects. Pure TS.
 */

/**
 * Item types the extractor can produce. Mirrors the six legacy types used by
 * the autonomous Scribe flow plus the two thread-specific types introduced for
 * Phase 1 (`artifact`, `spin_off_thread`). The DB column comment on
 * `discussion_extracted_items.type` already documents all eight.
 *
 * NOTE: `parseExtractedItems` below currently accepts only the six legacy
 * types — that is intentional. The legacy autonomous flow never asks the LLM
 * to emit `artifact` / `spin_off_thread`; the tool-callable extractors (Task
 * C1 named exports) inherit the same prompt and so only ever yield the six.
 * If Phase-1 thread tools later need the new types they can broaden
 * `VALID_EXTRACTED_TYPES` and the prompt together — keeping the type union
 * exhaustive here avoids a second source of truth.
 */
export type ExtractedItemType =
  | "decision"
  | "task"
  | "insight"
  | "context"
  | "reference"
  | "preference"
  | "artifact"
  | "spin_off_thread";

export interface ExtractedItem {
  type: "decision" | "task" | "insight" | "context" | "reference" | "preference";
  title: string;
  description: string;
  priority?: "urgent" | "high" | "medium" | "low";
  department?: string | null;
  layer?: "identity" | "domain" | "active_context" | "working" | null;
}

/**
 * Parse the LLM response text into structured items.
 * Handles potential markdown code fences around JSON.
 */
export function parseExtractedItems(text: string): ExtractedItem[] {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON array");
  }

  const validTypes = new Set(["decision", "task", "insight", "context", "reference", "preference"]);
  const validPriorities = new Set(["urgent", "high", "medium", "low"]);
  const validLayers = new Set(["identity", "domain", "active_context", "working"]);

  return parsed
    .filter((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.type === "string" &&
        validTypes.has(obj.type) &&
        typeof obj.title === "string" &&
        obj.title.length > 0
      );
    })
    .map((item: Record<string, unknown>) => ({
      type: item.type as ExtractedItem["type"],
      title: String(item.title),
      description: typeof item.description === "string" ? item.description : "",
      priority:
        item.type === "task" &&
        typeof item.priority === "string" &&
        validPriorities.has(item.priority)
          ? (item.priority as ExtractedItem["priority"])
          : undefined,
      department:
        typeof item.department === "string" ? item.department : null,
      layer:
        typeof item.layer === "string" && validLayers.has(item.layer)
          ? (item.layer as ExtractedItem["layer"])
          : null,
    }));
}
