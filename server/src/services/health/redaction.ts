export const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRecentFailure(createdAt: Date, now = new Date()): boolean {
  return createdAt.getTime() >= now.getTime() - RECENT_FAILURE_WINDOW_MS;
}

export function sanitizeHealthDiagnostic(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  return value
    .replace(/\/\/([^/?#\s:@]+):([^/?#\s@]+)@/g, "//[redacted]@")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)([^;\s]+)/gi, "$1[redacted]")
    .replace(/(\bbearer\s+)([^;\s]+)/gi, "$1[redacted]")
    .replace(
      /(\b[A-Z0-9_]*?(?:token|secret|password|api[_-]?key|apikey)[A-Z0-9_]*?\s*[:=]\s*)([^;\s]+)/gi,
      "$1[redacted]",
    )
    .slice(0, 500);
}
