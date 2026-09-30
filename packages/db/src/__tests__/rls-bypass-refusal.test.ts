// packages/db/src/__tests__/rls-bypass-refusal.test.ts — DAT-007 item #1, slice 3.
//
// The PURE half of the RLS precondition that gates arming AOA_DISTRIBUTED_EXECUTION_ENABLED:
// given the primary db role's pg_roles attributes, decide whether to refuse (the role must
// bypass RLS, or the currency resolver's FORCE-RLS'd leases/job_attempts reads return zero rows
// and deny every distributed run). Cross-platform: client.js is loaded via dynamic import (the
// non-owner-connection-contract.test.ts precedent) so the pure decision is testable without a DB.
import { beforeAll, describe, expect, it } from "vitest";

let rlsBypassRefusal: (
  attrs: { rolsuper?: boolean | null; rolbypassrls?: boolean | null } | null,
) => string | null;

beforeAll(async () => {
  ({ rlsBypassRefusal } = await import("../client.js"));
});

describe("rlsBypassRefusal — DAT-007 RLS precondition (pure)", () => {
  it("REFUSES when the role attributes could not be resolved (null)", () => {
    expect(rlsBypassRefusal(null)).toContain("could not resolve");
  });

  it("REFUSES a role that neither is superuser nor bypasses RLS", () => {
    const refusal = rlsBypassRefusal({ rolsuper: false, rolbypassrls: false });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("AOA_DISTRIBUTED_EXECUTION_ENABLED");
  });

  it("REFUSES when both attributes are absent/undefined", () => {
    expect(rlsBypassRefusal({})).not.toBeNull();
  });

  it("REFUSES when both attributes are null", () => {
    expect(rlsBypassRefusal({ rolsuper: null, rolbypassrls: null })).not.toBeNull();
  });

  it("ADMITS a superuser role (rolsuper) — bypasses FORCE RLS", () => {
    expect(rlsBypassRefusal({ rolsuper: true, rolbypassrls: false })).toBeNull();
  });

  it("ADMITS a BYPASSRLS role", () => {
    expect(rlsBypassRefusal({ rolsuper: false, rolbypassrls: true })).toBeNull();
  });

  it("ADMITS a role with both privileges", () => {
    expect(rlsBypassRefusal({ rolsuper: true, rolbypassrls: true })).toBeNull();
  });
});
