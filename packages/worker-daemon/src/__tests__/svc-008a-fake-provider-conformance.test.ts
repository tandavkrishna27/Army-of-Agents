// -----------------------------------------------------------------------------
// SVC-008a — T8's fourth `SandboxProvider` arm: the worker-daemon test double.
//
// ★ WHY IT IS HERE AND NOT IN T8's OWN FILE. `worker-daemon/src/__tests__/support` is not
// an exported entry point and worker-daemon is UPSTREAM of `provider-wire`, so the
// cross-package suite cannot import it. T8's directory walk therefore lists this
// implementer BY NAME with a pointer to this file, rather than omitting it — a named
// deferral is checkable, a missing row is not.
//
// ★★★ AND WHY THE DOUBLE'S OWN CAPABILITY IS THE POINT. This file's header already says a
// fake that could not inject "an ignored cancel, an ignored kill" would be a DEFECT. The
// dimension it could NOT inject until now is the one E7-F034 lived in: an observation that
// says "I could not tell", and a signal that was ACCEPTED while the process kept running.
// Until this ticket, no double in this tree could produce either — which is precisely why
// three correct `CleanupAuthority` unit tests were green against a precondition production
// could never supply.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import {
  deriveStopVerdict,
  ProcessLaunchNotAcknowledged,
  UnsupportedProviderOperation,
  type ProviderOpContext,
  type ResourceLabels,
} from "../supervisor/provider.js";

const LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 1,
};

let seq = 0;
const ctx = (): ProviderOpContext => ({ deadlineMs: 5_000, idempotencyKey: `svc008a-${++seq}` });

async function withSandbox(script: Parameters<typeof createFakeSandboxProvider>[0]) {
  const provider = createFakeSandboxProvider(script);
  const created = await provider.create(
    { resourceLabels: LABELS, command: "sleep", args: [], env: {}, workloadType: "service" },
    ctx(),
  );
  return { provider, sandboxId: created.sandboxId };
}

describe("SVC-008a — the worker-daemon double declines by default (clause 7)", () => {
  it('an unscripted double is "none" and all three methods reject with UnsupportedProviderOperation', async () => {
    // Defaults to declining rather than fabricating a launch, for the same reason
    // `artifactExportMode`/`fileStagingMode` do: a fabricated success is byte-identical to
    // a real one on every gate downstream.
    const { provider, sandboxId } = await withSandbox({});
    expect(provider.processSupervisionMode).toBe("none");
    await expect(
      provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx()),
    ).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(provider.processStatus(sandboxId, "h", ctx())).rejects.toBeInstanceOf(
      UnsupportedProviderOperation,
    );
    await expect(provider.signalProcess(sandboxId, "h", "kill", ctx())).rejects.toBeInstanceOf(
      UnsupportedProviderOperation,
    );
  });
});

