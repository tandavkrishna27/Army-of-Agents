/**
 * JOB-015 slice (d), server half — the projection's fail-closed levers, each with the
 * ★ positive control that proves the lever can distinguish a refusal from an absence.
 *
 * ★ A denial suite with no accept case cannot tell "refused" from "nothing was
 * delivered". That is precisely the bug JOB-015 was filed to fix, so reproducing it in
 * the tests that close it would be the worst possible outcome. Every clause below has
 * its allow-side twin in the SAME `describe`.
 *
 * The budgets under test are the frozen ones (`WIRE_EXTENSION_LIMITS`): ≤16,384
 * canonical UTF-8 bytes per extension value, ≤65,536 combined, ≤16 extensions, ≤8
 * container levels, ≤128 array items, ≤64 object keys. The projector probes candidates
 * through the REAL refiner (`addWireExtensionArrayIssues`) rather than estimating
 * bytes, so structural overflow is caught by the same terminal rule as byte overflow.
 */

import { describe, expect, it } from "vitest";
import { WIRE_EXTENSION_LIMITS, type WireExtension } from "@armyofagents/worker-protocol";

import {
  CONTROL_EXTENSION_MAX_COMMANDS,
  CONTROL_EXTENSION_NAMESPACE,
  ControlProjectionError,
  projectControlCommandExtensions,
  type ControlExtensionValue,
  type ProjectableControlCommand,
} from "../services/control-command-projection.js";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function command(
  seq: number,
  kind = "drain",
  extra: Record<string, unknown> = {},
): ProjectableControlCommand {
  return {
    commandId: uuid(seq),
    commandSeq: seq,
    commandKind: kind,
    command: {
      protocolVersion: 1,
      audience: "control_channel",
      commandId: uuid(seq),
      commandSeq: seq,
      commandKind: kind,
      ...extra,
    },
  };
}

/** A command whose stored body alone blows the per-value canonical byte budget. This is
 * not a hypothetical: a work-question answer is capped at 16 KiB canonical and the
 * per-extension-value cap is EXACTLY 16,384, so a maximal answer plus its own envelope
 * necessarily overflows. */
function oversizedCommand(seq: number): ProjectableControlCommand {
  return command(seq, "runtime_decision_result", {
    result: { answer: "x".repeat(WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes) },
  });
}

/** A command whose body is DEEPER than the frozen container-depth bound once nested
 * under `{ commands: [ … ] }`. Bytes are tiny; only the structural walk sees it. */
function tooDeepCommand(seq: number): ProjectableControlCommand {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < WIRE_EXTENSION_LIMITS.valueMaxContainerDepth; i += 1) node = { n: node };
  return command(seq, "runtime_decision_result", { result: node });
}

function valueOf(extension: WireExtension): ControlExtensionValue {
  return extension.value as ControlExtensionValue;
}

