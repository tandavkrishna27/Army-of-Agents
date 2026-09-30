/**
 * Adapter types shipped with AoA. External plugins must not replace these.
 *
 * Ported from Paperclip (2026-04-20, Phase 0 Task 0.3). The set differs from
 * Paperclip's because AoA registers a different builtin lineup — it ships BOTH
 * "openclaw" and "openclaw_gateway", and includes "pi_local". Sprint 2A
 * (2026-04-24) dropped the API adapters in favor of CLI-only execution — see
 * Decision #91. CLI-002 dispositions every type in this set (see
 * server/src/services/sandbox-coding-disposition.ts).
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
