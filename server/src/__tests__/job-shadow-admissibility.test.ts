import { describe, expect, it, vi } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import type { TenantRepositories } from "@armyofagents/db";
import {
  SOURCES_WITHOUT_SOURCE_AUTHORITY,
  evaluateAdmissibility,
  type AdmissibilityVerdict,
} from "../services/job-shadow-admissibility.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = { kind: "user", id: "u-1", role: "founder" };

const COMMANDER: SubmitJobSource = {
  kind: "commander_turn",
  internalAgentRunId: "run-1",
  conversationId: "conv-1",
};
const CREW: SubmitJobSource = { kind: "crew_run", crewRunId: "crew-1" };
const ONE_SHOT: SubmitJobSource = {
  kind: "one_shot",
  operationId: "op-1",
  operationKind: "extraction",
};
const TASK: SubmitJobSource = {
  kind: "task_run",
  runId: "r-1",
  issueId: "i-1",
  assigneeAgentId: "a-1",
};

const ADMITTED = {
  organizationExists: true,
  companyInOrganization: true,
  principalAuthorized: true,
  requester: { kind: "founder", id: "u-1" },
};

/** A fake `jobControl` exposing only what the probe touches. */
function repos(overrides: Record<string, unknown> = {}): Pick<TenantRepositories, "jobControl"> {
  const jobControl = {
    admission: vi.fn(async () => ADMITTED),
    taskSourceIsAdmitted: vi.fn(async () => ({ kind: "agent", id: "a-1" })),
    commanderSourceIsAdmitted: vi.fn(async () => ({ kind: "user", id: "u-1" })),
    internalRunSourceIsAdmitted: vi.fn(async () => ({ kind: "agent", id: "a-1" })),
    serviceSourceIsAdmitted: vi.fn(async () => ({ kind: "system", id: "s-1" })),
    ...overrides,
  };
  return { jobControl } as unknown as Pick<TenantRepositories, "jobControl">;
}

// `one_shot` admits only agent/system/commander requesters — a founder is correctly
// refused at the requester-kind gate, so a one_shot probe must present a permitted
// requester or it never reaches the question being asked.
const SYSTEM_ADMITTED = { ...ADMITTED, requester: { kind: "system", id: "sys-1" } };

const probe = (source: SubmitJobSource, r?: Pick<TenantRepositories, "jobControl">) =>
  evaluateAdmissibility(
    r ?? (source.kind === "one_shot" ? repos({ admission: vi.fn(async () => SYSTEM_ADMITTED) }) : repos()),
    { organizationId: ORG, companyId: COMPANY, source, principal: PRINCIPAL },
  ) as Promise<AdmissibilityVerdict>;

