import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const heartbeatSource = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);
const orgConcurrencySource = readFileSync(
  fileURLToPath(new URL("../services/org-concurrency.ts", import.meta.url)),
  "utf8",
);

describe("cloud org-concurrency claim wiring", () => {
  it("threads Company -> Organization into execution-target routing without enabling org-default credentials", () => {
    const providerResolutionIndex = heartbeatSource.indexOf("const hbResolved = await resolveProviderCredential(");
    const executionTargetOrgIndex = heartbeatSource.indexOf(
      "resolveHeartbeatExecutionTargetOrganizationId(db",
      providerResolutionIndex,
    );
    const targetRoutingIndex = heartbeatSource.indexOf("resolveExecutionTargetForRun(db", executionTargetOrgIndex);
    const providerResolution = heartbeatSource.slice(providerResolutionIndex, executionTargetOrgIndex);
    const targetRouting = heartbeatSource.slice(executionTargetOrgIndex, targetRoutingIndex + 500);

    expect(providerResolutionIndex).toBeGreaterThan(-1);
    expect(executionTargetOrgIndex).toBeGreaterThan(providerResolutionIndex);
    expect(targetRoutingIndex).toBeGreaterThan(executionTargetOrgIndex);
    expect(providerResolution).toContain("organizationId: null");
    expect(targetRouting).toContain("organizationId: executionTargetOrganizationId");
    expect(targetRouting).toContain("tenantIsolationEnforced: tenantIsolationEnforced()");
  });

  it("resolves Company -> Organization and uses the atomic helper only in cloud mode", () => {
    const singleAgentFunction = heartbeatSource.slice(
      heartbeatSource.indexOf("async function startQueuedRunsForSingleAgent"),
      heartbeatSource.indexOf("async function dispatchQueuedRunsAfterAgentSignal"),
    );
    const organizationFunction = heartbeatSource.slice(
      heartbeatSource.indexOf("async function dispatchQueuedRunsAfterAgentSignal"),
      heartbeatSource.indexOf("async function getLatestRunForSession"),
    );
    expect(singleAgentFunction).toContain("resolveCompanyOrganizationId(db, agent.companyId)");
    expect(singleAgentFunction).toContain("claimQueuedRunsWithOrgCapacity(db");
    expect(organizationFunction).toContain("if (!tenantIsolationEnforced())");
    expect(organizationFunction).toContain("startQueuedRunsForSingleAgent(agentId, organizationId)");
    expect(organizationFunction).not.toContain("dispatchQueuedAgentsForOrg(");
    expect(singleAgentFunction).not.toContain("agent as { organizationId?: string | null }");
  });

  it("takes the transaction-scoped org lock before counting and claiming", () => {
    const txIndex = orgConcurrencySource.indexOf("return db.transaction(async (tx)");
    const lockIndex = orgConcurrencySource.indexOf("pg_advisory_xact_lock");
    const orgCountIndex = orgConcurrencySource.indexOf("const orgRunning");
    const globalOrderIndex = orgConcurrencySource.indexOf(
      ".orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))",
    );
    const claimIndex = orgConcurrencySource.indexOf(".update(heartbeatRuns)");
    expect(txIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(txIndex);
    expect(orgCountIndex).toBeGreaterThan(lockIndex);
    expect(globalOrderIndex).toBeGreaterThan(orgCountIndex);
    expect(claimIndex).toBeGreaterThan(globalOrderIndex);
  });

  it("runs failure-isolated claim mirrors only after the atomic helper resolves", () => {
    const claimIndex = heartbeatSource.indexOf("await claimQueuedRunsWithOrgCapacity(db");
    const publishIndex = heartbeatSource.indexOf("await runClaimMirrorsBestEffort(", claimIndex);
    expect(claimIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(claimIndex);
  });
});
