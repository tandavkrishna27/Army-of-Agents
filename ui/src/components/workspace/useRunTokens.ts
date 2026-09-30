import { useMemo } from "react";
import type { RunForIssue } from "../../api/activity";

interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function useRunTokens(runs: RunForIssue[] | undefined): TokenSummary {
  return useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;

    for (const run of runs ?? []) {
      const usage = run.usageJson;
      if (!usage || typeof usage !== "object") continue;
      const inp = usage.inputTokens;
      const out = usage.outputTokens;
      if (typeof inp === "number") inputTokens += inp;
      if (typeof out === "number") outputTokens += out;
    }

    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }, [runs]);
}
