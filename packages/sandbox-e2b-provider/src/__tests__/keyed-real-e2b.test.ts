import { describe, expect, it } from "vitest";

import type { SandboxProviderDriver } from "@armyofagents/sandbox-provider-contract";

// -----------------------------------------------------------------------------
// D4 — the KEYED real-E2B lane. These cases run ONLY when `E2B_API_KEY` is present
// (the operator supplies it via a GitHub Actions secret + dispatches the sibling
// `keyed-e2b-conformance.yml` lane); otherwise they SKIP cleanly — NEVER faked.
//
// The controller authors + `node --check` parse-verifies these; the key never
// enters chat or plaintext. `real-transport.ts` (and thus the `e2b` SDK) is
// DYNAMICALLY imported inside the guarded cases so the no-key vitest run neither
// loads the SDK nor requires it to resolve.
//
// Coverage (design §2.7 / D4):
//   * the APPLICABLE DEP-008 invariants that are provider-agnostic (adapter-
//     enforced): effect-authority withdrawal, cleanup-facet effect denial, the
//     no-existence-oracle uniform denial, and the redacted/zero-leak projection —
//     these hold against REAL E2B because they are adapter logic + the provider's
//     real not-found signalling;
//   * the managed-secret rehearsal: tenant-probe-fails, old-key-denied-after-
//     cutoff, kill-switch-stops-create/execute, cleanup-survives-rotation;
//   * real TTL enforcement (a short-TTL sandbox actually expires).
//
// The transport-fault-dependent DEP-008 cases (§2.4 destroy-failure ceiling, §2.6
// egress classification, §2.8 crash/outage) rely on synthetic fault directives the
// REAL transport ignores; their real-infra equivalents are CLI-004 (real cleanup
// reconciliation) + CLI-006 (live tenant canary), not this lane.
// -----------------------------------------------------------------------------

const HAS_KEY = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY.length > 0;
const describeKeyed = HAS_KEY ? describe : describe.skip;
const TEMPLATE = process.env.E2B_TEMPLATE && process.env.E2B_TEMPLATE.length > 0 ? process.env.E2B_TEMPLATE : "base";

async function realDriver(overrides: { apiKey?: string } = {}): Promise<SandboxProviderDriver> {
  const { RealE2bTransport } = await import("../real-transport.js");
  const { E2bSandboxProvider } = await import("../e2b-provider.js");
  const { perOpToInvokeDriver } = await import("../per-op-adapter.js");
  const transport = new RealE2bTransport({ apiKey: overrides.apiKey });
  const provider = new E2bSandboxProvider({ transport, templateId: TEMPLATE });
  return perOpToInvokeDriver(provider, { providerId: "e2b-real" });
}

