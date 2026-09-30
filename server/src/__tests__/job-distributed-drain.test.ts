import { describe, expect, it, vi } from "vitest";
import {
  createDistributedExecutionDrain,
  type DistributedExecutionActiveAttempt,
} from "../services/job-distributed-drain.js";

// MIG-009 rework: the drain now asserts rollback-safety PER COMPANY. Every dep object
// gains `listOrganizationCompanyIds` and `assertRollbackSafe` is keyed on a COMPANY id
// (was an ORG id). An Organization holds MANY Companies, so an org-keyed rollback gate
// was an interface lie — a pending authoritative-cost receipt on a SIBLING Company would
// be missed (fail-open) or, against the real bridges, every org would throw at
// Company→Org resolution and drain nothing (fail-closed). See job-distributed-drain.ts.

const ORG_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_B = "bbbbbbbb-2222-4222-8222-222222222222";
// Two Companies under ORG_A, one under ORG_B.
const CO_A1 = "c1c1c1c1-1111-4111-8111-a11111111111";
const CO_A2 = "c2c2c2c2-2222-4222-8222-a22222222222";
const CO_B1 = "c3c3c3c3-3333-4333-8333-b11111111111";

function attempt(
  organizationId: string,
  companyId: string,
  jobId: string,
): DistributedExecutionActiveAttempt {
  return { organizationId, companyId, jobId };
}

/** A `queued` cancellation outcome (the common "drained" result). */
const queued = () => ({ status: "queued" as const, command: null });

