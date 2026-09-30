# Agent Page Redesign — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the agent page's pure logic (run status/metrics, KPI math, env redaction, view parsing) into focused, unit-tested `ui/src/lib/` modules — with zero UI behavior change — so later phases (hero KPI strip, shared `RunRow`) build on tested foundations.

**Architecture:** Pure-function extraction. Each helper moves to a focused module under `ui/src/lib/`, gets a Vitest unit test, and the original call sites import from the new module. No component markup changes; no API/wire changes. This is the de-risking refactor that precedes the visual redesign.

**Tech Stack:** TypeScript, Vitest 3.0.5 (jsdom not required — pure fns), React (call sites only). Design doc: `docs/aoa/plans/2026-06-24-agent-page-redesign-design.md` (§10 testing, Appendix B).

**Run from:** worktree `C:/Users/TK/.aoa/wt/agent-page-redesign`. Test command (single file): `pnpm --filter @armyofagents/ui exec vitest run <path>`. Full UI suite: `pnpm --filter @armyofagents/ui test:run`. Typecheck: `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit` (or root `pnpm -r typecheck`).

**Parity principle:** every extracted function is copied byte-for-byte (same regexes, same key order, same rounding). Tests assert current behavior so a later refactor can't silently change it.

---

### Task 1: Shared run-status module (dedupe `AgentDetail` ↔ `AoaRunsPanel`)

**Files:**
- Create: `ui/src/lib/run-status.ts`
- Test: `ui/src/lib/__tests__/run-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/run-status.test.ts
import { describe, it, expect } from "vitest";
import { CheckCircle2, Clock } from "lucide-react";
import { getRunStatusIcon, formatDuration, triggerTypeColors, runSourceLabels } from "../run-status";

describe("getRunStatusIcon", () => {
  it("maps known statuses", () => {
    expect(getRunStatusIcon("succeeded").icon).toBe(CheckCircle2);
    expect(getRunStatusIcon("succeeded").color).toContain("green");
  });
  it("falls back to a neutral Clock for unknown status", () => {
    const fallback = getRunStatusIcon("totally_unknown");
    expect(fallback.icon).toBe(Clock);
    expect(fallback.color).toContain("neutral");
  });
});

describe("formatDuration", () => {
  it("returns '-' for null/zero/negative", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(0)).toBe("-");
    expect(formatDuration(-5)).toBe("-");
  });
  it("formats sub-minute as seconds", () => {
    expect(formatDuration(4200)).toBe("4s");
  });
  it("formats minutes + seconds", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
  });
});

describe("maps", () => {
  it("has the four trigger-type colors and source labels", () => {
    expect(Object.keys(triggerTypeColors)).toEqual(
      expect.arrayContaining(["conversation", "proactive", "event", "sub_agent"]),
    );
    expect(runSourceLabels.on_demand).toBe("On-demand");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-status.test.ts`
Expected: FAIL — cannot resolve `../run-status`.

- [ ] **Step 3: Write the module**

```ts
// ui/src/lib/run-status.ts
import { CheckCircle2, XCircle, Clock, Loader2, Slash, Timer, type LucideIcon } from "lucide-react";

export interface RunStatusIcon {
  icon: LucideIcon;
  color: string;
}

/** Canonical run-status → icon/color map. `running` does NOT bake in animate-spin;
 *  callers add `animate-spin` at render for running (keeps the map render-agnostic). */
export const runStatusIcons: Record<string, RunStatusIcon> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

export function getRunStatusIcon(status: string): RunStatusIcon {
  return (
    runStatusIcons[status] ?? {
      icon: Clock,
      color: "text-neutral-500 dark:text-neutral-400",
    }
  );
}

export const runSourceLabels: Record<string, string> = {
  timer: "Timer",
  assignment: "Assignment",
  on_demand: "On-demand",
  automation: "Automation",
};

export const triggerTypeColors: Record<string, string> = {
  conversation: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  proactive: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  event: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  sub_agent: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
};

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-status.test.ts`
Expected: PASS (3 describes).

- [ ] **Step 5: Rewire `AoaRunsPanel.tsx` to the shared module**