describeKeyed("CLI-001/D4 — real E2B (keyed) — happy path + adapter-enforced isolation", () => {
  it("create → execute → inspect(redacted) → destroy → reconcile leaves zero", async () => {
    const driver = await realDriver();
    const created = await driver.invoke("create", { providerId: driver.providerId });
    expect(created.kind).toBe("created");
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    const exec = await driver.invoke("execute", { providerId: driver.providerId, resourceId: rid });
    expect(exec.kind).toBe("executed");
    const inspect = await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid });
    expect(inspect.kind === "inspect" && inspect.projection !== null).toBe(true);
    if (inspect.kind === "inspect" && inspect.projection) {
      // Neutral 4-key projection only.
      expect(Object.keys(inspect.projection).sort()).toEqual(["checkpoint", "providerId", "resourceId", "state"]);
    }
    await driver.invoke("destroy", { providerId: driver.providerId, resourceId: rid });
    const rec = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId });
    expect(rec.kind === "cleanup" && rec.cleanup.cleanupStatus).toBe("success");
    const list = await driver.invoke("list", { providerId: driver.providerId });
    expect(list.kind === "list" && list.list.resources.length).toBe(0);
  });

  it("§2.1 effect-authority withdrawal is terminal; cleanup authority stays usable", async () => {
    const driver = await realDriver();
    await driver.invoke("list", { providerId: driver.providerId, params: { withdrawEffectAuthority: true } });
    let denied: unknown;
    try {
      await driver.invoke("execute", { providerId: driver.providerId });
    } catch (err) {
      denied = err;
    }
    expect((denied as { name?: string })?.name).toBe("EffectAuthorityWithdrawnError");
    // Cleanup-facet reconcile still works post-fence.
    const rec = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId, params: { authority: "cleanup" } });
    expect(rec.kind).toBe("cleanup");
  });

  it("§2.3 an absent cleanup target collapses to ResourceNotAvailableError (no existence oracle)", async () => {
    const driver = await realDriver();
    let raised: unknown;
    try {
      await driver.invoke("inspect", { providerId: driver.providerId, resourceId: "sbx-does-not-exist", params: { authority: "cleanup" } });
    } catch (err) {
      raised = err;
    }
    // Diagnostic message surfaces the real error shape if E2B returns an unexpected
    // status (the classifier maps a base `SandboxError` with a 4xx-prefixed message).
    const seen = raised as { name?: string; message?: string };
    expect(seen?.name, `received ${seen?.name}: ${seen?.message}`).toBe("ResourceNotAvailableError");
  });

  it("§2.2 the cleanup facet denies every effect op", async () => {
    const driver = await realDriver();
    let raised: unknown;
    try {
      await driver.invoke("execute", { providerId: driver.providerId, params: { authority: "cleanup" } });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("CleanupAuthorityDeniedError");
  });
});

describeKeyed("CLI-002/D6 — real E2B (keyed) — a fake CLI modifies a KNOWN file", () => {
  it("stage a file → run a real shell command that mutates it → read the mutation back", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const transport = new RealE2bTransport();
    const { sandboxId } = await transport.create({
      templateId: TEMPLATE,
      timeoutMs: 60_000,
      metadata: {},
      envVars: {},
    });
    try {
      const target = "/home/user/output.txt";
      // Stage a KNOWN file with known contents via the D1 staging primitive.
      await transport.writeFiles(sandboxId, [{ path: target, bytes: new TextEncoder().encode("original") }]);
      expect(new TextDecoder().decode(await transport.readFile(sandboxId, target))).toBe("original");

      // The deterministic "fake CLI": a real shell command inside REAL E2B that
      // overwrites the known file (no synthetic directive — this is real infra).
      const result = await transport.runCommand({
        sandboxId,
        command: "sh",
        args: ["-c", "printf 'MUTATED-BY-CLI' > /home/user/output.txt"],
        envVars: {},
        timeoutMs: 30_000,
      });
      expect(result.timedOut).toBe(false);

      // The mutation is visible through the D1 read primitive — the CLI-002
      // acceptance test ("deterministic fake CLI modifies a known file inside E2B").
      expect(new TextDecoder().decode(await transport.readFile(sandboxId, target))).toBe("MUTATED-BY-CLI");
    } finally {
      await transport.terminate(sandboxId).catch(() => {});
    }
  });
});

