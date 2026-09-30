import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger.js";
import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { RECONCILE_PROVIDER_OUTAGE_EVENT, reconcile } from "../supervisor/reconcile.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

// -----------------------------------------------------------------------------
// CLI-004 / D2 — the one genuine gap: a structured OPERATOR ALERT on a
// reconciliation-time provider outage. Before CLI-004 a reconcile outage was a
// `cleanup_outcome{outcome="failed"}` counter + a per-orphan info log only — no
// operator-facing alert, so "provider outage backs off with an alert" was not
// honestly satisfied. The alert is emitted from the EXISTING reconcile() path
// (after the sweep, read-only) and reuses the existing failed metric + the
// redacting logger. It carries ONLY the HASHED ownership scope + the failed
// count — never a raw org/target/worker id, command, env, or secret byte.
// -----------------------------------------------------------------------------

const selector = { organizationId: "org-1", targetId: "target-1", workerId: "worker-1" };

function spyLogger(): { logger: Logger; errors: Array<{ bindings: Record<string, unknown>; message: string }> } {
  const errors: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const logger: Logger = {
    info() {},
    warn() {},
    error(a: { readonly err: unknown } | Record<string, unknown>, b: string) {
      errors.push({ bindings: a as Record<string, unknown>, message: b });
    },
    flush: async () => {},
  };
  return { logger, errors };
}

describe("reconcile-outage-alert — a sweep with ≥1 failed cleanup raises a structured operator alert", () => {
  it("fires a `reconcile_provider_outage` alert carrying the hashed ownership + failed count (no sensitive bytes)", async () => {
    const fake = createFakeSandboxProvider({
      seededResources: [{ sandboxId: "sbx-outage", labels: sampleLabels({ jobId: "j-out", leaseId: "l-out" }), hasLiveLease: false }],
      reconcileFailures: Number.POSITIVE_INFINITY,
    });
    const { logger, errors } = spyLogger();
    const metrics = createMetrics();

    const result = await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx(), metrics, logger });

    expect(result.orphansFailed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(RECONCILE_PROVIDER_OUTAGE_EVENT);
    const b = errors[0].bindings;
    expect(b.event).toBe(RECONCILE_PROVIDER_OUTAGE_EVENT);
    expect(b.orphansFailed).toBe(1);
    expect(typeof b.ownershipHash).toBe("string");
    expect((b.ownershipHash as string).length).toBe(64); // sha-256 hex
    // Pin the DERIVATION (not just the shape): the hash is the sha-256 of the
    // canonical (org, target, worker) scope — so a constant-hash regression that
    // still passes the no-leak checks below cannot slip through.
    const expectedHash = createHash("sha256")
      .update([selector.organizationId, selector.targetId, selector.workerId].join(" "), "utf8")
      .digest("hex");
    expect(b.ownershipHash).toBe(expectedHash);

    // Reuses the EXISTING failed metric — no new metric surface.
    expect(metrics.renderPrometheus()).toContain('cleanup_outcome{outcome="failed"} 1');

    // The alert carries NO raw ownership id (only the hash) and no secret byte.
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("org-1");
    expect(serialized).not.toContain("target-1");
    expect(serialized).not.toContain("worker-1");
  });

  it("does NOT alert on a clean sweep (zero failed cleanups)", async () => {
    const fake = createFakeSandboxProvider({
      seededResources: [
        { sandboxId: "sbx-live", labels: sampleLabels({ jobId: "j1", leaseId: "l1" }), hasLiveLease: true },
        { sandboxId: "sbx-orphan", labels: sampleLabels({ jobId: "j2", leaseId: "l2" }), hasLiveLease: false },
      ],
    });
    const { logger, errors } = spyLogger();

    const result = await reconcile({ provider: fake, ownershipSelector: selector, makeCtx: () => makeCtx(), logger });

    expect(result.orphansDestroyed).toBe(1);
    expect(result.orphansFailed).toBe(0);
    expect(errors).toHaveLength(0);
  });
});