describe("the probe answers the question a shadow pass can actually answer", () => {
  it("admits a well-formed commander turn", async () => {
    const verdict = await probe(COMMANDER);
    expect(verdict).toEqual({
      admissible: true,
      reason: "admissible",
      authoritiesChecked: ["admission", "requester_kind", "source"],
    });
  });

  it.each([
    ["organizationExists", "organization_missing"],
    ["companyInOrganization", "company_not_in_organization"],
    ["principalAuthorized", "principal_unauthorized"],
  ] as const)("refuses when %s is false, with its own reason", async (field, reason) => {
    const verdict = await probe(
      COMMANDER,
      repos({ admission: vi.fn(async () => ({ ...ADMITTED, [field]: false })) }),
    );
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe(reason);
    // The later authorities did NOT run, and must not be claimed.
    expect(verdict.authoritiesChecked).toEqual(["admission"]);
  });

  it("refuses a requester kind the source does not permit", async () => {
    // `service_reconcile` admits only `system`; a founder must be refused.
    const verdict = await probe({
      kind: "service_reconcile",
      serviceId: "s-1",
      generation: 1,
      reconciliationId: "rec-1",
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe("requester_kind_not_permitted");
    expect(verdict.authoritiesChecked).toEqual(["admission", "requester_kind"]);
  });

  it.each([
    ["commander_turn", COMMANDER, "commanderSourceIsAdmitted"],
    ["crew_run", CREW, "internalRunSourceIsAdmitted"],
    ["task_run", TASK, "taskSourceIsAdmitted"],
  ] as const)("records a %s the source authority refuses as a divergence, not an error", async (
    _kind,
    source,
    method,
  ) => {
    const verdict = await probe(source, repos({ [method]: vi.fn(async () => null) }));
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe("source_not_admitted");
    expect(verdict.authoritiesChecked).toContain("source");
  });
});

// ─── S11 ─────────────────────────────────────────────────────────────────────
// The finding the plan review caught. `submitJobWithinTenant` gives `one_shot` a
// CONSTANT execution principal with no lookup, so nothing about a one-shot operation
// itself can be refused. Reporting "0 divergences across three sinks" without saying
// so would reproduce this ticket's own tautology one level down.
describe("S11 — the three sinks do not have equal signal, and the record says so", () => {
  it("checks no source authority for one_shot", async () => {
    const verdict = await probe(ONE_SHOT);
    expect(verdict.admissible).toBe(true);
    expect(verdict.authoritiesChecked).toEqual(["admission", "requester_kind"]);
    expect(verdict.authoritiesChecked).not.toContain("source");
  });

  it("still checks a source authority for the other two MIG sinks", async () => {
    expect((await probe(COMMANDER)).authoritiesChecked).toContain("source");
    expect((await probe(CREW)).authoritiesChecked).toContain("source");
  });

  it("one_shot cannot be refused by a source authority even when every authority says no", async () => {
    // Every per-source check stubbed to refuse. commander/crew are refused; one_shot is
    // NOT — that asymmetry is the fact the evidence has to state.
    const refuseAll = repos({
      taskSourceIsAdmitted: vi.fn(async () => null),
      commanderSourceIsAdmitted: vi.fn(async () => null),
      internalRunSourceIsAdmitted: vi.fn(async () => null),
      serviceSourceIsAdmitted: vi.fn(async () => null),
    });
    expect((await probe(COMMANDER, refuseAll)).admissible).toBe(false);
    expect((await probe(CREW, refuseAll)).admissible).toBe(false);
    const oneShotRefuseAll = repos({
      admission: vi.fn(async () => SYSTEM_ADMITTED),
      taskSourceIsAdmitted: vi.fn(async () => null),
      commanderSourceIsAdmitted: vi.fn(async () => null),
      internalRunSourceIsAdmitted: vi.fn(async () => null),
      serviceSourceIsAdmitted: vi.fn(async () => null),
    });
    expect((await probe(ONE_SHOT, oneShotRefuseAll)).admissible).toBe(true);
  });

  it("still refuses a one_shot from a requester kind it does not permit", () => {
    // one_shot's signal is not zero — admission and the requester-kind gate still apply.
    // It is specifically the PER-SOURCE authority that is absent.
    return probe(ONE_SHOT, repos()).then((verdict) => {
      expect(verdict.admissible).toBe(false);
      expect(verdict.reason).toBe("requester_kind_not_permitted");
    });
  });

  it("names one_shot in the exported list, so the evidence cannot silently omit it", () => {
    expect(SOURCES_WITHOUT_SOURCE_AUTHORITY).toContain("one_shot");
    expect(SOURCES_WITHOUT_SOURCE_AUTHORITY).not.toContain("commander_turn");
    expect(SOURCES_WITHOUT_SOURCE_AUTHORITY).not.toContain("crew_run");
  });
});

describe("the probe is best-effort on a live path", () => {
  it("a throwing authority yields an undetermined verdict, never a yes", async () => {
    // `evaluateAdmissibility` itself propagates (the wrapper catches), so assert the
    // shape the wrapper turns it into: never `admissible: true`.
    await expect(
      probe(
        COMMANDER,
        repos({
          admission: vi.fn(async () => {
            throw new Error("database blip");
          }),
        }),
      ),
    ).rejects.toThrow(/database blip/);
  });
});