describe("JOB-015 (d) — over-budget queue is SIGNALLED, never omitted", () => {
  it("emits the extension with truncated:true + the total pendingCount when only a prefix fits", () => {
    // Each ~9 KiB, so exactly one fits under the 16,384-byte per-value cap.
    const bulky = (seq: number) =>
      command(seq, "runtime_decision_result", { result: { answer: "y".repeat(9_000) } });
    const projected = projectControlCommandExtensions([], [bulky(1), bulky(2), bulky(3)]);

    expect(projected).toHaveLength(1);
    const value = valueOf(projected[0]!);
    expect(value.truncated).toBe(true);
    expect(value.pendingCount).toBe(3);
    expect(value.commands.length).toBeGreaterThan(0);
    expect(value.commands.length).toBeLessThan(3);
    expect(value.oversizedLeading).toBeUndefined();
  });

  it("★ POSITIVE CONTROL — an under-budget list carries NO marker, and both are distinguishable from []", () => {
    const projected = projectControlCommandExtensions([], [command(1), command(2)]);
    const value = valueOf(projected[0]!);
    expect(value.truncated).toBe(false);
    expect(value.pendingCount).toBe(2);
    expect(value.commands).toHaveLength(2);

    // ★ The three states are three DIFFERENT wire bytes. An omitted extension would
    // collapse the truncated case onto the empty case, which is the defect.
    const empty = JSON.stringify(projectControlCommandExtensions([], []));
    const full = JSON.stringify(projected);
    const truncated = JSON.stringify(
      projectControlCommandExtensions(
        [],
        [1, 2, 3].map((n) => command(n, "runtime_decision_result", { result: { answer: "y".repeat(9_000) } })),
      ),
    );
    expect(new Set([empty, full, truncated]).size).toBe(3);
  });

  it("caps the command count independently of the byte budget, and marks that truncation too", () => {
    const many = Array.from({ length: CONTROL_EXTENSION_MAX_COMMANDS + 4 }, (_, i) => command(i + 1));
    const value = valueOf(projectControlCommandExtensions([], many)[0]!);
    expect(value.commands).toHaveLength(CONTROL_EXTENSION_MAX_COMMANDS);
    expect(value.truncated).toBe(true);
    expect(value.pendingCount).toBe(CONTROL_EXTENSION_MAX_COMMANDS + 4);
  });

  it("★ POSITIVE CONTROL — exactly at the cap is NOT truncated", () => {
    const many = Array.from({ length: CONTROL_EXTENSION_MAX_COMMANDS }, (_, i) => command(i + 1));
    const value = valueOf(projectControlCommandExtensions([], many)[0]!);
    expect(value.commands).toHaveLength(CONTROL_EXTENSION_MAX_COMMANDS);
    expect(value.truncated).toBe(false);
  });
});

describe("JOB-015 (d) — an oversized LEADING command has a terminal, not a stall", () => {
  it("names the leading command so a rejected ACK can unblock the queue", () => {
    const projected = projectControlCommandExtensions([], [oversizedCommand(1), command(2)]);
    expect(projected).toHaveLength(1);
    const value = valueOf(projected[0]!);
    expect(value.commands).toEqual([]);
    expect(value.truncated).toBe(true);
    expect(value.pendingCount).toBe(2);
    expect(value.oversizedLeading).toEqual({ commandId: uuid(1), commandSeq: 1 });
  });

  it("★ POSITIVE CONTROL — the command BEHIND it is delivered once the oversized one is ACKed", () => {
    // This is the control that separates the fix from the stalling design. A test
    // asserting only that the marker appears passes against the stall.
    const afterAck = projectControlCommandExtensions([], [command(2)]);
    const value = valueOf(afterAck[0]!);
    expect(value.oversizedLeading).toBeUndefined();
    expect(value.commands).toHaveLength(1);
    expect(value.commands[0]!.commandSeq).toBe(2);
    expect(value.truncated).toBe(false);
  });

  it("applies the same terminal to a command that overflows on STRUCTURE rather than bytes", () => {
    const projected = projectControlCommandExtensions([], [tooDeepCommand(1), command(2)]);
    const value = valueOf(projected[0]!);
    expect(value.commands).toEqual([]);
    expect(value.oversizedLeading).toEqual({ commandId: uuid(1), commandSeq: 1 });
  });

  it("★ POSITIVE CONTROL — a command one level SHALLOWER than the bound is delivered normally", () => {
    let node: Record<string, unknown> = { leaf: 1 };
    // value(1) > commands[](2) > body(3) > result(4) leaves four levels for the payload.
    for (let i = 0; i < 3; i += 1) node = { n: node };
    const shallow = command(1, "runtime_decision_result", { result: node });
    const value = valueOf(projectControlCommandExtensions([], [shallow])[0]!);
    expect(value.commands).toHaveLength(1);
    expect(value.oversizedLeading).toBeUndefined();
  });

  it("an oversized command that is NOT leading still lets the prefix through", () => {
    const value = valueOf(projectControlCommandExtensions([], [command(1), oversizedCommand(2)])[0]!);
    expect(value.commands).toHaveLength(1);
    expect(value.commands[0]!.commandSeq).toBe(1);
    expect(value.truncated).toBe(true);
    expect(value.oversizedLeading).toBeUndefined();
  });
});