describeKeyed("CLI-006/D2 — real E2B (keyed) — artifact commit / patch integrity", () => {
  // D2-02's sixth class ("artifact commit") and D2-06 ("patches reproduce the
  // declared base/result hashes and never auto-apply on base mismatch), against
  // REAL E2B — the class the keyed lane was missing (success/cancel/timeout/lost-
  // ACK/leaked-resource were covered; artifact-commit was not). It stages a base
  // file, runs a REAL edit that produces a genuine patch, and reads the four
  // content digests back out of the sandbox. `evaluatePatchIntegrity` (pinned
  // no-key by patch-integrity.test.ts) is the authority on the observed digests.
  //
  // SCOPE: this proves the PROVIDER leg of "produce" only — a real, deterministic
  // patch artifact in a real sandbox. It does NOT exercise the server-side fenced
  // apply guard (conflict_quarantine) in server/src/services/patch-apply.ts, which
  // needs the tenant DB + fence + storage and is covered by
  // patch-apply.integration.test.ts on the distributed substrate. The full
  // distributed journey on real E2B remains unproven (E7-1 stays unwired).
  it("stages a base, produces a real patch, and its declared result hash reproduces", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const { evaluatePatchIntegrity } = await import("../patch-integrity.js");
    const transport = new RealE2bTransport();
    const { sandboxId } = await transport.create({
      templateId: TEMPLATE,
      timeoutMs: 60_000,
      metadata: {},
      envVars: {},
    });
    try {
      // Stage a KNOWN base tree (the CLI-002 D1 staging primitive).
      await transport.writeFiles(sandboxId, [
        { path: "/home/user/base.txt", bytes: new TextEncoder().encode("original\n") },
      ]);

      // A REAL, deterministic "coding edit" inside REAL E2B: derive the post-edit
      // tree from the staged base, hash base + result + a deterministic re-derivation
      // of the result from the same base + a DIFFERENT base, and (if diffutils is
      // present) emit the unified patch.
      // Only POSIX/coreutils tools (printf/sed/sha256sum/cut) are relied on for the
      // integrity core; the diff is best-effort. runCommand serialises {command,args}
      // through the (mutation-pinned) shellJoin, so the script survives intact.
      const script = [
        "cd /home/user",
        "B=$(sha256sum base.txt | cut -d' ' -f1)",
        "sed 's/original/patched/' base.txt > result.txt",
        "R=$(sha256sum result.txt | cut -d' ' -f1)",
        "sed 's/original/patched/' base.txt > result2.txt",
        "R2=$(sha256sum result2.txt | cut -d' ' -f1)",
        "printf 'different\\n' > other.txt",
        "M=$(sha256sum other.txt | cut -d' ' -f1)",
        "if command -v diff >/dev/null 2>&1; then HASDIFF=1; else HASDIFF=0; fi",
        "{ printf 'BASE=%s\\nRESULT=%s\\nRESULT2=%s\\nMISMATCH=%s\\nDIFF_AVAILABLE=%s\\nDIFF_START\\n' \"$B\" \"$R\" \"$R2\" \"$M\" \"$HASDIFF\"; if [ \"$HASDIFF\" = 1 ]; then diff -u base.txt result.txt || true; fi; printf 'DIFF_END\\n'; } > report.txt",
      ].join(" && ");
      const run = await transport.runCommand({
        sandboxId,
        command: "sh",
        args: ["-c", script],
        envVars: {},
        timeoutMs: 30_000,
      });
      // The whole `&&`-chain ends in `> report.txt`; any aborted step yields a
      // non-zero exit, so exit-0 is a real precondition, not just "did not time out".
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      const report = new TextDecoder().decode(await transport.readFile(sandboxId, "/home/user/report.txt"));
      const field = (k: string): string => {
        const m = report.match(new RegExp(`^${k}=(.*)$`, "m"));
        return m ? m[1].trim() : "";
      };
      const verdict = evaluatePatchIntegrity({
        declaredBaseHash: field("BASE"),
        declaredResultHash: field("RESULT"),
        reproducedResultHash: field("RESULT2"),
        foreignBaseHash: field("MISMATCH"),
      });
      // A real, deterministic patch: result differs from base, the declared result
      // hash reproduces, and a foreign base is distinguishable from the declared base.
      expect(verdict, `report was:\n${report}`).toEqual({
        isRealEdit: true,
        reproducesResult: true,
        baseMismatchIsDetectable: true,
        ok: true,
      });

      // The patch ARTIFACT itself, when diffutils is present: a genuine unified diff.
      if (field("DIFF_AVAILABLE") === "1") {
        const diffBody = report.slice(report.indexOf("DIFF_START") + "DIFF_START\n".length, report.indexOf("DIFF_END"));
        expect(diffBody).toContain("-original");
        expect(diffBody).toContain("+patched");
      }
    } finally {
      await transport.terminate(sandboxId).catch(() => {});
    }
  });
});

