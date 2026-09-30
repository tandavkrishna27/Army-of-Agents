function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export type StderrSeverity = "hidden" | "diagnostic" | "error";

export function classifyStderr(text: string): StderrSeverity {
  const normalized = compactWhitespace(text).toLowerCase();

  if (
    normalized.startsWith("[paperclip] skipping saved session resume") ||
    normalized.startsWith("[aoa] skipping saved session resume")
  ) {
    return "hidden";
  }

  if (
    normalized.startsWith("[aoa] copied shared codex auth.json") ||
    normalized.startsWith("[aoa] loaded agent instructions") ||
    normalized.startsWith("[aoa] app preview detection") ||
    normalized.includes("codex_core::shell_snapshot") ||
    normalized.includes("codex_core_plugins::manifest: ignoring interface.") ||
    normalized.includes("codex_core_skills::loader: ignoring interface.") ||
    normalized.includes("codex_core_plugins::startup_sync") ||
    normalized.includes("codex_core_plugins::startup_remote_sync") ||
    normalized.includes("curated plugin sync") ||
    normalized.includes("failed to warm featured plugin ids cache") ||
    normalized.includes("cf-mitigated") ||
    normalized.includes("cloudflare")
  ) {
    return "diagnostic";
  }

  if (
    normalized.startsWith("error") ||
    normalized.includes("access is denied") ||
    normalized.includes("permission denied") ||
    normalized.includes("uncaught") ||
    normalized.includes("traceback")
  ) {
    return "error";
  }

  return "error";
}