describe("JOB-015 (d) — the marker itself must fit, or the renew fails loudly", () => {
  it("★ POSITIVE CONTROL — a fitting marker returns normally", () => {
    expect(() => projectControlCommandExtensions([], [oversizedCommand(1)])).not.toThrow();
  });

  it("throws rather than returning a body that reads as 'no commands pending'", () => {
    // Sibling extensions that have already consumed the COMBINED budget leave no room
    // even for the ~200-byte marker. The alternative — returning `existing` unchanged —
    // is byte-identical to "nothing is queued", which is this ticket's own defect.
    const filler = (i: number): WireExtension => ({
      namespace: `dev.aoa.filler${i}/x`,
      schemaVersion: 1,
      critical: false,
      value: { pad: "z".repeat(WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes - 20) },
    });
    const existing = Array.from({ length: 5 }, (_, i) => filler(i));
    expect(() => projectControlCommandExtensions(existing, [oversizedCommand(1)]))
      .toThrow(ControlProjectionError);
  });
});

describe("JOB-015 (d) — the projection is NOT sibling-blind", () => {
  it("refuses to overflow the COMBINED budget a co-resident extension has already spent", () => {
    // `pointerFitsExtension` (job-input-staging.ts) measures one value against the
    // per-value cap only; it is correct today solely because the job envelope carries
    // one extension. This projector probes the UNION, so a co-resident extension
    // shrinks what the control queue may carry instead of silently breaking the
    // envelope's `.parse` downstream.
    // Four siblings at ~15 KiB each spend ~60 KiB of the 65,536-byte COMBINED budget
    // while each stays well under the 16,384-byte per-value cap. What is left admits
    // one ~3 KiB command and not two — a bound only a union-aware projector can see.
    const big = (n: number): WireExtension => ({
      namespace: `dev.aoa.filler${n}/x`,
      schemaVersion: 1,
      critical: false,
      value: { pad: "z".repeat(15_000) },
    });
    const nearlyFull = Array.from({ length: 4 }, (_, i) => big(i));
    const bulky = (seq: number) =>
      command(seq, "runtime_decision_result", { result: { answer: "y".repeat(3_000) } });

    const alone = valueOf(projectControlCommandExtensions([], [bulky(1), bulky(2)])[0]!);
    const withSiblings = projectControlCommandExtensions(nearlyFull, [bulky(1), bulky(2)]);
    const crowded = valueOf(withSiblings[withSiblings.length - 1]!);

    expect(withSiblings).toHaveLength(nearlyFull.length + 1);
    expect(crowded.commands.length).toBeLessThan(alone.commands.length);
    expect(crowded.truncated).toBe(true);
  });

  it("★ POSITIVE CONTROL — a small co-resident extension changes nothing", () => {
    const tiny: WireExtension = { namespace: "dev.aoa.tiny/x", schemaVersion: 1, critical: false, value: { a: 1 } };
    const alone = valueOf(projectControlCommandExtensions([], [command(1), command(2)])[0]!);
    const beside = projectControlCommandExtensions([tiny], [command(1), command(2)]);
    expect(valueOf(beside[1]!)).toEqual(alone);
  });
});

describe("JOB-015 (d) — the emitted extension is always frozen-envelope legal", () => {
  it("is critical:false so a worker that predates it ignores it and keeps running", () => {
    // KNOWN_CRITICAL_EXTENSION_NAMESPACES is empty, so a `critical:true` control
    // extension would fail EVERY existing worker's envelope parse closed — the exact
    // deployment break the additive container exists to prevent.
    const [extension] = projectControlCommandExtensions([], [command(1)]);
    expect(extension!.critical).toBe(false);
    expect(extension!.namespace).toBe(CONTROL_EXTENSION_NAMESPACE);
    expect(extension!.schemaVersion).toBe(1);
  });
});
