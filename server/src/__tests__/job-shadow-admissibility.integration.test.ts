// MIG-005/006/007 Lane B — the probe against a REAL database.
//
// The unit tests prove the decision logic against a fake `jobControl`. They cannot
// answer the question that actually decides whether this probe is usable:
//
//   running on the NON-OWNER `aoa_app` pool, inside a READ-ONLY tenant transaction,
//   can `admission` still SEE the Organization and Company?
//
// If RLS or a missing grant filtered those reads to zero rows, the probe would report
// `organization_missing` for every operation — a 100% "would have been refused" rate
// that is exactly as false as the 0% divergence rate this ticket removes, just in the
// other direction. That failure is invisible to a unit test with a fake repository.
//
// Gate: Linux CI automatically; Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import { probeDistributedAdmissibility } from "../services/job-shadow-admissibility.js";
import {
  COMPANY,
  ORG,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const RUN_INTEGRATION = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

const ONE_SHOT: SubmitJobSource = {
  kind: "one_shot",
  operationId: "a6000000-0000-4000-8000-0000000000aa",
  operationKind: "extraction",
};
// `system` is one of the requester kinds `one_shot` permits, and `admission` resolves it
// from the Organization→Company edge alone — no membership row needed, so the test
// exercises the read path without inventing fixture users.
const SYSTEM = { kind: "system", id: "a6000000-0000-4000-8000-0000000000bb" };

describe.skipIf(!RUN_INTEGRATION)("Lane B — the probe reads real rows through RLS", () => {
  let fixture: JobControlFixture;
  let setupError: unknown;

  beforeAll(async () => {
    try {
      fixture = await setupJobControlFixture("shadow-admissibility");
    } catch (error) {
      setupError = error;
    }
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 120_000);

  it("boots the fixture (fail closed)", () => {
    if (setupError) throw setupError;
    expect(fixture).toBeDefined();
  });

  it("admits a real Organization/Company — the reads are NOT filtered to zero", async () => {
    const verdict = await probeDistributedAdmissibility(fixture.app.db, {
      organizationId: ORG,
      companyId: COMPANY,
      source: ONE_SHOT,
      principal: SYSTEM,
    });
    expect(verdict).toEqual({
      admissible: true,
      reason: "admissible",
      authoritiesChecked: ["admission", "requester_kind"],
    });
  });

  it("refuses an Organization that does not exist", async () => {
    const verdict = await probeDistributedAdmissibility(fixture.app.db, {
      organizationId: "a6000000-0000-4000-8000-0000000000cc",
      companyId: COMPANY,
      source: ONE_SHOT,
      principal: SYSTEM,
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe("organization_missing");
  });

  it("refuses a Company outside the Organization", async () => {
    const verdict = await probeDistributedAdmissibility(fixture.app.db, {
      organizationId: ORG,
      companyId: "a6000000-0000-4000-8000-0000000000dd",
      source: ONE_SHOT,
      principal: SYSTEM,
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe("company_not_in_organization");
  });

  it("refuses a crew_run whose source authority finds nothing", async () => {
    // No crew run exists in the fixture, so the per-source authority must deny — and it
    // must reach that authority rather than stopping earlier.
    const verdict = await probeDistributedAdmissibility(fixture.app.db, {
      organizationId: ORG,
      companyId: COMPANY,
      // crew_run permits founder/team_lead/team_member/agent, not `system`, so present a
      // local_board principal, which `admission` maps to `founder` off the Company edge.
      source: { kind: "crew_run", crewRunId: "a6000000-0000-4000-8000-0000000000ee" },
      principal: { kind: "local_board", id: "a6000000-0000-4000-8000-0000000000bb" },
    });
    expect(verdict.reason).toBe("source_not_admitted");
    expect(verdict.authoritiesChecked).toEqual(["admission", "requester_kind", "source"]);
  });

  it("a blank Organization yields an undetermined verdict, never a yes", async () => {
    // `runInTenantReadOnly` throws before opening a transaction; the wrapper must convert
    // that into a recorded verdict rather than failing the live operation it observes.
    const verdict = await probeDistributedAdmissibility(fixture.app.db, {
      organizationId: "",
      companyId: COMPANY,
      source: ONE_SHOT,
      principal: SYSTEM,
    });
    expect(verdict).toEqual({ admissible: null, reason: "probe_error", authoritiesChecked: [] });
  });
});
