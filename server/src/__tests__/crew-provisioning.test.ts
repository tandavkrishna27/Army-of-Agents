/**
 * T2.3 — L2 coverage for the company-create crew provisioning decision.
 *
 * The integration suite proves the happy path against a real DB. This suite
 * pins the two things that only show up when things go WRONG, and that a
 * green happy path would happily hide:
 *
 *   1. A marketplace failure degrades to the legacy seeders instead of
 *      breaking company creation.
 *   2. The degrade log NAMES the crew members the legacy seeders cannot
 *      provide. There is no `ensure-reviewer.ts` anywhere in the tree while
 *      `team:aoa-curated/default-crew` requires `agent:aoa-curated/aoa-reviewer`
 *      — so a degraded company is permanently missing its Reviewer with
 *      nothing in the data to distinguish it from a complete roster. A generic
 *      "install failed, using legacy seeders" line is not enough to diagnose
 *      that later, so the naming is asserted, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bootstrapMock, ensureCrewAgentsMock, inspectWitnessMock, updateOperationMock, loggerErrorMock, loggerInfoMock } =
  vi.hoisted(() => ({
    bootstrapMock: vi.fn(),
    ensureCrewAgentsMock: vi.fn(async () => {}),
    inspectWitnessMock: vi.fn(async () => ({ state: "absent" as const })),
    updateOperationMock: vi.fn(async () => {}),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
  }));

vi.mock("../services/marketplace-install/crew-bootstrap.js", () => ({
  DEFAULT_CREW_TEAM_ITEM_ID: "team:aoa-curated/default-crew",
  bootstrapCrewFromMarketplace: bootstrapMock,
  inspectCrewTeamInstall: inspectWitnessMock,
}));
vi.mock("../services/marketplace-install/operation-store.js", () => ({
  updateOperation: updateOperationMock,
}));
vi.mock("../services/internal-agent/aoa-agents/crew-seeding.js", () => ({
  ensureCrewAgents: ensureCrewAgentsMock,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: loggerInfoMock, debug: vi.fn() },
}));

import {
  LEGACY_CREW_SEEDER_COVERAGE,
  describeLegacyCoverageGap,
  provisionCompanyCrew,
} from "../services/crew-provisioning.js";

const DB = {} as never;

function catalogWithTeam(requiredAgentIds: string[]) {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    itemCount: 1,
    items: [
      {
        id: "team:aoa-curated/default-crew",
        type: "team",
        name: "AoA Default Crew",
        requires: [
          ...requiredAgentIds.map((id) => ({ type: "agent", id })),
          { type: "skill", id: "skill:whatever/thing" },
        ],
      },
    ],
  } as never;
}

function lastErrorLog() {
  const call = loggerErrorMock.mock.calls.at(-1);
  return { context: call?.[0] as Record<string, unknown>, message: String(call?.[1] ?? "") };
}

beforeEach(() => {
  bootstrapMock.mockReset();
  ensureCrewAgentsMock.mockClear();
  inspectWitnessMock.mockReset();
  inspectWitnessMock.mockResolvedValue({ state: "absent" });
  updateOperationMock.mockReset();
  updateOperationMock.mockResolvedValue(undefined);
  loggerErrorMock.mockClear();
  loggerInfoMock.mockClear();
});

describe("describeLegacyCoverageGap", () => {
  it("names the required crew agents that have NO legacy seeder (from the live catalog)", () => {
    const gap = describeLegacyCoverageGap(
      catalogWithTeam([
        "agent:aoa-curated/aoa-scout",
        "agent:aoa-curated/aoa-reviewer",
        "agent:aoa-curated/aoa-librarian",
        "agent:aoa-curated/aoa-steward",
      ]),
    );
    expect(gap.source).toBe("catalog");
    expect(gap.itemIds).toEqual(["agent:aoa-curated/aoa-reviewer"]);
  });

  // Discriminator: an UNKNOWN roster member must be reported as uncovered.
  // A map lookup that defaulted to "covered" would report a clean gap for a
  // brand-new crew member that no seeder has ever heard of.
  it("treats an unlisted catalog agent as uncovered (fail loud, not silent)", () => {
    const gap = describeLegacyCoverageGap(
      catalogWithTeam(["agent:aoa-curated/aoa-scout", "agent:aoa-curated/aoa-quartermaster"]),
    );
    expect(gap.itemIds).toEqual(["agent:aoa-curated/aoa-quartermaster"]);
  });

  // The common degrade cause is "no catalog at all", so the gap still has to
  // be answerable without one — flagged as last-known so a reader knows it may
  // have drifted.
  it("falls back to the last-known roster when no catalog is available", () => {
    const gap = describeLegacyCoverageGap(null);
    expect(gap.source).toBe("last-known");
    expect(gap.itemIds).toEqual(["agent:aoa-curated/aoa-reviewer"]);
  });

  it("the static coverage map records Reviewer as missing and Steward as covered", () => {
    expect(LEGACY_CREW_SEEDER_COVERAGE["agent:aoa-curated/aoa-reviewer"]).toBeNull();
    expect(LEGACY_CREW_SEEDER_COVERAGE["agent:aoa-curated/aoa-steward"]).toBe("ensureSteward");
    // Everything else the team declares must map to a real seeder function name.
    for (const [id, seeder] of Object.entries(LEGACY_CREW_SEEDER_COVERAGE)) {
      if (id === "agent:aoa-curated/aoa-reviewer") continue;
      expect(seeder, `${id} should map to a seeder`).toMatch(/^ensure/);
    }
  });
});

describe("provisionCompanyCrew", () => {
  it("marketplace install succeeds → legacy seeders are NOT run", async () => {
    bootstrapMock.mockResolvedValue({
      status: "installed",
      teamId: "team-1",
      operationId: "op-1",
      catalogSource: "cache",
    });

    const outcome = await provisionCompanyCrew(DB, "co-1");

    expect(outcome).toEqual({ mode: "marketplace", operationId: "op-1", teamId: "team-1" });
    // The discriminator for the whole task: legacy seeding is what stamps
    // `…@legacy` and freezes the company out of the update pipeline.
    expect(ensureCrewAgentsMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("install failure → company still gets a crew via the legacy seeders", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "Failed to fetch team template: HTTP 503",
      operationId: "op-2",
      catalog: catalogWithTeam(["agent:aoa-curated/aoa-scout", "agent:aoa-curated/aoa-reviewer"]),
    });

    const outcome = await provisionCompanyCrew(DB, "co-2");

    expect(outcome.mode).toBe("legacy");
    expect(ensureCrewAgentsMock).toHaveBeenCalledWith(DB, "co-2");
  });

  it("the degrade log NAMES the crew members the legacy seeders cannot provide", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "Failed to fetch team template: HTTP 503",
      operationId: "op-3",
      catalog: catalogWithTeam(["agent:aoa-curated/aoa-scout", "agent:aoa-curated/aoa-reviewer"]),
    });

    await provisionCompanyCrew(DB, "co-3");

    const { context, message } = lastErrorLog();
    // Named in the human-readable line...
    expect(message).toContain("agent:aoa-curated/aoa-reviewer");
    expect(message).toMatch(/MISSING/);
    // ...and machine-readable in the structured context.
    expect(context.unprovidedItemIds).toEqual(["agent:aoa-curated/aoa-reviewer"]);
    expect(context.companyId).toBe("co-3");
    expect(String(context.degradeReason)).toContain("HTTP 503");
  });

  it("no catalog at all → still degrades, still names the known gap", async () => {
    bootstrapMock.mockResolvedValue({
      status: "unavailable",
      reason: "no-catalog",
      detail: "sync-unavailable",
      catalog: null,
    });

    const outcome = await provisionCompanyCrew(DB, "co-4");

    expect(outcome).toEqual({
      mode: "legacy",
      reason: "no-catalog:sync-unavailable",
      unprovidedItemIds: ["agent:aoa-curated/aoa-reviewer"],
    });
    const { context, message } = lastErrorLog();
    expect(message).toContain("agent:aoa-curated/aoa-reviewer");
    expect(context.unprovidedSource).toBe("last-known");
  });

  // R7: a missing registry is a WIRING regression, not an outage. If both
  // collapse to the same `degradeReason` the log cannot tell them apart, and a
  // regression that silently un-marketplaces every new company reads like a
  // flaky CDN.
  it("keeps the catalog-unavailability cause distinguishable in the degrade reason", async () => {
    bootstrapMock.mockResolvedValue({
      status: "unavailable",
      reason: "no-catalog",
      detail: "no-service-registered",
      catalog: null,
    });

    const outcome = await provisionCompanyCrew(DB, "co-4b");

    expect(outcome).toMatchObject({ mode: "legacy", reason: "no-catalog:no-service-registered" });
    expect(lastErrorLog().context.degradeReason).toBe("no-catalog:no-service-registered");
  });

  // The bootstrap's docblock promises it never throws. Docblocks go stale;
  // company creation must not.
  it("a throwing bootstrap still yields a crew (create is never broken)", async () => {
    bootstrapMock.mockRejectedValue(new Error("boom"));

    const outcome = await provisionCompanyCrew(DB, "co-5");

    expect(outcome.mode).toBe("legacy");
    expect(ensureCrewAgentsMock).toHaveBeenCalledWith(DB, "co-5");
    expect(lastErrorLog().message).toContain("boom");
  });

  // ── R1: a SUCCESSFUL install whose bookkeeping failed ────────────────────
  // dispatchInstall can commit the team-body txn, write `success`, and then
  // throw (success DB write, or a throwing live-event subscriber), landing in
  // its own catch which overwrites the terminal patch with `failure`. Seeding
  // on top of that committed roster silently overwrites the marketplace rows'
  // runtimeConfig/adapter while leaving templateOrigin intact —
  // permanently, and invisibly, beyond crew-updater's reach.
  it("does NOT seed over a crew that is actually installed, despite a `failed` result", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "live-event subscriber threw after the install committed",
      operationId: "op-7",
      catalog: catalogWithTeam(["agent:aoa-curated/aoa-scout"]),
    });
    inspectWitnessMock.mockResolvedValue({ state: "installed", teamId: "team-installed-1" });

    const outcome = await provisionCompanyCrew(DB, "co-7");

    expect(outcome).toEqual({
      mode: "marketplace-clobber-averted",
      reason: "install failed: live-event subscriber threw after the install committed",
      operationRepaired: true,
    });
    expect(ensureCrewAgentsMock).not.toHaveBeenCalled();
    expect(lastErrorLog().message).toMatch(/crew team IS installed/);

    // F1: the lying `failure` row must be REPAIRED, not merely tolerated.
    // Left as `failure` it stays CLAIMABLE, so the next provisioning pass
    // (T2.3b repair) re-installs over the existing roster.
    expect(updateOperationMock).toHaveBeenCalledWith(DB, "op-7", {
      status: "success",
      resultEntityId: "team-installed-1",
      errorMessage: null,
      completedAt: expect.any(Date),
    });
  });

  // F6: "we could not read the witness" is not "the install committed".
  it("an unreadable witness fails closed WITHOUT claiming the install succeeded", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "Failed to fetch team template: HTTP 503",
      operationId: "op-10",
      catalog: null,
    });
    inspectWitnessMock.mockResolvedValue({ state: "unknown", error: new Error("db down") });

    const outcome = await provisionCompanyCrew(DB, "co-10");

    expect(outcome.mode).toBe("unknown-skipped-seeding");
    expect(ensureCrewAgentsMock).not.toHaveBeenCalled();
    // Must NOT repair a row it cannot justify repairing.
    expect(updateOperationMock).not.toHaveBeenCalled();
    const { message } = lastErrorLog();
    expect(message).toMatch(/cannot tell whether a crew exists/);
    expect(message).not.toMatch(/the install committed/);
  });

  // F6: the averted path used to emit the big "will be stamped @legacy" ERROR
  // and then not degrade — two contradictory ERROR lines back to back.
  it("does not log the DEGRADED line when it did not degrade", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "boom",
      operationId: "op-11",
      catalog: null,
    });
    inspectWitnessMock.mockResolvedValue({ state: "installed", teamId: "team-11" });

    await provisionCompanyCrew(DB, "co-11");

    const messages = loggerErrorMock.mock.calls.map((c) => String(c[1] ?? ""));
    expect(messages.some((m) => m.includes("DEGRADED to the legacy seeders"))).toBe(false);
  });

  // Discriminator for the guard: it must not become a blanket skip. A genuine
  // failure on a company that is NOT marketplace-managed still has to seed, or
  // the fix would trade a silent clobber for a silent crewless company.
  it("still seeds when the company is genuinely NOT marketplace-managed", async () => {
    bootstrapMock.mockResolvedValue({
      status: "failed",
      reason: "Failed to fetch team template: HTTP 503",
      operationId: "op-8",
      catalog: catalogWithTeam(["agent:aoa-curated/aoa-scout"]),
    });
    inspectWitnessMock.mockResolvedValue({ state: "absent" });

    const outcome = await provisionCompanyCrew(DB, "co-8");

    expect(outcome.mode).toBe("legacy");
    expect(ensureCrewAgentsMock).toHaveBeenCalledWith(DB, "co-8");
  });

  // The gate must be the LAST thing before the write, not a cached read from
  // earlier: the install commits during the bootstrap call.
  it("re-reads the marketplace gate AFTER the bootstrap, not before", async () => {
    const order: string[] = [];
    bootstrapMock.mockImplementation(async () => {
      order.push("bootstrap");
      return { status: "failed", reason: "boom", operationId: "op-9", catalog: null };
    });
    inspectWitnessMock.mockImplementation(async () => {
      order.push("gate");
      return { state: "installed", teamId: "team-installed-1" };
    });

    await provisionCompanyCrew(DB, "co-9");

    expect(order).toEqual(["bootstrap", "gate"]);
  });

  // Idempotency: a concurrent/retried create finds the existing operation and
  // must NOT fall through to the legacy seeders — that would stamp `@legacy`
  // rows on top of an already-marketplace-managed company.
  it("an already-dispatched bootstrap does not fall back to the legacy seeders", async () => {
    bootstrapMock.mockResolvedValue({
      status: "already-dispatched",
      operationId: "op-6",
      operationStatus: "success",
    });

    const outcome = await provisionCompanyCrew(DB, "co-6");

    expect(outcome).toEqual({ mode: "marketplace-already-dispatched", operationId: "op-6" });
    expect(ensureCrewAgentsMock).not.toHaveBeenCalled();
  });
});
