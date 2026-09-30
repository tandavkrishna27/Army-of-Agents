/**
 * Locks the warm-reuse columns added to `environment_leases` in Wave 6 (U7.1).
 *
 * `agentId` + `pausedAt` let the acquire path find an agent's paused sandbox
 * on its next run; the `paused` status keeps `releasedAt` NULL (distinct from
 * the pre-existing `retained`) so the lookup/reaper indexes can find it, and
 * `reuse_by_agent` is the lease policy warm acquires are stamped with.
 */

import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ENVIRONMENT_LEASE_POLICIES, ENVIRONMENT_LEASE_STATUSES } from "@armyofagents/shared";
import { environmentLeases } from "../schema/environment_leases.js";

describe("environment_leases schema", () => {
  it("carries warm-reuse columns", () => {
    expect(environmentLeases.agentId).toBeDefined();
    expect(environmentLeases.pausedAt).toBeDefined();
  });

  it("has a paused status and reuse_by_agent policy", () => {
    expect(ENVIRONMENT_LEASE_STATUSES).toContain("paused");
    expect(ENVIRONMENT_LEASE_POLICIES).toContain("reuse_by_agent");
  });

  it("indexes the warm lookup (company, agent, environment, status) and the paused reaper scan (status, pausedAt)", () => {
    const cfg = getTableConfig(environmentLeases);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain("environment_leases_company_agent_environment_status_idx");
    expect(names).toContain("environment_leases_paused_reaper_idx");
  });
});