describe("SVC-008a — the double can represent every arm production has", () => {
  it("clause 8 — a refused launch THROWS; it never resolves an empty handle", async () => {
    const { provider, sandboxId } = await withSandbox({ processSupervisionMode: "handle", refuseLaunch: true });
    await expect(
      provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx()),
    ).rejects.toBeInstanceOf(ProcessLaunchNotAcknowledged);
  });

  it("clause 8 POSITIVE CONTROL — an accepted launch resolves a non-empty handle", async () => {
    const { provider, sandboxId } = await withSandbox({ processSupervisionMode: "handle" });
    const started = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    expect(started.handle).not.toBe("");
    expect(started.handle.length).toBeGreaterThan(0);
  });

  it("clause 5 — 'I could not tell' is representable, and derives to UNDETERMINED", async () => {
    const { provider, sandboxId } = await withSandbox({
      processSupervisionMode: "handle",
      processState: "unknown",
      processUnknownReason: "read_failed",
    });
    const started = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    const status = await provider.processStatus(sandboxId, started.handle, ctx());
    expect(status.observation).toMatchObject({ state: "unknown", reason: "read_failed" });
    expect(deriveStopVerdict(status.observation)).toBe("undetermined");
  });

  it("★ THE CASE THAT IS REAL E2B'S ONLY CASE — accepted, and nothing stopped", async () => {
    // The signal was TAKEN and the process is STILL RUNNING. `accepted` is about the call
    // and carries no claim about the process; the verdict comes from the observation and
    // from nowhere else. `ProcessSignalResult` has no member that could name a stop.
    const { provider, sandboxId } = await withSandbox({
      processSupervisionMode: "handle",
      signalAccepted: "accepted",
      signalStopsProcess: false,
    });
    const started = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    const result = await provider.signalProcess(sandboxId, started.handle, "kill", ctx());
    expect(result.accepted).toBe("accepted");
    expect(result.observation.state).toBe("running");
    expect(deriveStopVerdict(result.observation)).toBe("still_up");
    expect(result).not.toHaveProperty("outcome");
  });

  it("clause 4 POSITIVE CONTROL — a signal that really stops derives to STOPPED", async () => {
    const { provider, sandboxId } = await withSandbox({
      processSupervisionMode: "handle",
      signalAccepted: "accepted",
      signalStopsProcess: true,
    });
    const started = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    const result = await provider.signalProcess(sandboxId, started.handle, "kill", ctx());
    expect(deriveStopVerdict(result.observation)).toBe("stopped");
  });

  it("clause 11 — a graceful cancel defaults to 'unsupported', matching the shipping transport", async () => {
    // ★ THE DOUBLE MUST NOT BE MORE CAPABLE THAN PRODUCTION. `e2b@2.30.5` has no per-pid
    // SIGTERM, so a double whose default `cancel` genuinely stopped a process would be
    // E7-F034's shape rebuilt one layer up.
    const { provider, sandboxId } = await withSandbox({ processSupervisionMode: "handle" });
    const started = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    const result = await provider.signalProcess(sandboxId, started.handle, "cancel", ctx());
    expect(result.accepted).toBe("unsupported");
    expect(result.observation.state).toBe("running");
  });

  it("clause 13 — ★ a REPLAYED idempotency key returns the recorded launch and starts nothing new", async () => {
    // This double's own header promises "a repeated `idempotencyKey` returns the recorded
    // result and does NOT double-apply", and `ProviderOpContext` states it as the port
    // contract. `startProcess` shipped ignoring its ctx entirely, so the ONE operation where
    // a double-apply costs a second live service instance was the one operation that did not
    // honour it — and a double that double-applies cannot red the provider that does.
    const { provider, sandboxId } = await withSandbox({ processSupervisionMode: "handle" });
    const replay: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "svc008a-replay" };
    const first = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, replay);
    const second = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, replay);
    expect(second.handle).toBe(first.handle);
    expect(second.providerOpId).toBe(first.providerOpId);

    // POSITIVE CONTROL — a fresh key is a genuinely new process, so the ledger is not just
    // "always hand back the first handle".
    const third = await provider.startProcess({ sandboxId, command: "c", args: [], env: {} }, ctx());
    expect(third.handle).not.toBe(first.handle);
    expect(third.providerOpId).not.toBe(first.providerOpId);
  });

  it("clause 9 — a handle the store does not hold is 'gone': an ANSWER, not a failure to look", async () => {
    const { provider, sandboxId } = await withSandbox({ processSupervisionMode: "handle" });
    const status = await provider.processStatus(sandboxId, "never-minted", ctx());
    expect(status.observation.state).toBe("gone");
    expect(deriveStopVerdict(status.observation)).toBe("stopped");
  });
});

describe("SVC-008a — deriveStopVerdict is the single derivation, and it has no default branch", () => {
  it("maps every inhabitant exactly once", () => {
    expect(deriveStopVerdict({ state: "running", observedAt: 1 })).toBe("still_up");
    expect(deriveStopVerdict({ state: "exited", exitCode: 0, signal: null, observedAt: 1 })).toBe("stopped");
    expect(deriveStopVerdict({ state: "gone", observedAt: 1 })).toBe("stopped");
    for (const reason of ["read_failed", "sandbox_unreachable", "handle_unrecognized", "state_unrecognized"] as const) {
      // ★ NEVER "stopped". This is the whole point of the value: a caller must escalate,
      // and must never conclude.
      expect(deriveStopVerdict({ state: "unknown", reason })).toBe("undetermined");
    }
  });
});
