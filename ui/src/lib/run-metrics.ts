import type { HeartbeatRun } from "@armyofagents/shared";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]): number {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export interface RunMetrics {
  input: number;
  output: number;
  cached: number;
  cost: number;
  totalTokens: number;
}

export function runMetrics(run: Pick<HeartbeatRun, "usageJson" | "resultJson">): RunMetrics {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = (run.resultJson ?? null) as Record<string, unknown> | null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached = usageNumber(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
  );
  const cost =
    usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
    usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
  return { input, output, cached, cost, totalTokens: input + output };
}
