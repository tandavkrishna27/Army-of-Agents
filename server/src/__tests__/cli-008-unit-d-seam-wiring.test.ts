// cli-008-unit-d-seam-wiring.test.ts — CLI-008 Unit D, the plumbing nobody would notice.
//
// Unit D's bytes travel through four hands: `buildTaskRunBatchWorkload` builds them beside the
// argv that reads them, `heartbeat.ts` hands them to the rollout hook, the hook hands them to
// the ownership resolver, and the resolver hands them to the staging port. Three of those are
// pass-throughs, and a dropped pass-through has NO local symptom: the run is placed, the
// legacy executor is suppressed, and the sandbox runs `sh -c '… < /home/user/.aoa-run-prompt.md'`
// against a file nobody wrote.
//
// ★ The hook is the sharpest one, because it DESTRUCTURES its input. A field added to the
// interface and not to both the destructure and the delegated call typechecks clean and is
// silently discarded. That is not hypothetical — it is exactly how `stagedFiles` could have
// been added.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatDistributedRolloutHook } from "../services/heartbeat-distributed-rollout.js";
import {
  STAGED_INSTRUCTIONS_PATH,
  STAGED_PROMPT_PATH,
} from "../services/task-run-sandbox-invocation.js";

const ORG = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";
const AGENT = "99999999-9999-4999-8999-999999999999";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FILES = [
  { path: STAGED_PROMPT_PATH, bytes: new Uint8Array([1, 2, 3]), contentType: "text/markdown" },
  { path: STAGED_INSTRUCTIONS_PATH, bytes: new Uint8Array([4, 5]), contentType: "text/markdown" },
] as const;

function hookWith(resolve: ReturnType<typeof vi.fn>) {
  return createHeartbeatDistributedRolloutHook({
    env: { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" },
    deploymentMode: "cloud_auth",
    rolloutSource: { resolveRunRolloutState: () => "canary" } as never,
    resolveOrganizationId: async () => ORG,
    convertOrchestrator: { convertRunToJob: async () => ({ converted: false, reason: "disabled" }) } as never,
    comparator: { compare: () => undefined } as never,
    ownerResolver: { resolve } as never,
  });
}

describe("the rollout hook forwards Unit D's staged files (it destructures, so it can drop them)", () => {
  it("★ passes stagedFiles through to the ownership resolver, byte-identical", async () => {
    const resolve = vi.fn(async () => ({ owner: "distributed", jobId: "j", attemptId: "a" }));
    await hookWith(resolve).resolveExecutionOwner({
      source: { kind: "task_run", runId: RUN, issueId: "i", assigneeAgentId: AGENT } as never,
      actor: { kind: "agent", id: AGENT, companyId: COMPANY },
      organizationId: ORG,
      idempotencyKey: RUN,
      rolloutState: "canary",
      input: { command: "sh" },
      stagedFiles: FILES,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toMatchObject({ stagedFiles: FILES });
  });

  it("omitting them stays omitted — no invented empty array a caller could misread", async () => {
    const resolve = vi.fn(async () => ({ owner: "legacy", reason: "rollout_not_canary" }));
    await hookWith(resolve).resolveExecutionOwner({
      source: { kind: "task_run", runId: RUN, issueId: "i", assigneeAgentId: AGENT } as never,
      actor: { kind: "agent", id: AGENT, companyId: COMPANY },
      organizationId: ORG,
      idempotencyKey: RUN,
      rolloutState: "canary",
    });
    expect(resolve.mock.calls[0]![0].stagedFiles).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The heartbeat seam itself is inside `executeRun` — ~2,700 lines with a dependency surface
// that is impractical to unit-test (the standing CLI-003/005/006 limitation, recorded as Risk
// #2). `cli-006-seam-suppression.test.ts` already handles that by asserting the seam's shape
// against the SOURCE; these do the same for Unit D's two edits, because the alternative is
// asserting nothing at all about the one call site that matters.
// ─────────────────────────────────────────────────────────────────────────────
describe("the heartbeat seam's Unit D edits, asserted structurally", () => {
  const source = readFileSync(new URL("../services/heartbeat.ts", import.meta.url), "utf8");

  it("resolves the instructions bundle BEFORE building the workload", () => {
    const resolveAt = source.indexOf("resolveTaskRunInstructionsBundle({");
    const buildAt = source.indexOf("buildTaskRunBatchWorkload({");
    expect(resolveAt).toBeGreaterThan(0);
    expect(buildAt).toBeGreaterThan(0);
    expect(resolveAt).toBeLessThan(buildAt);
  });

  it("★ passes the SAME build result's stagedFiles to the ownership decision", () => {
    // Not `[]`, not a second call to the builder, not a locally reassembled list: the files
    // the argv reads and the files that get staged must come from one build, or they can
    // disagree.
    expect(source).toContain("stagedFiles: canaryWorkload.stagedFiles");
  });

  // ★ `workload.command` is `sh` for every Unit D run, so a log line carrying only it tells an
  // operator nothing about which CLI the sandbox ran. The binary is an argv element now, and the
  // canary log has to follow it there — otherwise the one line written to answer "what is this
  // canary running?" answers "a shell".
  it("logs the real BINARY beside the command, not just `sh`", () => {
    const line = source.slice(
      source.indexOf("[CLI-006] canary execution owner = DISTRIBUTED") - 2500,
      source.indexOf("[CLI-006] canary execution owner = DISTRIBUTED"),
    );
    expect(line).toContain("binary: canaryWorkload.ok");
    expect(line).toContain("SANDBOX_INVOCATION_BINARY_ARG_INDEX");
    expect(line).toContain("stagedPaths: canaryWorkload.ok");
  });

  it("a configured-but-unreadable bundle keeps the run LEGACY rather than running without it", () => {
    // The refusal must not be folded into a shape that looks like "this agent has no bundle".
    expect(source).toContain("canaryInstructions.ok");
    expect(source).toContain("`instructions_${canaryInstructions.reason}");
  });
});
