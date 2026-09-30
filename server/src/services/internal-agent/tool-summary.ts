export const TOOL_SUMMARY_CAP = 600;

export function truncateForWire(s: unknown): string {
  const text = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return text.length > TOOL_SUMMARY_CAP ? text.slice(0, TOOL_SUMMARY_CAP) + "…" : text;
}

/**
 * For MCP tools the parser sets result.summary to the FULL envelope JSON string.
 * Prefer the envelope's human `summary` field so the expandable activity view
 * shows readable text, not raw JSON. Built-in tool output is not an envelope →
 * passed through verbatim (still truncated; always rendered as escaped plaintext).
 */
export function humanToolSummary(name: string, raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  if (name.startsWith("mcp__")) {
    try {
      const env = JSON.parse(text) as { summary?: unknown };
      if (typeof env.summary === "string" && env.summary.length > 0) {
        return truncateForWire(env.summary);
      }
    } catch {
      /* not an envelope — fall through to raw */
    }
  }
  return truncateForWire(text);
}
