/**
 * JOB-015 slice (a) — PIN THE DEFECT BEFORE FIXING IT.
 *
 * These are the tests that were RED on the pre-JOB-015 tree. They are here so the
 * anti-regression suite is provably testing something: without a test that failed
 * against the defect, a green suite after the fix proves nothing at all.
 *
 * The defect, as measured at `6c2fe6482`:
 *
 *   1. `listPendingControlCommands` (packages/db/src/repositories/tenant/job-control.ts)
 *      was a complete repository method with ZERO production callers. Its only
 *      non-definition reference was the NAME, as a string, in a contract test's
 *      inventory list — and its own docstring asserted "the poll/renew path surfaces"
 *      it. The poll/renew path did not. That is a false claim of enforcement written
 *      into the docstring of the method that would implement it (E3-F035).
 *
 *   2. The renew mutator hardcoded `extensions: []` directly beside
 *      `cancelRequested: Boolean(pendingCancel)`, and filtered the queue to
 *      `command_kind IN ('cancel','graceful_stop')`. Three of the five persistable
 *      kinds — `drain`, `product_approval_result`, `runtime_decision_result` — had
 *      live producers and no reader anywhere.
 *
 * Test 1 below pins (1) as a STATIC fact about the source, which is the only way to
 * pin "a method has no caller" — a behavioural test cannot observe an absence of
 * calls. Test 2 pins the projection's contract without a database.
 *
 * The end-to-end pin for (2) lives in `job-control-commands.integration.test.ts`
 * ("JOB-015 — delivers the non-boolean control kinds…"), which needs embedded
 * Postgres; it is red on the old mutator for the same reason.
 *
 * ★ WHY A SOURCE-TEXT TEST AND NOT A MOCK. The failure class is "a method nobody
 * calls". A mock-based test would have to construct the caller in order to observe
 * it, which is circular. Reading the shipped source for a real call site is the
 * measurement the finding was written from, so it is the measurement that closes it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONTROL_EXTENSION_NAMESPACE,
  ControlProjectionError,
  projectControlCommandExtensions,
  type ProjectableControlCommand,
} from "../services/control-command-projection.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const jobControlSource = readFileSync(
  `${repoRoot}packages/db/src/repositories/tenant/job-control.ts`,
  "utf8",
);
const jobFencingSource = readFileSync(`${repoRoot}server/src/services/job-fencing.ts`, "utf8");

function command(seq: number, kind: string, body?: Record<string, unknown>): ProjectableControlCommand {
  return {
    commandId: `0000000${seq}-0000-4000-8000-00000000000${seq % 10}`,
    commandSeq: seq,
    commandKind: kind,
    command: body ?? {
      protocolVersion: 1,
      audience: "control_channel",
      commandKind: kind,
      commandSeq: seq,
    },
  };
}

describe("JOB-015 (a) — E3-F035: the orphaned read acquires a real caller", () => {
  it("calls listPendingControlCommands from production code, not only from a name inventory", () => {
    // The interface declaration + the implementation are definitions. A THIRD
    // occurrence in this file is a call site. Before JOB-015 there were exactly two.
    const occurrences = jobControlSource.match(/listPendingControlCommands/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    // And specifically: the renew mutator reaches it through the public interface.
    expect(jobControlSource).toContain("repository.listPendingControlCommands({");
  });

  it("no longer hardcodes an empty extensions array on the renew response", () => {
    // The exact pre-JOB-015 line. Its return would make every queued command
    // undeliverable again, and an empty array is byte-identical to omission, so
    // nothing downstream could tell.
    expect(jobControlSource).not.toMatch(/^\s*extensions: \[\],$/m);
    expect(jobControlSource).toContain("input.projectControlExtensions([], pendingControls)");
  });

  it("makes the docstring's claimed consumer true rather than editing the claim away", () => {
    expect(jobFencingSource).toContain("projectControlExtensions:");
    expect(jobFencingSource).toContain("projectControlCommandExtensions(");
  });
});

describe("JOB-015 (a) — three of five persistable kinds had no reader", () => {
  it("projects drain, product_approval_result and runtime_decision_result", () => {
    const pending = [
      command(1, "drain"),
      command(2, "product_approval_result"),
      command(3, "runtime_decision_result"),
    ];
    const [extension, ...rest] = projectControlCommandExtensions([], pending);
    expect(rest).toEqual([]);
    expect(extension!.namespace).toBe(CONTROL_EXTENSION_NAMESPACE);
    const value = extension!.value as { commands: Record<string, unknown>[]; truncated: boolean };
    expect(value.commands.map((c) => c.commandKind)).toEqual([
      "drain",
      "product_approval_result",
      "runtime_decision_result",
    ]);
    expect(value.truncated).toBe(false);
  });

  it("★ POSITIVE CONTROL — nothing pending is byte-identical to the pre-JOB-015 empty array", () => {
    expect(projectControlCommandExtensions([], [])).toEqual([]);
    expect(JSON.stringify(projectControlCommandExtensions([], []))).toBe(JSON.stringify([]));
  });

  it("never throws away the queue silently when it fits", () => {
    // A defensive re-statement of the omission rule at the smallest possible input.
    expect(projectControlCommandExtensions([], [command(1, "drain")])).toHaveLength(1);
  });

  it("does not lose the caller's existing extensions", () => {
    const existing = [{ namespace: "dev.aoa.other/x", schemaVersion: 1, critical: false, value: { a: 1 } }];
    const projected = projectControlCommandExtensions(existing, [command(1, "drain")]);
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual(existing[0]);
  });

  it("exports the terminal error type the marker-cannot-fit case raises", () => {
    expect(new ControlProjectionError("x")).toBeInstanceOf(Error);
    expect(new ControlProjectionError("x").name).toBe("ControlProjectionError");
  });
});
