// Plan 3a Task 7 (C2) — the connector approve/reject truth table, unit-tested
// against the EXPORTED helpers rather than through approvalService.
//
// WHY DIRECTLY: approve()/reject() need a mocked drizzle db, a mocked
// @armyofagents/db module graph and a resolved approval row before the connector
// branch is even reached — five moving parts between the test and the one
// decision under test. `assertTransportAllowed` set the precedent in this
// codebase: extract the decision, test the truth table directly, and keep a
// separate wiring test (approvals-mcp-connector.test.ts) proving approvalService
// actually calls it.
//
// THE DEFECT THESE PIN:
//   approve():  flipped ANY non-active connector straight to `active`, so
//               approving a connector that requires a secret and has none
//               ACTIVATED IT UNCREDENTIALED — the one thing the design forbids.
//   reject():   guarded on `status === "pending_approval"` only, so rejecting a
//               connector sitting in `needs_credentials` was a SILENT NO-OP and
//               it stayed on a path that later reaches `active`.
//
// No module mocks are needed: approvals.ts imports drizzle/@armyofagents/db, but
// these helpers are pure over the injected `svc`, and the import graph resolves
// fine unmocked in vitest (the helpers never touch a Db handle).

import { describe, expect, it, vi } from "vitest";
import { applyConnectorApproval, applyConnectorRejection } from "../services/approvals.js";

const CO = "co1";

/**
 * A connector row stub + observable writers.
 *
 * `updateIfStatusAndSecret` is the guarded UPDATE the approve path uses (Finding 6
 * — the guard re-checks status AND secret-boundness): it returns a row only when
 * the precondition matches, and `null` when it does not, which is how a lost
 * TOCTOU race is simulated below. `updateIfStatus` is retained on the stub for the
 * structural type; the approve path no longer calls it.
 */
function makeSvc(connector: Record<string, unknown> | null, guardMatches = true) {
  return {
    getById: vi.fn().mockResolvedValue(connector),
    update: vi.fn().mockResolvedValue({}),
    updateIfStatus: vi.fn().mockResolvedValue(guardMatches ? {} : null),
    updateIfStatusAndSecret: vi.fn().mockResolvedValue(guardMatches ? {} : null),
  };
}

describe("applyConnectorApproval — credentials gate the activation (C2)", () => {
  it("approving a connector that requires a secret it does not have yields needs_credentials, NOT active", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: true,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    // hasSecret=false → expectSecretBound=false.
    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", false, {
      status: "needs_credentials",
    });
    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalledWith(
      "c1",
      expect.anything(),
      expect.anything(),
      { status: "active" },
    );
  });

  it("approving a connector whose required secret IS bound activates it", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: true,
      secretRef: "mcp:notion",
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    // hasSecret=true → expectSecretBound=true.
    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", true, {
      status: "active",
    });
  });

  it("approving a connector that needs no secret at all activates it", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", false, {
      status: "active",
    });
  });

  it("FAILS CLOSED on a missing/undefined requiresSecret — treats it as 'needs a secret'", async () => {
    // `requires_secret` is notNull().default(false), so undefined cannot come from
    // the DB. But `=== true` would read any malformed truthy value ("true", 1) as
    // "no secret needed" and ACTIVATE; `!== false` errs toward needs_credentials,
    // which is visible and recoverable rather than silently uncredentialed.
    const svc = makeSvc({ id: "c1", companyId: CO, status: "pending_approval" });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", false, {
      status: "needs_credentials",
    });
  });

  it.each([["true"], [1], ["1"]])(
    "FAILS CLOSED on a non-boolean truthy requiresSecret (%p) — does not activate",
    async (value) => {
      const svc = makeSvc({
        id: "c1",
        companyId: CO,
        status: "pending_approval",
        requiresSecret: value,
        secretRef: null,
      });

      await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

      expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalledWith(
        "c1",
        expect.anything(),
        expect.anything(),
        { status: "active" },
      );
    },
  );

  it("treats an empty-string secretRef as unbound (an empty ref resolves to no credential)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: true,
      secretRef: "",
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    // Empty-string secretRef → hasSecret=false → expectSecretBound=false.
    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", false, {
      status: "needs_credentials",
    });
  });

  it("re-approving an already-needs_credentials connector is a no-op (idempotent)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "needs_credentials",
      requiresSecret: true,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
  });

  it("re-approving an already-active connector is a no-op (idempotent)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "active",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
  });
});

