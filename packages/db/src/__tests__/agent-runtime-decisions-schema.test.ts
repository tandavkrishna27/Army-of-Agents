import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentRuntimeDecisions, agentRuntimeTrustRules } from "../schema/agent_runtime_decisions.js";

describe("agent_runtime_decisions schema", () => {
  it("has a (status, expires_at) index for the global timeout sweep", () => {
    const cfg = getTableConfig(agentRuntimeDecisions);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain("agent_runtime_decisions_status_expiry_idx");
  });
});

// ★★★ BRW-004 (E8-F002) — THE TENTH NULL-HAZARD, pinned where it is cheapest to check.
//
// The two tables are declared one after the other and have the SAME two nullable FK columns, so
// the natural mistake is to give them the same invariant. They must not have the same one, and
// this pair of tests says so out loud:
//
//   * a DECISION is all-or-nothing — both bindings or neither;
//   * a TRUST RULE is always agent-bound — `run_id` null just means "persistent".
//
// Copying the decision's CHECK onto the trust rule would reject every persistent grant the
// product has ever written. Dropping the trust rule's NOT NULL re-opens a company-wide wildcard
// grant reachable from browser egress. Nothing else in CI compares the schema to migration 0273,
// so without this a revert of the `.notNull()` would be silent.
describe("agent_runtime_trust_rules schema — the standing grant is always agent-bound", () => {
  const columns = () => getTableConfig(agentRuntimeTrustRules).columns;
  const column = (name: string) => {
    const found = columns().find((c) => c.name === name);
    expect(found, `column ${name} must exist`).toBeTruthy();
    return found!;
  };

  it("agent_id is NOT NULL — an unbound rule is a company-wide wildcard, so it must be unrepresentable", () => {
    expect(column("agent_id").notNull).toBe(true);
  });

  it("run_id stays NULLABLE — a persistent grant is agent-bound and run-less BY DESIGN", () => {
    // The positive control for the line above. A fix that narrowed both columns would pass the
    // first test and break every `allow_always` answer the product writes.
    expect(column("run_id").notNull).toBe(false);
  });

  it("the trust rule does NOT carry the decision's all-or-nothing CHECK", () => {
    // Guards against the tempting symmetric fix. `(agent_id IS NULL) = (run_id IS NULL)` is right
    // for the sibling and wrong here.
    const names = getTableConfig(agentRuntimeTrustRules).checks.map((c) => c.name);
    expect(names).not.toContain("agent_runtime_decisions_legacy_binding_all_or_nothing");
  });

  it("the DECISION table still carries it — the two invariants are different, not absent", () => {
    const names = getTableConfig(agentRuntimeDecisions).checks.map((c) => c.name);
    expect(names).toContain("agent_runtime_decisions_legacy_binding_all_or_nothing");
  });
});