describe("MIG-009 flag-disable drain (per-Company rollback gate → requestCancellation)", () => {
  it("POSITIVE CONTROL: a clean org drains every non-terminal attempt (assertRollbackSafe no-op)", async () => {
    const orgsPages = [[ORG_A, ORG_B], []];
    const listAdmittedOrganizationIds = vi.fn(async () => orgsPages.shift() ?? []);
    const companiesByOrg: Record<string, string[]> = {
      [ORG_A]: [CO_A1, CO_A2],
      [ORG_B]: [CO_B1],
    };
    const listOrganizationCompanyIds = vi.fn(async (organizationId: string) => companiesByOrg[organizationId] ?? []);
    const attemptsByOrg: Record<string, DistributedExecutionActiveAttempt[]> = {
      [ORG_A]: [attempt(ORG_A, CO_A1, "job-a1"), attempt(ORG_A, CO_A2, "job-a2")],
      [ORG_B]: [attempt(ORG_B, CO_B1, "job-b1")],
    };
    const listActiveAttempts = vi.fn(async (organizationId: string) => attemptsByOrg[organizationId] ?? []);
    const requestCancellation = vi.fn(async () => queued());
    const assertRollbackSafe = vi.fn(async () => {});

    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds,
      listOrganizationCompanyIds,
      listActiveAttempts,
      requestCancellation,
      assertRollbackSafe,
    });
    const result = await drain.drainAll();

    expect(requestCancellation).toHaveBeenCalledTimes(3);
    for (const call of requestCancellation.mock.calls) {
      expect(call[0].graceful).toBe(true);
      expect(typeof call[0].reason).toBe("string");
      expect(call[0].jobId).toBeTruthy();
    }
    expect(result.cancelled).toBe(3);
    expect(result.organizationsScanned).toBe(2);
    expect(result.skippedOrganizations).toEqual([]);
  });

  it("skips the WHOLE org when a SIBLING Company has a pending receipt (assertRollbackSafe throws for CO_A2)", async () => {
    const orgsPages = [[ORG_A, ORG_B], []];
    const listAdmittedOrganizationIds = vi.fn(async () => orgsPages.shift() ?? []);
    const listOrganizationCompanyIds = vi.fn(async (organizationId: string) =>
      organizationId === ORG_A ? [CO_A1, CO_A2] : [CO_B1],
    );
    const listActiveAttempts = vi.fn(async (organizationId: string) =>
      organizationId === ORG_A
        ? [attempt(ORG_A, CO_A1, "job-a1"), attempt(ORG_A, CO_A2, "job-a2")]
        : [attempt(ORG_B, CO_B1, "job-b1")],
    );
    const requestCancellation = vi.fn(async () => queued());
    // The pending receipt is on the SIBLING Company CO_A2 — NOT the first Company CO_A1.
    // An "only check the first Company" bug (M-sibling) would MISS this and drain unsafely.
    const assertRollbackSafe = vi.fn(async (companyId: string) => {
      if (companyId === CO_A2) throw new Error("authoritative cost receipt pending");
    });

    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds,
      listOrganizationCompanyIds,
      listActiveAttempts,
      requestCancellation,
      assertRollbackSafe,
    });
    const result = await drain.drainAll();

    // ORG_A refused whole → no attempt enumeration + no cancellation for it.
    expect(listActiveAttempts).not.toHaveBeenCalledWith(ORG_A);
    expect(requestCancellation).toHaveBeenCalledTimes(1);
    expect(requestCancellation.mock.calls[0]![0].organizationId).toBe(ORG_B);
    expect(result.skippedOrganizations).toEqual([ORG_A]);
    expect(result.perOrganization).toContainEqual({
      organizationId: ORG_A,
      skipped: true,
      reason: "rollback_pending",
      cancelled: 0,
    });
    expect(result.cancelled).toBe(1);
  });

  it("asserts rollback-safety for EVERY Company under the org, in order (a clean org)", async () => {
    const orgsPages = [[ORG_A], []];
    const assertRollbackSafe = vi.fn(async () => {});
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds: vi.fn(async () => orgsPages.shift() ?? []),
      listOrganizationCompanyIds: vi.fn(async () => [CO_A1, CO_A2]),
      listActiveAttempts: vi.fn(async () => [attempt(ORG_A, CO_A1, "job-a1")]),
      requestCancellation: vi.fn(async () => queued()),
      assertRollbackSafe,
    });
    await drain.drainAll();
    // Called once per Company (never with an org id).
    expect(assertRollbackSafe.mock.calls.map((c) => c[0])).toEqual([CO_A1, CO_A2]);
  });

  it("FAILS CLOSED when the Company set cannot be read (listOrganizationCompanyIds throws → skip, never drain)", async () => {
    const orgsPages = [[ORG_A, ORG_B], []];
    const listActiveAttempts = vi.fn(async (organizationId: string) => [attempt(organizationId, CO_B1, `job-${organizationId}`)]);
    const requestCancellation = vi.fn(async () => queued());
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds: vi.fn(async () => orgsPages.shift() ?? []),
      listOrganizationCompanyIds: vi.fn(async (organizationId: string) => {
        if (organizationId === ORG_A) throw new Error("companies read failed");
        return [CO_B1];
      }),
      listActiveAttempts,
      requestCancellation,
      assertRollbackSafe: vi.fn(async () => {}),
    });
    const result = await drain.drainAll();

    // ORG_A's Company set was unreadable → the org is skipped, NEVER drained.
    expect(listActiveAttempts).not.toHaveBeenCalledWith(ORG_A);
    expect(result.skippedOrganizations).toContain(ORG_A);
    expect(result.perOrganization).toContainEqual({
      organizationId: ORG_A,
      skipped: true,
      reason: "enumerate_companies_error",
      cancelled: 0,
    });
    // ORG_B still drains — one bad org never aborts the sweep.
    expect(requestCancellation).toHaveBeenCalledTimes(1);
    expect(requestCancellation.mock.calls[0]![0].organizationId).toBe(ORG_B);
    expect(result.cancelled).toBe(1);
  });

  it("skips (fail-closed) when listActiveAttempts throws, records it in BOTH lists, and continues", async () => {
    const orgsPages = [[ORG_A, ORG_B], []];
    const listActiveAttempts = vi.fn(async (organizationId: string) => {
      if (organizationId === ORG_A) throw new Error("statement timeout");
      return [attempt(ORG_B, CO_B1, "job-b1")];
    });
    const requestCancellation = vi.fn(async () => queued());
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds: vi.fn(async () => orgsPages.shift() ?? []),
      listOrganizationCompanyIds: vi.fn(async (organizationId: string) =>
        organizationId === ORG_A ? [CO_A1] : [CO_B1],
      ),
      listActiveAttempts,
      requestCancellation,
      assertRollbackSafe: vi.fn(async () => {}),
    });
    const result = await drain.drainAll();

    // ORG_A passed the rollback gate but its attempt read failed → skipped (not drained),
    // recorded in BOTH skippedOrganizations and perOrganization (consistent with the other
    // skip paths); ORG_B still drains — one bad org never aborts the sweep.
    expect(result.skippedOrganizations).toContain(ORG_A);
    expect(result.perOrganization).toContainEqual({
      organizationId: ORG_A,
      skipped: true,
      reason: "enumerate_error",
      cancelled: 0,
    });
    expect(requestCancellation).toHaveBeenCalledTimes(1);
    expect(requestCancellation.mock.calls[0]![0].organizationId).toBe(ORG_B);
    expect(result.cancelled).toBe(1);
  });

  it("paginates admitted orgs with an advancing cursor", async () => {
    const pages: Record<string, string[]> = {
      null: [ORG_A],
      [ORG_A]: [ORG_B],
      [ORG_B]: [],
    };
    const listAdmittedOrganizationIds = vi.fn(
      async (input: { afterOrganizationId: string | null }) => pages[String(input.afterOrganizationId)] ?? [],
    );
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds,
      listOrganizationCompanyIds: vi.fn(async () => []),
      listActiveAttempts: vi.fn(async () => []),
      requestCancellation: vi.fn(async () => queued()),
      assertRollbackSafe: vi.fn(async () => {}),
    });
    const result = await drain.drainAll();

    expect(listAdmittedOrganizationIds.mock.calls[0]![0].afterOrganizationId).toBeNull();
    expect(listAdmittedOrganizationIds.mock.calls[1]![0].afterOrganizationId).toBe(ORG_A);
    expect(listAdmittedOrganizationIds.mock.calls[2]![0].afterOrganizationId).toBe(ORG_B);
    expect(result.organizationsScanned).toBe(2);
  });

  it("counts cancelled + no_active_lease as drained; job_terminal + not_found are NOT drained", async () => {
    const orgsPages = [[ORG_A], []];
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds: vi.fn(async () => orgsPages.shift() ?? []),
      listOrganizationCompanyIds: vi.fn(async () => [CO_A1]),
      listActiveAttempts: vi.fn(async () => [
        attempt(ORG_A, CO_A1, "job-1"),
        attempt(ORG_A, CO_A1, "job-2"),
        attempt(ORG_A, CO_A1, "job-3"),
        attempt(ORG_A, CO_A1, "job-4"),
        attempt(ORG_A, CO_A1, "job-5"),
        attempt(ORG_A, CO_A1, "job-6"),
      ]),
      requestCancellation: vi
        .fn()
        .mockResolvedValueOnce({ status: "queued" }) // drained
        .mockResolvedValueOnce({ status: "already_requested" }) // drained
        .mockResolvedValueOnce({ status: "cancelled" }) // drained (real terminal cancel)
        .mockResolvedValueOnce({ status: "no_active_lease" }) // drained (nothing live to fence)
        .mockResolvedValueOnce({ status: "job_terminal" }) // NOT drained
        .mockResolvedValueOnce({ status: "not_found" }), // NOT drained
      assertRollbackSafe: vi.fn(async () => {}),
    });
    const result = await drain.drainAll();
    expect(result.cancelled).toBe(4);
  });

  it("a requestCancellation throw on one attempt does NOT abort the sweep (continues + records)", async () => {
    const orgsPages = [[ORG_A, ORG_B], []];
    const requestCancellation = vi
      .fn()
      .mockResolvedValueOnce({ status: "queued" }) // ORG_A job-a1 → drained
      .mockRejectedValueOnce(new Error("statement timeout")) // ORG_A job-a2 → throws
      .mockResolvedValueOnce({ status: "queued" }); // ORG_B job-b1 → still reached + drained
    const drain = createDistributedExecutionDrain({
      listAdmittedOrganizationIds: vi.fn(async () => orgsPages.shift() ?? []),
      listOrganizationCompanyIds: vi.fn(async (organizationId: string) =>
        organizationId === ORG_A ? [CO_A1] : [CO_B1],
      ),
      listActiveAttempts: vi.fn(async (organizationId: string) =>
        organizationId === ORG_A
          ? [attempt(ORG_A, CO_A1, "job-a1"), attempt(ORG_A, CO_A1, "job-a2")]
          : [attempt(ORG_B, CO_B1, "job-b1")],
      ),
      requestCancellation,
      assertRollbackSafe: vi.fn(async () => {}),
    });

    let result: Awaited<ReturnType<typeof drain.drainAll>> | undefined;
    await expect(
      (async () => {
        result = await drain.drainAll();
      })(),
    ).resolves.not.toThrow();

    // The throw on ORG_A#2 did not abort the sweep — ORG_B#1 was still reached + drained.
    expect(requestCancellation).toHaveBeenCalledTimes(3);
    expect(result?.cancelled).toBe(2); // a1 + b1 (a2 threw, counted as not-drained)
    expect(result?.organizationsScanned).toBe(2);
  });
});
