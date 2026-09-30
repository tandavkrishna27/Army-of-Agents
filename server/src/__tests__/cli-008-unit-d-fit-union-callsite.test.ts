// cli-008-unit-d-fit-union-callsite.test.ts — E7-F009 at the CALL SITE.
//
// `cli-008-unit-d-fit-union.test.ts` proves the projection is right. This proves
// `stageJobInputFiles` actually HANDS IT the attempt's committed rows — which is the half the
// finding was about ("the data is already in scope at the call site"). A correct projection
// called with the wrong argument is the defect, not its fix.
//
// The multi-stage route needs a database, and the suite that has one
// (`job-input-staging.integration.test.ts`) does not run on every machine. So the tenant
// transaction and the audit write are stubbed here and the REAL refusal logic runs: no
// Postgres, and still an end-to-end assertion that a second stage sees the first one's rows.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { expectedAttemptObjectPrefix } from "@armyofagents/worker-protocol";

/** Rows the fake tenant repo hands back for `listForJob`. Mutated per test. */
const rows: Array<Record<string, unknown>> = [];

vi.mock("../db/tenant-context.js", () => ({
  runInTenant: async (_db: unknown, _org: string, fn: (repos: unknown, tx: unknown) => unknown) =>
    fn(
      {
        attempts: { getById: async () => ({ jobId: JOB, attemptNumber: 1 }) },
        jobArtifacts: {
          listForJob: async () => [...rows],
          insert: async (row: Record<string, unknown>) => {
            rows.push(row);
          },
        },
      },
      {},
    ),
}));

vi.mock("../services/activity-log.js", () => ({ insertActivity: async () => undefined }));

const {
  STAGED_INPUT_ARTIFACT_KIND,
  StagedInputRefusedError,
  pointerFitsExtension,
  stageJobInputFiles,
  stagedPathMarker,
} = await import("../services/job-input-staging.js");

const ORG = "66666666-6666-4666-8666-666666666666";
const JOB = "10b10b10-10b1-4b10-8b10-10b10b10b10b";
const ATTEMPT = "a77e3907-a77e-4a77-8a77-a77ea77ea77e";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let minted = 0;
const storage = {
  putObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
};

function stage(paths: string[], bytesPerFile = 1024) {
  return stageJobInputFiles({
    appDb: {} as never,
    storage: storage as never,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attemptId: ATTEMPT,
    files: paths.map((path) => ({ path, bytes: new Uint8Array(bytesPerFile) })),
    newArtifactId: () => `00000000-0000-4000-8000-${String((minted += 1)).padStart(12, "0")}`,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
}

beforeEach(() => {
  rows.length = 0;
  minted = 0;
  storage.putObject.mockClear();
  storage.deleteObject.mockClear();
});

/** The object-key prefix the staging path derives for this org/job/attempt. */
const PREFIX = expectedAttemptObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: 1 });

/** The file count at which a SINGLE stage stops fitting — measured, never assumed. */
function firstRefusedCount(): number {
  for (let n = 1; n < 2000; n += 1) {
    const files = Array.from({ length: n }, (_, i) => ({ path: `/a/${i}.md`, bytes: new Uint8Array(1024) }));
    if (!pointerFitsExtension([], files, PREFIX)) return n;
  }
  throw new Error("no refusal below 2000 files — the fixture no longer approaches the budget");
}

describe("E7-F009 — the call site passes the attempt's committed rows to the fit check", () => {
  const CLIFF = firstRefusedCount();

  it("the fixture approaches the budget (anti-vacuity)", () => {
    expect(CLIFF).toBeGreaterThan(10);
    expect(CLIFF).toBeLessThan(1000);
  });

  it("the fake repo really does accumulate rows across stages (anti-vacuity)", async () => {
    await stage(["/home/user/.aoa-run-prompt.md"]);
    await stage(["/home/user/.aoa-run-instructions.md"]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === STAGED_INPUT_ARTIFACT_KIND)).toBe(true);
    expect(rows.map((row) => row.contentType)).toEqual([
      stagedPathMarker("/home/user/.aoa-run-prompt.md"),
      stagedPathMarker("/home/user/.aoa-run-instructions.md"),
    ]);
  });

  it("★★★ a SECOND stage adding NEW PATHS is refused once the UNION passes the budget", async () => {
    // Fill the attempt to just under the cliff with one stage, then add more paths in a
    // second one. Before the fix, each call projected only its own files, both said "fits",
    // and the job became permanently unleaseable at poll time with nothing naming the cause.
    const half = Math.ceil(CLIFF / 2);
    const first = Array.from({ length: half }, (_, i) => `/a/${i}.md`);
    const second = Array.from({ length: CLIFF - half + 2 }, (_, i) => `/b/${i}.md`);

    // Each half fits on its own — which is exactly why the old projection said "fits" twice.
    expect(pointerFitsExtension([], first.map((path) => ({ path, bytes: new Uint8Array(1024) })), PREFIX)).toBe(true);
    expect(pointerFitsExtension([], second.map((path) => ({ path, bytes: new Uint8Array(1024) })), PREFIX)).toBe(true);

    await expect(stage(first)).resolves.toMatchObject({ staged: true });
    await expect(stage(second)).rejects.toBeInstanceOf(StagedInputRefusedError);

    // ★ REFUSED BEFORE A BYTE MOVED. Only the first stage's objects exist.
    expect(storage.putObject).toHaveBeenCalledTimes(half);
    expect(rows).toHaveLength(half);
  });

  it("★ the refusal names the accumulated set, not just this call's files", async () => {
    const half = Math.ceil(CLIFF / 2);
    await stage(Array.from({ length: half }, (_, i) => `/a/${i}.md`));
    await expect(
      stage(Array.from({ length: CLIFF - half + 2 }, (_, i) => `/b/${i}.md`)),
    ).rejects.toThrow(/already committed/);
  });

  it("a second stage of the SAME bytes at the SAME path still replays (not a false refusal)", async () => {
    // The counter-test. Counting an already-committed path twice would refuse a bundle that
    // fits — a refusal for a wire state that can never exist.
    const paths = ["/home/user/.aoa-run-prompt.md", "/home/user/.aoa-run-instructions.md"];
    await stage(paths);
    const again = await stage(paths);
    expect(again).toMatchObject({ staged: true });
    expect(rows).toHaveLength(2);
    expect(storage.putObject).toHaveBeenCalledTimes(2);
  });

  it("a realistic Unit D bundle (prompt + instructions) is nowhere near the budget", async () => {
    // The bound must not bite the thing this unit actually stages.
    const result = await stage(
      ["/home/user/.aoa-run-prompt.md", "/home/user/.aoa-run-instructions.md"],
      32_000,
    );
    expect(result).toMatchObject({ staged: true, attempt: 1 });
  });
});
