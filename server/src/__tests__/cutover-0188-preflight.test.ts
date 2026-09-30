/**
 * DEP-003 (E6 deployment harness) — PURE fail-closed proof for the operator-gated
 * 0188 populated-cutover preflight. No embedded PG, no I/O: it exercises the pure
 * state machine directly plus the orchestrator driven by deterministic in-memory
 * fakes (proving snapshot-before-marker ordering and that NO marker is written on any
 * failure path). Runs on every platform.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCutover0188Preflight,
  evaluateStartupCutoverGate,
  type Cutover0188PreflightStateInput,
} from "../services/cutover-0188-preflight-state.js";
import * as stateModule from "../services/cutover-0188-preflight-state.js";
import {
  runCutover0188Preflight,
  type CutoverMarkerRow,
  type CutoverMarkerStorePort,
  type CutoverObjectStorePort,
  type CutoverRestoreValidationPort,
  type PreflightStepEvent,
} from "../services/cutover-0188-preflight.js";

const SHA = "a".repeat(40);

const allPass: Cutover0188PreflightStateInput = {
  optIn: true,
  candidateSha: SHA,
  imageSha: SHA,
  snapshotResult: "ok",
  checksumResult: "ok",
  restoreValidationResult: "ok",
  markerWriteResult: "written",
  markerVerifyResult: "ok",
};

describe("evaluateCutover0188Preflight — pure fail-closed state machine", () => {
  it("STOPs with NO marker when opt-in is missing", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, optIn: false })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "missing_opt_in",
    });
  });

  it("STOPs with NO marker when the candidate SHA does not equal the image SHA", () => {
    expect(
      evaluateCutover0188Preflight({ ...allPass, candidateSha: "b".repeat(40) }),
    ).toEqual({ action: "stop", markerWritten: false, reason: "candidate_sha_mismatch" });
  });

  it("STOPs with NO marker when the candidate/image SHA is missing or blank", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, candidateSha: null }).action).toBe("stop");
    expect(evaluateCutover0188Preflight({ ...allPass, imageSha: null }).action).toBe("stop");
    expect(evaluateCutover0188Preflight({ ...allPass, candidateSha: "   ", imageSha: "   " })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "candidate_sha_mismatch",
    });
  });

  it("STOPs with NO marker when the snapshot fails", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, snapshotResult: "failed" })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "snapshot_failed",
    });
  });

  it("STOPs with NO marker when the checksum fails (before restore or write)", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, checksumResult: "failed" })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "checksum_failed",
    });
  });

  it("STOPs with NO marker when the isolated restore-validation fails", () => {
    expect(
      evaluateCutover0188Preflight({ ...allPass, restoreValidationResult: "failed" }),
    ).toEqual({ action: "stop", markerWritten: false, reason: "restore_validation_failed" });
  });

  it("STOPs with NO marker when the marker write fails", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, markerWriteResult: "failed" })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "marker_write_failed",
    });
  });

  it("STOPs with NO (verified) marker when the marker read-back verify fails", () => {
    expect(evaluateCutover0188Preflight({ ...allPass, markerVerifyResult: "failed" })).toEqual({
      action: "stop",
      markerWritten: false,
      reason: "marker_verify_failed",
    });
  });

  it("does NOT write the marker until snapshot AND checksum AND restore all pass", () => {
    // If any gate is not_run/failed the marker cannot have been written.
    for (const partial of [
      { snapshotResult: "not_run" as const },
      { checksumResult: "not_run" as const },
      { restoreValidationResult: "not_run" as const },
    ]) {
      const decision = evaluateCutover0188Preflight({ ...allPass, markerWriteResult: "not_run", ...partial });
      expect(decision.action).toBe("stop");
      expect(decision.markerWritten).toBe(false);
    }
  });

  it("PROCEEDs and marks the marker written only on the full happy path", () => {
    expect(evaluateCutover0188Preflight(allPass)).toEqual({
      action: "proceed",
      markerWritten: true,
      reason: "cutover_ready",
    });
  });

  it("idempotent repeat (present verified marker) is a no-op success — proceed, no new marker", () => {
    expect(
      evaluateCutover0188Preflight({
        ...allPass,
        // Snapshot/checksum/restore legitimately skipped on a repeat.
        snapshotResult: "not_run",
        checksumResult: "not_run",
        restoreValidationResult: "not_run",
        markerWriteResult: "already_present",
        markerVerifyResult: "ok",
      }),
    ).toEqual({ action: "proceed", markerWritten: false, reason: "idempotent_marker_present" });
  });

  it("a present marker that fails read-back verification still STOPs (no proceed)", () => {
    expect(
      evaluateCutover0188Preflight({
        ...allPass,
        markerWriteResult: "already_present",
        markerVerifyResult: "failed",
      }),
    ).toEqual({ action: "stop", markerWritten: false, reason: "marker_verify_failed" });
  });

  it("is deterministic — the same input always yields the same decision", () => {
    const a = evaluateCutover0188Preflight(allPass);
    const b = evaluateCutover0188Preflight(allPass);
    expect(a).toEqual(b);
  });
});

describe("evaluateStartupCutoverGate — startup reads, never writes", () => {
  it("refuses cutover (stay single-tenant) when the marker is absent", () => {
    expect(evaluateStartupCutoverGate({ markerPresent: false })).toEqual({
      cutoverAuthorized: false,
      reason: "marker_absent",
    });
  });

  it("authorizes cutover when the marker is present", () => {
    expect(evaluateStartupCutoverGate({ markerPresent: true })).toEqual({
      cutoverAuthorized: true,
      reason: "marker_present",
    });
  });

  it("the state module exports NO marker writer — it is pure read->decision logic", () => {
    const writerLike = Object.keys(stateModule).filter((name) => /write|persist|insert|create|synth/i.test(name));
    expect(writerLike).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator driven by deterministic in-memory fakes (still pure — no PG/I/O).
// ---------------------------------------------------------------------------

interface FakeOptions {
  existingMarker?: CutoverMarkerRow | null;
  snapshotOk?: boolean;
  checksumOk?: boolean;
  restoreOk?: boolean;
  writeOk?: boolean;
  verifyReturnsNull?: boolean;
  throwSnapshot?: boolean;
}

function fakes(options: FakeOptions) {
  const calls: string[] = [];
  const stored: CutoverMarkerRow[] = options.existingMarker ? [options.existingMarker] : [];
  const objectStore: CutoverObjectStorePort = {
    takeSnapshot: async () => {
      calls.push("takeSnapshot");
      if (options.throwSnapshot) throw new Error("object store unavailable");
      return options.snapshotOk === false
        ? { ok: false, error: "snapshot failed" }
        : { ok: true, snapshotRef: "s3://snap/ref" };
    },
    validateChecksum: async () => {
      calls.push("validateChecksum");
      return options.checksumOk === false
        ? { ok: false, error: "checksum mismatch" }
        : { ok: true, checksum: "deadbeef" };
    },
  };
  const restore: CutoverRestoreValidationPort = {
    restoreAndValidate: async () => {
      calls.push("restoreAndValidate");
      return options.restoreOk === false ? { ok: false, error: "restore failed" } : { ok: true };
    },
  };
  const markerStore: CutoverMarkerStorePort = {
    readMarker: async () => {
      calls.push("readMarker");
      return stored[0] ?? null;
    },
    writeMarker: async (row) => {
      calls.push("writeMarker");
      if (options.writeOk === false) return { ok: false, error: "operator write denied" };
      stored[0] = row;
      return { ok: true };
    },
    verifyMarker: async () => {
      calls.push("verifyMarker");
      return options.verifyReturnsNull ? null : stored[0] ?? null;
    },
  };
  return { calls, stored, objectStore, restore, markerStore };
}

function runWith(options: FakeOptions, overrides: Partial<Parameters<typeof runCutover0188Preflight>[0]> = {}) {
  const f = fakes(options);
  const steps: PreflightStepEvent[] = [];
  return runCutover0188Preflight({
    optIn: true,
    candidateSha: SHA,
    imageSha: SHA,
    objectStore: f.objectStore,
    restore: f.restore,
    markerStore: f.markerStore,
    clock: { now: () => new Date("2026-08-13T00:00:00.000Z") },
    logger: (event) => steps.push(event),
    ...overrides,
  }).then((result) => ({ result, calls: f.calls, stored: f.stored, steps }));
}

describe("runCutover0188Preflight — orchestration never writes on failure", () => {
  it("takes NO snapshot and writes NO marker when opt-in is missing", async () => {
    const { result, calls, stored } = await runWith({}, { optIn: false });
    expect(result.decision.reason).toBe("missing_opt_in");
    expect(calls).not.toContain("takeSnapshot");
    expect(calls).not.toContain("writeMarker");
    expect(stored).toHaveLength(0);
  });

  it("takes NO snapshot and writes NO marker when the candidate SHA mismatches", async () => {
    const { result, calls, stored } = await runWith({}, { candidateSha: "z".repeat(40) });
    expect(result.decision.reason).toBe("candidate_sha_mismatch");
    expect(calls).not.toContain("takeSnapshot");
    expect(stored).toHaveLength(0);
  });

  it("writes NO marker when the snapshot fails", async () => {
    const { result, calls, stored } = await runWith({ snapshotOk: false });
    expect(result.decision).toEqual({ action: "stop", markerWritten: false, reason: "snapshot_failed" });
    expect(calls).not.toContain("writeMarker");
    expect(stored).toHaveLength(0);
  });

  it("treats an UNAVAILABLE object store/provider (throw) as a stop with no marker", async () => {
    const { result, calls, stored } = await runWith({ throwSnapshot: true });
    expect(result.decision).toEqual({ action: "stop", markerWritten: false, reason: "snapshot_failed" });
    expect(calls).not.toContain("writeMarker");
    expect(stored).toHaveLength(0);
  });

  it("writes NO marker when the checksum fails (and never reaches restore)", async () => {
    const { result, calls, stored } = await runWith({ checksumOk: false });
    expect(result.decision.reason).toBe("checksum_failed");
    expect(calls).toContain("validateChecksum");
    expect(calls).not.toContain("restoreAndValidate");
    expect(calls).not.toContain("writeMarker");
    expect(stored).toHaveLength(0);
  });

  it("writes NO marker when the isolated restore-validation fails", async () => {
    const { result, calls, stored } = await runWith({ restoreOk: false });
    expect(result.decision.reason).toBe("restore_validation_failed");
    expect(calls).not.toContain("writeMarker");
    expect(stored).toHaveLength(0);
  });

  it("STOPs when the marker write itself fails", async () => {
    const { result } = await runWith({ writeOk: false });
    expect(result.decision).toEqual({ action: "stop", markerWritten: false, reason: "marker_write_failed" });
  });

  it("STOPs when the marker read-back verification fails", async () => {
    const { result } = await runWith({ verifyReturnsNull: true });
    expect(result.decision).toEqual({ action: "stop", markerWritten: false, reason: "marker_verify_failed" });
  });

  it("takes the snapshot BEFORE writing the marker on the happy path", async () => {
    const { result, calls, stored } = await runWith({});
    expect(result.decision).toEqual({ action: "proceed", markerWritten: true, reason: "cutover_ready" });
    expect(calls.indexOf("takeSnapshot")).toBeLessThan(calls.indexOf("writeMarker"));
    expect(calls.indexOf("validateChecksum")).toBeLessThan(calls.indexOf("writeMarker"));
    expect(calls.indexOf("restoreAndValidate")).toBeLessThan(calls.indexOf("writeMarker"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ candidateSha: SHA, snapshotRef: "s3://snap/ref", snapshotChecksum: "deadbeef" });
  });

  it("idempotent repeat: an existing verified marker takes NO snapshot and writes NOTHING new", async () => {
    const existing: CutoverMarkerRow = {
      candidateSha: SHA,
      snapshotRef: "s3://prior",
      snapshotChecksum: "priorsum",
      verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const { result, calls, stored } = await runWith({ existingMarker: existing });
    expect(result.decision).toEqual({ action: "proceed", markerWritten: false, reason: "idempotent_marker_present" });
    expect(calls).not.toContain("takeSnapshot");
    expect(calls).not.toContain("writeMarker");
    expect(stored).toEqual([existing]);
  });
});
