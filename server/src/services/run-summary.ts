const MAX_RUN_SUMMARY_FILES = 10;

export interface RunSummaryInput {
  agentName: string;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  detectedFiles: Array<{ path: string; type?: string }>;
}

export function formatRunSummary(input: RunSummaryInput): string {
  const { agentName, outcome, durationMs, inputTokens, outputTokens, costUsd, errorMessage, detectedFiles } = input;

  // Duration formatting
  const totalSec = Math.floor(durationMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const durationStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

  // Token formatting
  const tokensIn = inputTokens != null ? inputTokens.toLocaleString() : "N/A";
  const tokensOut = outputTokens != null ? outputTokens.toLocaleString() : "N/A";

  // Cost formatting
  const costStr = costUsd != null ? `$${costUsd.toFixed(2)}` : "N/A";

  // Outcome
  const outcomeLabel =
    outcome === "succeeded"
      ? "\u2705 Succeeded"
      : outcome === "failed"
        ? `\u274C Failed${errorMessage ? ` \u2014 ${errorMessage}` : ""}`
        : outcome === "timed_out"
          ? "\u23F1\uFE0F Timed out"
          : "\u26D4 Cancelled";

  let summary = `\uD83E\uDD16 **Run Summary** \u2014 ${agentName}\n`;
  summary += `Duration: ${durationStr} | Tokens: ${tokensIn} in / ${tokensOut} out | Cost: ${costStr}\n`;
  summary += `Outcome: ${outcomeLabel}`;

  // Files
  if (detectedFiles.length > 0) {
    const shown = detectedFiles.slice(0, MAX_RUN_SUMMARY_FILES);
    const remaining = detectedFiles.length - shown.length;
    const fileLines = shown.map((f) => `\`${f.path}\``).join(", ");
    summary += `\nFiles: ${fileLines}`;
    if (remaining > 0) {
      summary += ` +${remaining} more`;
    }
  }

  return summary;
}
