export type CommanderTestResult = "PASS" | "FAIL" | "SKIPPED" | "BLOCKED" | "NOT_RUN";

export interface CommanderTestExecutionEntry {
  id: string;
  layer: string;
  result: CommanderTestResult;
  durationMs: number;
  exitCode?: number;
  actor?: string;
  provenanceLinks?: string[];
  evidencePaths?: string[];
  message?: string;
}

export interface CommanderTestExecutionManifest {
  version: 1;
  campaignId: string;
  mode: "targeted" | "authenticated" | "merge" | "live";
  startedAt: string;
  finishedAt: string;
  entries: CommanderTestExecutionEntry[];
}

export interface CommanderGateStep {
  id: string;
  layer: string;
  run: () => Promise<number>;
}

export interface CommanderGateRunResult {
  exitCode: number;
  entries: CommanderTestExecutionEntry[];
}

export async function runCommanderGateSteps(
  steps: CommanderGateStep[],
  cleanup?: () => Promise<number>,
): Promise<CommanderGateRunResult> {
  const entries: CommanderTestExecutionEntry[] = [];
  let firstFailure = 0;

  try {
    for (const step of steps) {
      const started = Date.now();
      let exitCode: number;
      try {
        exitCode = await step.run();
      } catch (error) {
        exitCode = 1;
        entries.push({
          id: step.id,
          layer: step.layer,
          result: "FAIL",
          durationMs: Date.now() - started,
          exitCode,
          message: error instanceof Error ? error.message : String(error),
        });
        firstFailure = exitCode;
        break;
      }

      entries.push({
        id: step.id,
        layer: step.layer,
        result: exitCode === 0 ? "PASS" : "FAIL",
        durationMs: Date.now() - started,
        exitCode,
      });
      if (exitCode !== 0) {
        firstFailure = exitCode;
        break;
      }
    }

    const executed = new Set(entries.map((entry) => entry.id));
    for (const step of steps) {
      if (!executed.has(step.id)) {
        entries.push({ id: step.id, layer: step.layer, result: "NOT_RUN", durationMs: 0 });
      }
    }
  } finally {
    if (cleanup) {
      let cleanupExit = 0;
      try {
        cleanupExit = await cleanup();
      } catch {
        cleanupExit = 1;
      }
      if (cleanupExit !== 0 && firstFailure === 0) firstFailure = cleanupExit;
    }
  }

  return { exitCode: firstFailure, entries };
}

export interface CommanderManifestRequirements {
  expectedIds: string[];
  requireLiveProvenance?: boolean;
  requireEvidence?: boolean;
}

export function commanderManifestRequirements(
  mode: CommanderTestExecutionManifest["mode"],
): CommanderManifestRequirements {
  if (mode === "targeted") {
    return {
      expectedIds: [
        "W0-SHARED-TYPECHECK",
        "W0-UI-TYPECHECK",
        "W1-DB-TYPECHECK",
        "W0-CONTRACT-UNIT",
        "W1-CONTRACT-UNIT",
      ],
    };
  }
  if (mode === "authenticated") {
    return { expectedIds: ["A01", "A02", "A03", "A04", "A05", "A06", "A07"] };
  }
  if (mode === "merge") {
    return { expectedIds: [
      "MERGE-DB-GENERATE",
      "MERGE-TYPECHECK",
      "MERGE-UNIT-INTEGRATION",
      "MERGE-BUILD",
      "MERGE-E2E",
    ] };
  }
  return {
    expectedIds: [
      ...Array.from({ length: 14 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 5 }, (_, index) => `Q${index + 1}`),
    ],
    requireLiveProvenance: true,
    requireEvidence: true,
  };
}

export function validateCommanderExecutionManifest(
  manifest: CommanderTestExecutionManifest,
  requirements: CommanderManifestRequirements,
): string[] {
  const errors: string[] = [];
  const byId = new Map<string, CommanderTestExecutionEntry>();
  for (const entry of manifest.entries) {
    if (byId.has(entry.id)) errors.push(`duplicate test id: ${entry.id}`);
    byId.set(entry.id, entry);
  }

  for (const id of requirements.expectedIds) {
    const entry = byId.get(id);
    if (!entry) {
      errors.push(`missing expected test id: ${id}`);
      continue;
    }
    if (entry.result !== "PASS") errors.push(`${id} is ${entry.result}, expected PASS`);
    if (requirements.requireLiveProvenance && !(entry.provenanceLinks?.length)) {
      errors.push(`${id} has no live provenance links`);
    }
    if (requirements.requireEvidence && !(entry.evidencePaths?.length)) {
      errors.push(`${id} has no evidence paths`);
    }
  }

  if (manifest.entries.length === 0) errors.push("manifest contains zero test entries");
  return errors;
}
