/**
 * Adapter types shipped with AoA. External plugins must not replace these.
 *
 * AoA uses "openclaw" rather than "openclaw_gateway" and has no "pi_local".
 * Decision #91 dropped API adapters in favor of CLI-only execution.
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "acpx_local",
  "codex_local",
  "cursor",
  "cursor_cloud",
  "grok_local",
  "pi_local",
  "gemini_local",
  "openclaw",
  "openclaw_gateway",
  "opencode_local",
  "hermes_local",
  "process",
  "http",
]);