In `ui/src/components/agent-detail/AoaRunsPanel.tsx`: delete the local `runStatusIcons` (lines ~21-28), `triggerTypeColors` (~30-35), and `formatDuration` (~37-44). Replace the lucide import line (`import { CheckCircle2, XCircle, Clock, Loader2, Slash, Timer } from "lucide-react";`) — keep only icons still referenced directly in JSX (audit; likely none after using the map) — and add:

```ts
import { getRunStatusIcon, triggerTypeColors, formatDuration } from "../../lib/run-status";
```

At the row render, replace `runStatusIcons[run.status] ?? {...}` lookups with `getRunStatusIcon(run.status)`, and for a running row add `animate-spin` in the className where the icon is rendered (the old AoA map baked it in; now add it at render to match worker behavior). Verify no other reference to the deleted consts remains.

- [ ] **Step 6: Run the AoA panel's tests + typecheck**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-status.test.ts && pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: tests PASS; typecheck reports no new errors in `AoaRunsPanel.tsx`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/run-status.ts ui/src/lib/__tests__/run-status.test.ts ui/src/components/agent-detail/AoaRunsPanel.tsx
git commit -m "refactor(agent-page): extract shared run-status module + tests (phase 1)"
```

---

### Task 2: `run-metrics` module (extract from `AgentDetail`)

**Files:**
- Create: `ui/src/lib/run-metrics.ts`
- Test: `ui/src/lib/__tests__/run-metrics.test.ts`
- Modify: `ui/src/pages/AgentDetail.tsx` (remove local `asRecord`/`usageNumber`/`runMetrics`, import from lib)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/run-metrics.test.ts
import { describe, it, expect } from "vitest";
import { asRecord, usageNumber, runMetrics } from "../run-metrics";

describe("asRecord", () => {
  it("returns the object for plain records, null otherwise", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord("x")).toBeNull();
  });
});

describe("usageNumber", () => {
  it("returns the first finite numeric key", () => {
    expect(usageNumber({ a: 5, b: 9 }, "a", "b")).toBe(5);
    expect(usageNumber({ a: "no", b: 9 }, "a", "b")).toBe(9);
    expect(usageNumber({ a: Infinity }, "a")).toBe(0);
    expect(usageNumber(null, "a")).toBe(0);
  });
});

describe("runMetrics", () => {
  it("reads camel and snake token keys and sums totalTokens", () => {
    const m = runMetrics({ usageJson: { inputTokens: 10, output_tokens: 5 }, resultJson: null });
    expect(m.input).toBe(10);
    expect(m.output).toBe(5);
    expect(m.totalTokens).toBe(15);
  });
  it("falls back to resultJson for cost when usage has none", () => {
    const m = runMetrics({ usageJson: { inputTokens: 1 }, resultJson: { total_cost_usd: 0.42 } });
    expect(m.cost).toBeCloseTo(0.42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-metrics.test.ts`
Expected: FAIL — cannot resolve `../run-metrics`.

- [ ] **Step 3: Write the module**

```ts
// ui/src/lib/run-metrics.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `AgentDetail.tsx`**

In `ui/src/pages/AgentDetail.tsx`:
- Delete the local `usageNumber` (lines ~194-201) and `runMetrics` (lines ~203-224) function definitions, and the local `asRecord` definition (lines ~245-248).
- Add to the import block near the top: `import { asRecord, usageNumber, runMetrics } from "../lib/run-metrics";`
- Leave `getAdapterResultOutput` (lines ~226-241) in place — it now uses the imported `asRecord`. Its existing test (`ui/src/__tests__/AgentDetail.adapter-output.test.ts`) still imports it from the page, unchanged.
- Confirm no other now-undefined references (`usageNumber` is used by `runMetrics` only; `asRecord` is used in several places in the page — all resolve to the import).

- [ ] **Step 6: Run the existing adapter-output test + the new test + typecheck**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/run-metrics.test.ts src/__tests__/AgentDetail.adapter-output.test.ts && pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: all PASS; no new typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/run-metrics.ts ui/src/lib/__tests__/run-metrics.test.ts ui/src/pages/AgentDetail.tsx
git commit -m "refactor(agent-page): extract run-metrics helpers + tests (phase 1)"
```

---

### Task 3: `agent-kpis` module (extract Overview KPI math; feeds hero strip)