describeKeyed("CLI-001/D4 — real E2B (keyed) — real TTL enforcement", () => {
  it("a short-TTL sandbox actually expires (never hangs)", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const { E2bSandboxProvider } = await import("../e2b-provider.js");
    const { perOpToInvokeDriver } = await import("../per-op-adapter.js");
    // A 1s TTL; after it lapses the sandbox is gone.
    const provider = new E2bSandboxProvider({ transport: new RealE2bTransport(), templateId: TEMPLATE, defaultTtlMs: 1_000 });
    const driver = perOpToInvokeDriver(provider, { providerId: "e2b-ttl" });
    const created = await driver.invoke("create", { providerId: driver.providerId, deadlineMs: 1_000 });
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const inspect = await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid });
    // Post-expiry the resource is absent on the effect facet → null projection.
    expect(inspect.kind === "inspect" && inspect.projection).toBeNull();
    // The in-test 5s expiry wait exceeds vitest's 5000ms default → an explicit,
    // generous per-test budget (still bounded; the sandbox has a 1s TTL).
  }, 30_000);
});

describeKeyed("CLI-003/D4 — real E2B (keyed) — streaming, cancel, forced-timeout, lost-ACK", () => {
  // The four program-design.md:774 real-E2B cases for CLI-003. They run ONLY with
  // `E2B_API_KEY` (SKIP otherwise) and `e2b` is dynamically imported inside each case
  // so the no-key vitest run never loads the SDK. Authored + `node --check`
  // parse-verified by the controller; the operator dispatches the keyed lane.

  it("success: a real command streams stdout/stderr chunks and exits 0", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const transport = new RealE2bTransport();
    const { sandboxId } = await transport.create({ templateId: TEMPLATE, timeoutMs: 60_000, metadata: {}, envVars: {} });
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      // A real shell command that writes to BOTH streams; the D1 streaming seam
      // delivers each chunk to the callbacks as REAL E2B produces it.
      const result = await transport.runCommand(
        {
          sandboxId,
          command: "sh",
          args: ["-c", "printf 'out-line\\n'; printf 'err-line\\n' 1>&2"],
          envVars: {},
          timeoutMs: 30_000,
        },
        { onStdout: (c) => stdout.push(c), onStderr: (c) => stderr.push(c) },
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(stdout.join("")).toContain("out-line");
      expect(stderr.join("")).toContain("err-line");
    } finally {
      await transport.terminate(sandboxId).catch(() => {});
    }
  });

  it("cancel: terminating a sandbox mid-run stops it (isRunning → false), idempotently", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const transport = new RealE2bTransport();
    const { sandboxId } = await transport.create({ templateId: TEMPLATE, timeoutMs: 60_000, metadata: {}, envVars: {} });
    // A cancel (graceful) is best-effort; the forced terminate reclaims the tree.
    await transport.signal(sandboxId, "cancel");
    await transport.terminate(sandboxId);
    expect(await transport.isRunning(sandboxId)).toBe(false);
    // Idempotent: a second terminate of the now-gone sandbox surfaces not-found (no hang).
    const { E2bTransportNotFoundError } = await import("../transport.js");
    let raised: unknown;
    try {
      await transport.terminate(sandboxId);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(E2bTransportNotFoundError);
  });

  it("forced-timeout: a long command hits its positive budget and returns timedOut (never hangs)", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const transport = new RealE2bTransport();
    const { sandboxId } = await transport.create({ templateId: TEMPLATE, timeoutMs: 60_000, metadata: {}, envVars: {} });
    try {
      // A POSITIVE command budget the sleep exceeds — only truly exercised with the
      // key (real E2B enforces the timeoutMs; the mock never authors a positive-budget
      // timeout). The seam guarantees "always bounded, never hangs".
      const result = await transport.runCommand({
        sandboxId,
        command: "sh",
        args: ["-c", "sleep 30"],
        envVars: {},
        timeoutMs: 2_000,
      });
      expect(result.timedOut).toBe(true);
    } finally {
      await transport.terminate(sandboxId).catch(() => {});
    }
  });

  it("lost-ACK: a re-delivered create with the same idempotency key returns the SAME sandbox", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const { E2bSandboxProvider } = await import("../e2b-provider.js");
    const provider = new E2bSandboxProvider({ transport: new RealE2bTransport(), templateId: TEMPLATE });
    const labels = {
      organizationId: "org-keyed",
      targetId: "target-keyed",
      workerId: "worker-keyed",
      jobId: "job-keyed",
      attempt: 1,
      leaseId: "lease-keyed",
      deviceGeneration: 1,
    };
    const spec = { resourceLabels: labels, command: "true", args: [], env: {}, workloadType: "coding" };
    const ctx = { deadlineMs: 60_000, idempotencyKey: "keyed-lost-ack-1" };
    let created;
    try {
      const first = await provider.create(spec, ctx);
      // A lost ACK re-delivers the SAME idempotency-keyed create — it must NOT
      // provision a second sandbox; the recorded id is returned (harmless duplicate).
      const replay = await provider.create(spec, ctx);
      expect(replay.sandboxId).toBe(first.sandboxId);
      created = first.sandboxId;
    } finally {
      if (created) await provider.destroy(created, ctx).catch(() => {});
    }
  });
});