describe("applyConnectorApproval — a founder-disabled connector is never resurrected", () => {
  // Reachable in `authenticated`: create → pending_approval + an approval row → the
  // founder PATCHes {status:"disabled"} (allowed; the C2 gate only blocks
  // *non*-disabled) → the board later approves the still-open approval. Without the
  // short-circuit the resolver answers `active` and a connector the founder switched
  // off starts being delivered to agents again.
  it("approving a disabled connector leaves it disabled — no write at all", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "disabled",
      requiresSecret: false,
      secretRef: "mcp:notion",
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
    expect(svc.update).not.toHaveBeenCalled();
  });

  it("holds even when the connector is fully credentialed (the disable is the later signal)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "disabled",
      requiresSecret: true,
      secretRef: "mcp:notion",
    });

    await applyConnectorApproval(svc as never, CO, "c1", "local_trusted");

    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
  });
});

describe("applyConnectorApproval — guarded write (TOCTOU)", () => {
  it("writes with the status AND secret-boundness it READ as the precondition, not a blind update", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    // The unguarded `update` must not be used — a blind write would clobber a
    // concurrent credential bind with this stale derivation. Finding 6: the guard
    // now also pins secret-boundness (expectSecretBound=false here).
    expect(svc.update).not.toHaveBeenCalled();
    expect(svc.updateIfStatusAndSecret).toHaveBeenCalledWith("c1", "pending_approval", false, {
      status: "active",
    });
  });

  it("a perpetually-lost race is absorbed silently (fail-closed) — bounded, never an unguarded write", async () => {
    // guardMatches=false and a fixed getById row means the guard can never
    // converge; Finding 6's bounded retry stops after a fixed cap and never falls
    // back to the unguarded `update`, so the connector is never forced active.
    const svc = makeSvc(
      {
        id: "c1",
        companyId: CO,
        status: "pending_approval",
        requiresSecret: false,
        secretRef: null,
      },
      /* guardMatches */ false,
    );

    await expect(
      applyConnectorApproval(svc as never, CO, "c1", "authenticated"),
    ).resolves.toBeUndefined();
    expect(svc.updateIfStatusAndSecret).toHaveBeenCalled();
    expect(svc.update).not.toHaveBeenCalled();
  });
});

describe("applyConnectorApproval — tenancy + null tolerance (never throw after the status flip)", () => {
  it("ignores a connector belonging to another company", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: "OTHER",
      status: "pending_approval",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorApproval(svc as never, CO, "c1", "authenticated");

    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
  });

  it("is a no-op and does NOT throw when the connector was deleted between create and approve", async () => {
    const svc = makeSvc(null);

    await expect(
      applyConnectorApproval(svc as never, CO, "c1", "authenticated"),
    ).resolves.toBeUndefined();
    expect(svc.updateIfStatusAndSecret).not.toHaveBeenCalled();
  });
});

describe("applyConnectorRejection — covers needs_credentials, not just pending_approval", () => {
  it("rejecting a needs_credentials connector disables it (was a silent no-op)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "needs_credentials",
      requiresSecret: true,
      secretRef: null,
    });

    await applyConnectorRejection(svc as never, CO, "c1");

    expect(svc.update).toHaveBeenCalledWith("c1", { status: "disabled" });
  });

  it("rejecting a pending_approval connector disables it (unchanged behaviour)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "pending_approval",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorRejection(svc as never, CO, "c1");

    expect(svc.update).toHaveBeenCalledWith("c1", { status: "disabled" });
  });

  it("does NOT disable an already-active connector (reject closes an install, it is not a kill switch)", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: CO,
      status: "active",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorRejection(svc as never, CO, "c1");

    expect(svc.update).not.toHaveBeenCalled();
  });

  it("ignores a connector belonging to another company", async () => {
    const svc = makeSvc({
      id: "c1",
      companyId: "OTHER",
      status: "pending_approval",
      requiresSecret: false,
      secretRef: null,
    });

    await applyConnectorRejection(svc as never, CO, "c1");

    expect(svc.update).not.toHaveBeenCalled();
  });

  it("is a no-op and does NOT throw when the connector is already gone", async () => {
    const svc = makeSvc(null);

    await expect(applyConnectorRejection(svc as never, CO, "c1")).resolves.toBeUndefined();
    expect(svc.updateIfStatus).not.toHaveBeenCalled();
  });
});