**Files:**
- Create: `ui/src/lib/agent-kpis.ts`
- Test: `ui/src/lib/__tests__/agent-kpis.test.ts`
- Modify: `ui/src/pages/AgentDetail.tsx` (`AgentOverview` uses `computeAgentKpis`)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/agent-kpis.test.ts
import { describe, it, expect } from "vitest";
import { computeAgentKpis } from "../agent-kpis";

const NOW = new Date("2026-06-24T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("computeAgentKpis", () => {
  it("windows to the last 7 days and computes success rate over completed runs", () => {
    const runs = [
      { status: "succeeded", createdAt: daysAgo(1), usageJson: { cost_usd: 1 }, resultJson: null },
      { status: "failed", createdAt: daysAgo(2), usageJson: { cost_usd: 0.5 }, resultJson: null },
      { status: "running", createdAt: daysAgo(1), usageJson: null, resultJson: null },
      { status: "succeeded", createdAt: daysAgo(30), usageJson: { cost_usd: 9 }, resultJson: null }, // outside window
    ];
    const issues = [
      { status: "done", createdAt: daysAgo(1) },
      { status: "done", createdAt: daysAgo(30) }, // outside window
      { status: "in_progress", createdAt: daysAgo(1) },
    ];
    const kpis = computeAgentKpis({ runs, assignedIssues: issues, now: NOW });
    expect(kpis.completedRuns).toBe(2); // succeeded + failed in window (running excluded)
    expect(kpis.successRate).toBe(50);
    expect(kpis.tasksCompleted).toBe(1);
    expect(kpis.cost).toBeCloseTo(1.5); // only in-window runs
  });
  it("returns null success rate when no completed runs", () => {
    const kpis = computeAgentKpis({ runs: [], assignedIssues: [], now: NOW });
    expect(kpis.successRate).toBeNull();
    expect(kpis.cost).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-kpis.test.ts`
Expected: FAIL — cannot resolve `../agent-kpis`.

- [ ] **Step 3: Write the module**

```ts
// ui/src/lib/agent-kpis.ts
import type { HeartbeatRun } from "@armyofagents/shared";
import { runMetrics } from "./run-metrics";

export interface AgentKpiInput {
  runs: Pick<HeartbeatRun, "status" | "createdAt" | "usageJson" | "resultJson">[];
  assignedIssues: { status: string; createdAt: Date | string }[];
  now?: Date;
  windowDays?: number;
}

export interface AgentKpis {
  tasksCompleted: number;
  successRate: number | null;
  completedRuns: number;
  cost: number;
}

export function computeAgentKpis({
  runs,
  assignedIssues,
  now = new Date(),
  windowDays = 7,
}: AgentKpiInput): AgentKpis {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const runsInWindow = runs.filter((r) => new Date(r.createdAt) >= since);
  const completed = runsInWindow.filter(
    (r) => r.status === "succeeded" || r.status === "failed",
  );
  const succeeded = runsInWindow.filter((r) => r.status === "succeeded").length;
  const successRate =
    completed.length > 0 ? Math.round((succeeded / completed.length) * 100) : null;
  const tasksCompleted = assignedIssues.filter(
    (i) => i.status === "done" && new Date(i.createdAt) >= since,
  ).length;
  const cost = runsInWindow.reduce((sum, r) => sum + runMetrics(r).cost, 0);
  return { tasksCompleted, successRate, completedRuns: completed.length, cost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-kpis.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `AgentOverview` in `AgentDetail.tsx`**

In the `AgentOverview` component (around lines 787-805), replace the inline `now`/`weekAgo`/`runsThisWeek`/`completedRunsThisWeek`/`succeededThisWeek`/`successRate`/`tasksCompletedThisWeek`/`costThisWeek` block with:

```ts
import { computeAgentKpis } from "../lib/agent-kpis"; // add to import block

// inside AgentOverview, replacing the inline math:
const kpis = computeAgentKpis({ runs, assignedIssues });
const { tasksCompleted: tasksCompletedThisWeek, successRate, completedRuns: completedRunsThisWeekCount, cost: costThisWeek } = kpis;
```

Then update the three stat-card JSX references: `successRate !== null ? ...`, `{tasksCompletedThisWeek}`, `({completedRunsThisWeekCount} runs)`, `${costThisWeek.toFixed(2)}`. (The card markup is unchanged in Phase 1 — only the data source.)

- [ ] **Step 6: Run KPI test + the Overview render test if present + typecheck**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-kpis.test.ts && pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: PASS; no new typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/agent-kpis.ts ui/src/lib/__tests__/agent-kpis.test.ts ui/src/pages/AgentDetail.tsx
git commit -m "refactor(agent-page): extract agent KPI computation + tests (phase 1)"
```

---

### Task 4: `env-redaction` module (extract security-relevant redaction)

**Files:**
- Create: `ui/src/lib/env-redaction.ts`
- Test: `ui/src/lib/__tests__/env-redaction.test.ts`
- Modify: `ui/src/pages/AgentDetail.tsx` (remove local redaction trio, import from lib)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/env-redaction.test.ts
import { describe, it, expect } from "vitest";
import { shouldRedactSecretValue, redactEnvValue, formatEnvForDisplay } from "../env-redaction";

describe("shouldRedactSecretValue", () => {
  it("redacts by secret-looking key", () => {
    expect(shouldRedactSecretValue("OPENAI_API_KEY", "x")).toBe(true);
    expect(shouldRedactSecretValue("PASSWORD", "x")).toBe(true);
    expect(shouldRedactSecretValue("PORT", "8080")).toBe(false);
  });
  it("redacts JWT-shaped values regardless of key", () => {
    expect(shouldRedactSecretValue("PLAIN", "aaa.bbb.ccc")).toBe(true);
  });
});

describe("redactEnvValue", () => {
  it("masks secret_ref objects", () => {
    expect(redactEnvValue("ANY", { type: "secret_ref", secretId: "s" })).toBe("***SECRET_REF***");
  });
  it("masks secret keys and passes through plain values", () => {
    expect(redactEnvValue("API_KEY", "abc")).toBe("***REDACTED***");
    expect(redactEnvValue("REGION", "us-east-1")).toBe("us-east-1");
  });
});

describe("formatEnvForDisplay", () => {
  it("sorts keys and redacts", () => {
    expect(formatEnvForDisplay({ REGION: "us", API_KEY: "z" })).toBe("API_KEY=***REDACTED***\nREGION=us");
  });
  it("handles empty + unparseable", () => {
    expect(formatEnvForDisplay({})).toBe("<empty>");
    expect(formatEnvForDisplay("not-an-object")).toBe("<unable-to-parse>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/env-redaction.test.ts`
Expected: FAIL — cannot resolve `../env-redaction`.

- [ ] **Step 3: Write the module** (copy regexes byte-for-byte from `AgentDetail.tsx:81-121`)

```ts
// ui/src/lib/env-redaction.ts
import { asRecord } from "./run-metrics";

export const REDACTED_ENV_VALUE = "***REDACTED***";

const SECRET_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;

export function shouldRedactSecretValue(key: string, value: unknown): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true;
  if (typeof value !== "string") return false;
  return JWT_VALUE_RE.test(value);
}

export function redactEnvValue(key: string, value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref"
  ) {
    return "***SECRET_REF***";
  }
  if (shouldRedactSecretValue(key, value)) return REDACTED_ENV_VALUE;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatEnvForDisplay(envValue: unknown): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";
  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";
  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key])}`)
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/env-redaction.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `AgentDetail.tsx`**

In `ui/src/pages/AgentDetail.tsx`: delete `REDACTED_ENV_VALUE`, `SECRET_ENV_KEY_RE`, `JWT_VALUE_RE` (lines ~80-83) and `shouldRedactSecretValue`/`redactEnvValue`/`formatEnvForDisplay` (lines ~85-121). Add to the import block: `import { formatEnvForDisplay } from "../lib/env-redaction";` (import only what the page references at call sites — audit: the LogViewer invocation panel uses `formatEnvForDisplay`; add `redactEnvValue`/`shouldRedactSecretValue` to the import only if referenced directly).

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/env-redaction.test.ts && pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: PASS; no new typecheck errors (any unused-import error → trim the import to what's used).

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/env-redaction.ts ui/src/lib/__tests__/env-redaction.test.ts ui/src/pages/AgentDetail.tsx
git commit -m "refactor(agent-page): extract env-redaction helpers + tests (phase 1)"
```

---

### Task 5: `agent-detail-view` module (extract tab-view parsing)

**Files:**
- Create: `ui/src/lib/agent-detail-view.ts`
- Test: `ui/src/lib/__tests__/agent-detail-view.test.ts`
- Modify: `ui/src/pages/AgentDetail.tsx` (import `AgentDetailView` + `parseAgentDetailView`)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/agent-detail-view.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentDetailView } from "../agent-detail-view";

describe("parseAgentDetailView", () => {
  it("maps configuration alias to configure", () => {
    expect(parseAgentDetailView("configuration")).toBe("configure");
    expect(parseAgentDetailView("configure")).toBe("configure");
  });
  it("passes through known views", () => {
    expect(parseAgentDetailView("instructions")).toBe("instructions");
    expect(parseAgentDetailView("runs")).toBe("runs");
    expect(parseAgentDetailView("skills")).toBe("skills");
  });
  it("defaults unknown/null to overview", () => {
    expect(parseAgentDetailView(null)).toBe("overview");
    expect(parseAgentDetailView("nope")).toBe("overview");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-detail-view.test.ts`
Expected: FAIL — cannot resolve `../agent-detail-view`.

- [ ] **Step 3: Write the module**

```ts
// ui/src/lib/agent-detail-view.ts
export type AgentDetailView = "overview" | "instructions" | "configure" | "runs" | "skills";

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "configure" || value === "configuration") return "configure";
  if (value === "instructions") return value;
  if (value === "runs") return value;
  if (value === "skills") return value;
  return "overview";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-detail-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `AgentDetail.tsx`**

Delete the local `type AgentDetailView` (line ~184) and `parseAgentDetailView` (lines ~186-192). Add: `import { parseAgentDetailView, type AgentDetailView } from "../lib/agent-detail-view";`

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/agent-detail-view.test.ts && pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: PASS; no new typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/agent-detail-view.ts ui/src/lib/__tests__/agent-detail-view.test.ts ui/src/pages/AgentDetail.tsx
git commit -m "refactor(agent-page): extract agent-detail-view parsing + tests (phase 1)"
```

---

### Task 6: Full-suite verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run: `pnpm --filter @armyofagents/ui test:run`
Expected: PASS, including the 5 new lib tests and the pre-existing `AgentDetail.adapter-output.test.ts`, `AgentConfigForm.*`, `AgentCard`, `AgentTrustScoreCard`, `AoaAgentDetail` tests (no regressions).

- [ ] **Step 2: Typecheck the UI package**

Run: `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Confirm no behavior drift (manual diff review)**

Review `git diff` of `AgentDetail.tsx` + `AoaRunsPanel.tsx`: the only changes are deleted local defs + added imports + the KPI-source swap. No JSX/markup changed. The running-row `animate-spin` is now applied at render in `AoaRunsPanel` (matching the worker page).

- [ ] **Step 4: Final commit (if any staged cleanup remains)**

```bash
git status   # expect clean after the per-task commits
```

---

## Self-review (run before execution)
- **Spec coverage:** Phase 1 implements design-doc §10.1 (unit targets: `runMetrics`, env-redaction trio, `parseAgentDetailView`, extracted KPI math) + §6.3 run-status consolidation start. The remaining design phases (hero, Overview, Config, Skills, Runs/Instructions, Triggers, states, RBAC) are deferred to their own plans.
- **Placeholder scan:** none — every step has exact code + exact commands.
- **Type consistency:** `runMetrics` accepts `Pick<HeartbeatRun, "usageJson"|"resultJson">` (Task 2) and is consumed by `computeAgentKpis` with `Pick<HeartbeatRun, "status"|"createdAt"|"usageJson"|"resultJson">` (Task 3) — compatible. `AgentDetailView` type name matches the page's usage. `getRunStatusIcon` fallback shape matches `RunStatusIcon`.
- **Risk:** lowest-risk phase — pure extraction, behavior-preserving, each step independently tested and committed. If any extracted helper's test reveals a discrepancy with current behavior, fix the test to match current behavior (parity), not the other way around (that's a separate design decision).

## Next phases (separate plans, written as we reach them)
P2 hero card · P3 Overview restructure · P4 Config in-place cards + contract test · P5 shared Skills · P6 Runs/Instructions reframe + `routeBuilder` · P7 Triggers · P8 states + e2e specs · P9 (separate) RBAC + type-drift + Triggers edit/delete.