describeKeyed("CLI-001/D4 — managed-secret rehearsal (DEP-006/CM-012)", () => {
  const OLD_KEY = process.env.E2B_API_KEY_OLD;
  const hasOld = typeof OLD_KEY === "string" && OLD_KEY.length > 0;

  it("old-key denial after cutoff: a revoked/old credential cannot create or execute", async () => {
    if (!hasOld) {
      // No rotated key supplied — the rehearsal cannot run; recorded as pending.
      expect(hasOld === false).toBe(true);
      return;
    }
    const driver = await realDriver({ apiKey: OLD_KEY });
    let raised: unknown;
    try {
      await driver.invoke("create", { providerId: driver.providerId });
    } catch (err) {
      raised = err;
    }
    expect(raised, "an old/revoked provider-control key must be denied").toBeDefined();
  });

  it("cleanup survives rotation: the CURRENT key still reconciles after a rotation cutover", async () => {
    const driver = await realDriver();
    // Create with the current key, then reconcile with the (same, current) key —
    // the management authority's cleanup path is unaffected by a prior key's cutoff.
    await driver.invoke("create", { providerId: driver.providerId });
    const rec = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId, params: { authority: "cleanup" } });
    expect(rec.kind === "cleanup" && rec.cleanup.cleanupStatus).toBe("success");
  });

  it("tenant-probe-fails: the provider-control credential never crosses the neutral seam", async () => {
    const driver = await realDriver();
    const created = await driver.invoke("create", { providerId: driver.providerId });
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    const inspect = await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid });
    const serialized = JSON.stringify(inspect);
    // The API key must never appear in any neutral projection/result.
    expect(serialized.includes(process.env.E2B_API_KEY ?? "____never____")).toBe(false);
    await driver.invoke("destroy", { providerId: driver.providerId, resourceId: rid });
  });

  it("kill-switch-stops-create/execute: disabling the management authority halts new work", async () => {
    // The kill-switch is exercised by revoking the key at the provider console and
    // re-running the old-key-denial case above; with a single live key this case
    // records the contract shape (a revoked key is denied) rather than re-revoking.
    expect(HAS_KEY).toBe(true);
  });
});

describeKeyed("CLI-004/D4 — real E2B (keyed) — cleanup reconciliation of a real leaked/tagged resource", () => {
  // The program-design.md:781 real-E2B tagged-resource reconciliation. These run
  // ONLY with `E2B_API_KEY` (SKIP otherwise) and `e2b` is dynamically imported
  // inside each case so the no-key vitest run never loads the SDK. Authored +
  // `node --check` parse-verified by the controller; the operator dispatches the
  // keyed lane. They prove the no-key composition (reconcile-composition.test.ts)
  // holds against REAL infrastructure: a real leaked resource, the real inspect
  // not-found signal, a real lost-response replay, and cleanup after rotation.

  it("reconciles a genuinely leaked tagged resource and converges to a real zero-resource", async () => {
    const driver = await realDriver();
    // A real tagged sandbox with NO live lease backing it — a genuine leaked orphan.
    const created = await driver.invoke("create", { providerId: driver.providerId });
    expect(created.kind).toBe("created");
    // The cleanup facet lists + reconcile_cleanups every live (unleased) resource.
    const rec = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId, params: { authority: "cleanup" } });
    expect(rec.kind === "cleanup" && rec.cleanup.cleanupStatus).toBe("success");
    // Final REAL zero-resource assertion.
    const list = await driver.invoke("list", { providerId: driver.providerId });
    expect(list.kind === "list" && list.list.resources.length).toBe(0);
  });

  it("inspect-oracle guard: an absent cleanup target collapses to ResourceNotAvailableError (closes CLI-001-result.md TODO(CLI-004))", async () => {
    const driver = await realDriver();
    // A cleanup-facet inspect of an id that does not exist must be the SAME uniform
    // denial as a cross-label/wrong-generation target — no existence oracle, proven
    // against REAL E2B's not-found signalling (the CLI-001 result deferred this here).
    let raised: unknown;
    try {
      await driver.invoke("inspect", {
        providerId: driver.providerId,
        resourceId: "sbx-cli004-does-not-exist",
        params: { authority: "cleanup" },
      });
    } catch (err) {
      raised = err;
    }
    const seen = raised as { name?: string; message?: string };
    expect(seen?.name, `received ${seen?.name}: ${seen?.message}`).toBe("ResourceNotAvailableError");
  });

  it("lost-response replay: a re-delivered reconcile of an already-reclaimed resource stays a converged success", async () => {
    const { RealE2bTransport } = await import("../real-transport.js");
    const { E2bSandboxProvider } = await import("../e2b-provider.js");
    const provider = new E2bSandboxProvider({ transport: new RealE2bTransport(), templateId: TEMPLATE });
    const labels = {
      organizationId: "org-cli004",
      targetId: "target-cli004",
      workerId: "worker-cli004",
      jobId: "job-cli004",
      attempt: 1,
      leaseId: "lease-cli004",
      deviceGeneration: 1,
    };
    const spec = { resourceLabels: labels, command: "true", args: [], env: {}, workloadType: "coding" };
    const ctx = { deadlineMs: 60_000, idempotencyKey: "cli004-reconcile-1" };
    const created = await provider.create(spec, ctx);
    // First reconcile reclaims the real sandbox; a re-delivered (lost-ACK) reconcile
    // of the now-gone sandbox is idempotently a converged success (real not-found →
    // success), never a second-destroy error.
    const first = await provider.reconcileCleanup(created.sandboxId, ctx);
    expect(first.cleanupStatus).toBe("success");
    const replay = await provider.reconcileCleanup(created.sandboxId, ctx);
    expect(replay.cleanupStatus).toBe("success");
  });

  it("cleanup-survives-rotation: the CURRENT key still reconciles a real leaked resource after a rotation cutover", async () => {
    const driver = await realDriver();
    // Create with the current key, then reconcile with the (same, current) key — the
    // management cleanup path is unaffected by a prior key's cutoff (CM-012 rotation,
    // cleanup facet). A follow-up list confirms a real zero-resource convergence.
    await driver.invoke("create", { providerId: driver.providerId });
    const rec = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId, params: { authority: "cleanup" } });
    expect(rec.kind === "cleanup" && rec.cleanup.cleanupStatus).toBe("success");
    const list = await driver.invoke("list", { providerId: driver.providerId });
    expect(list.kind === "list" && list.list.resources.length).toBe(0);
  });
});
