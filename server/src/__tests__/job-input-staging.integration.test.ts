// server/src/__tests__/job-input-staging.integration.test.ts
//
// CLI-008 Unit B · Task 2 Step 2 — the control-plane staging write, on REAL SERVING ROLES.
//
// ★ THE LOAD-BEARING ASSERTION IS "NO LEASE ROW, NO FENCE EVER". That property is the whole
// reason this path was chosen over the fenced mutators, and it is the one a future refactor
// is most likely to break by "tidying" the write behind `guardActiveFence` — a guard that
// CANNOT be satisfied before placement, so adding it would silently remove the capability
// rather than secure it. Every other case here is about the two barriers that ARE real:
// RLS (a foreign organization fails 42501) and the composite FK (a ghost job fails 23503).
//
// Embedded PostgreSQL against HEAD's migrations, `aoa_app` (NOSUPERUSER/NOBYPASSRLS) —
// reading the code proves nothing about either barrier.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { canonicalizeJsonV1 } from "@armyofagents/worker-protocol";

import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  STAGED_INPUT_ARTIFACT_KIND,
  StagedInputRefusedError,
  stageJobInputFiles,
  stagedPathFromMarker,
} from "../services/job-input-staging.js";
import type { PutObjectInput, StorageProvider } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "c8000000-0000-4000-8000-000000000001";
const COMPANY = "c8000000-0000-4000-8000-000000000002";
const OTHER_ORG = "c8000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "c8000000-0000-4000-8000-0000000000bb";
const PASSWORD = "cli-008-role-password";
const POLICY_HASH = "3".repeat(64);

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An in-memory object store that records exactly what crossed the storage port. */
function makeStubStorage(): StorageProvider & {
  objects: Map<string, Buffer>;
  puts: PutObjectInput[];
  deletes: string[];
  failNextPut: boolean;
} {
  const state = {
    objects: new Map<string, Buffer>(),
    puts: [] as PutObjectInput[],
    deletes: [] as string[],
    failNextPut: false,
  };
  return {
    id: "s3",
    get objects() { return state.objects; },
    get puts() { return state.puts; },
    get deletes() { return state.deletes; },
    get failNextPut() { return state.failNextPut; },
    set failNextPut(v: boolean) { state.failNextPut = v; },
    async putObject(input) {
      if (state.failNextPut) {
        state.failNextPut = false;
        throw new Error("stub store refused the put");
      }
      state.puts.push(input);
      state.objects.set(input.objectKey, Buffer.from(input.body));
    },
    async getObject() { throw new Error("not used"); },
    async headObject(input) {
      const object = state.objects.get(input.objectKey);
      return object ? { exists: true, contentLength: object.byteLength } : { exists: false };
    },
    async deleteObject(input) {
      state.deletes.push(input.objectKey);
      state.objects.delete(input.objectKey);
    },
  };
}

/** Postgres errors reach the caller wrapped (drizzle nests the driver error on `cause`), so
 * assert on the SQLSTATE anywhere in the chain rather than on the top-level shape. */
async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the write to be refused").toBeDefined();
  const codes: string[] = [];
  for (let error: unknown = caught; error && typeof error === "object"; error = (error as { cause?: unknown }).cause) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
  }
  expect(codes).toContain(sqlState);
}

integration("CLI-008 Unit B — the control-plane staging write on real serving roles", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinal = 0;

  function ctx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app) throw new Error("test setup incomplete");
    return { admin, app };
  }

  /** A job + attempt with NO lease, NO placement lease-eligibility and NO fence — the state
   * the control plane actually stages in. */
  async function seedJob(organizationId = ORG, companyId = COMPANY): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = ctx();
    ordinal += 1;
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `c8100000-0000-4000-8000-${suffix}`;
    const attemptId = `c8200000-0000-4000-8000-${suffix}`;
    const workload = { command: "claude", args: ["--print", "hi"], stdinArtifactId: null, maxRuntimeSeconds: 240 };
    const at = new Date(Date.now() - 60_000 + ordinal);
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, created_at, updated_at)
      VALUES (${jobId}, ${organizationId}, ${companyId}, 'batch', 'one_shot', ${jobId},
        ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
        'system', 'cli-008-test', 'system', 'cli-008-test', ${workload},
        ${sha256(canonicalizeJsonV1(workload))},
        ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
        ${{ workloadType: "batch", requiredCapabilities: ["sandbox.process_isolated"] }},
        ${{ policyId: "job-submission-default", policyVersion: 1 }},
        ${at}, 50, 'queued', ${at}, ${at})`;
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status, created_at, updated_at)
      VALUES (${attemptId}, ${organizationId}, ${companyId}, ${jobId}, 1, 'pending', ${at}, ${at})`;
    return { jobId, attemptId };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-cli008-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
        persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 8 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'CLI-008 org', 'cli-008-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'CLI-008 other', 'cli-008-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'CLI-008 company', 'C008')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'CLI-008 other company', 'C008O')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("★ stages a file with NO LEASE ROW and NO FENCE EVER HAVING EXISTED", async () => {
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const content = "# staged by the control plane\n";

    // The precondition, asserted rather than assumed: this attempt has no lease at all.
    const leasesBefore = await admin`SELECT count(*)::int AS n FROM leases WHERE job_id = ${jobId}`;
    expect(leasesBefore[0]?.n).toBe(0);

    const result = await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [{ path: "/home/user/.aoa/staged.md", bytes: bytes(content), contentType: "text/markdown" }],
    });

    expect(result.staged).toBe(true);
    if (!result.staged) return;
    expect(result.attempt).toBe(1);
    expect(result.pointers).toHaveLength(1);
    const pointer = result.pointers[0]!;
    expect(pointer.objectKey).toBe(
      `organizations/${ORG}/jobs/${jobId}/attempts/1/${pointer.artifactId}`,
    );
    expect(pointer.sha256).toBe(sha256(content));
    expect(pointer.sizeBytes).toBe(Buffer.byteLength(content));
    // The bytes really crossed the storage port, and they are the file's bytes.
    expect(storage.objects.get(pointer.objectKey)?.toString("utf8")).toBe(content);

    // ★ The committed row exists, carries NO lease and NO fence, and STILL no lease row
    // exists for this job — so no fence has ever existed for it.
    const rows = await admin`SELECT * FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("committed");
    expect(rows[0]?.lease_id).toBeNull();
    expect(rows[0]?.fence_token).toBeNull();
    expect(rows[0]?.kind).toBe(STAGED_INPUT_ARTIFACT_KIND);
    expect(stagedPathFromMarker(rows[0]?.content_type as string)).toBe("/home/user/.aoa/staged.md");
    const leasesAfter = await admin`SELECT count(*)::int AS n FROM leases WHERE job_id = ${jobId}`;
    expect(leasesAfter[0]?.n).toBe(0);

    // And it is exactly what the download branch's precondition looks for.
    const found = await runInTenant(app.db, ORG, async (repos) =>
      repos.jobArtifacts.findCommitted({ jobId, attempt: 1, identifier: pointer.artifactId }),
    );
    expect(found?.objectKey).toBe(pointer.objectKey);
  });

  it("is idempotent per (attempt, path, digest) — a replay writes no second object", async () => {
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const files = [{ path: "/home/user/.aoa/staged.md", bytes: bytes("same bytes") }];

    const first = await stageJobInputFiles({ appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files });
    const second = await stageJobInputFiles({ appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files });

    expect(first.staged && second.staged).toBe(true);
    if (!first.staged || !second.staged) return;
    expect(second.pointers[0]).toEqual(first.pointers[0]);
    expect(storage.puts).toHaveLength(1);
    const rows = await admin`SELECT count(*)::int AS n FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows[0]?.n).toBe(1);
  });

  it("★ RLS is real — staging into a FOREIGN organization fails 42501 and writes nothing", async () => {
    const { admin, app } = ctx();
    // A job that belongs to OTHER_ORG, staged from inside ORG's tenant context.
    const { jobId, attemptId } = await seedJob(OTHER_ORG, OTHER_COMPANY);
    const storage = makeStubStorage();

    // The attempt is invisible under ORG's context, so the resolve step already refuses —
    // which is the fail-closed direction. Prove the deeper barrier too, by asking the
    // repository to insert an artifact for a FOREIGN organization directly.
    // ★ It THROWS rather than returning. A returned refusal would let placement run and the
    //   attempt become leasable with no files behind it — a silent wrong-content execution.
    const refused = stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [{ path: "/home/user/.aoa/x.md", bytes: bytes("x") }],
    });
    await expect(refused).rejects.toThrow(StagedInputRefusedError);
    await expect(refused).rejects.toMatchObject({ reason: "unknown_attempt" });
    expect(storage.puts).toHaveLength(0);

    await expectSqlState(
      runInTenant(app.db, ORG, async (repos) =>
        repos.jobArtifacts.insert({
          organizationId: OTHER_ORG, jobId, identifier: crypto.randomUUID(), attempt: 1,
          objectKey: `organizations/${OTHER_ORG}/jobs/${jobId}/attempts/1/x`,
          sha256: sha256("x"), sizeBytes: 1, kind: STAGED_INPUT_ARTIFACT_KIND,
          status: "committed", leaseId: null, fenceToken: null,
        }),
      ),
      "42501",
    );

    const rows = await admin`SELECT count(*)::int AS n FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows[0]?.n).toBe(0);
  });

  it("★ the composite FK is real — staging for a GHOST job fails 23503", async () => {
    const { app } = ctx();
    const ghostJobId = "c8100000-0000-4000-8000-0000000f0000";
    await expectSqlState(
      runInTenant(app.db, ORG, async (repos) =>
        repos.jobArtifacts.insert({
          organizationId: ORG, companyId: COMPANY, jobId: ghostJobId, identifier: crypto.randomUUID(), attempt: 1,
          objectKey: `organizations/${ORG}/jobs/${ghostJobId}/attempts/1/x`,
          sha256: sha256("x"), sizeBytes: 1, kind: STAGED_INPUT_ARTIFACT_KIND,
          status: "committed", leaseId: null, fenceToken: null,
        }),
      ),
      "23503",
    );
  });

  it("deletes the object when the row write fails — no undiscoverable orphan", async () => {
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    // A duplicate identifier collides with `job_artifacts_committed_identity_uidx`, which is
    // the realistic way the row write fails after the object has already landed.
    const fixedId = crypto.randomUUID();
    await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      newArtifactId: () => fixedId,
      files: [{ path: "/a.md", bytes: bytes("a") }],
    });
    await expect(
      stageJobInputFiles({
        appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
        newArtifactId: () => fixedId,
        // A DIFFERENT path/digest, so the idempotency short-circuit does not fire and the
        // insert genuinely collides.
        files: [{ path: "/b.md", bytes: bytes("b") }],
      }),
    ).rejects.toThrow();

    expect(storage.deletes).toContain(`organizations/${ORG}/jobs/${jobId}/attempts/1/${fixedId}`);
    const rows = await admin`SELECT count(*)::int AS n FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows[0]?.n).toBe(1);
  });

  it("★ refuses a bundle whose POINTER could not ride the envelope, BEFORE a byte moves", async () => {
    // The pointer is ~200 bytes a file against a frozen 16,384-byte per-extension budget, so
    // past ~70 files the extension stops being wire-legal — `buildJobEnvelope` would safeParse
    // to null and the job would be PERMANENTLY UNLEASEABLE with nothing naming the cause.
    // Refusing here turns an undiagnosable cliff into an attributable answer.
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const many = Array.from({ length: 200 }, (_unused, i) => ({
      path: `/home/user/.aoa/file-${i}.md`,
      bytes: bytes(`content ${i}`),
    }));
    const result = stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files: many,
    });
    await expect(result).rejects.toThrow(StagedInputRefusedError);
    await expect(result).rejects.toMatchObject({ reason: "pointer_too_large" });
    // ★ Nothing was written — not the objects, and not the rows.
    expect(storage.puts).toHaveLength(0);
    const rows = await admin`SELECT count(*)::int AS n FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows[0]?.n).toBe(0);
  });

  it("still stages a realistic bundle — the ceiling is not in the way of Units C and D", async () => {
    // Task 1 measured the real need at two files, 26,597 bytes of CONTENT (the LF figure;
    // the 26,814 first recorded here was a CRLF checkout's). The pointer for
    // that is a rounding error against the budget; this pins that the guard above cannot
    // start refusing the bundles the channel exists to carry.
    const { app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const result = await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [
        { path: "/home/user/.aoa/mcp.json", bytes: bytes("x".repeat(246)) },
        { path: "/home/user/.aoa/AGENTS.md", bytes: bytes("y".repeat(26_351)) },
      ],
    });
    expect(result.staged).toBe(true);
  });

  it("★★ writes ONE bundle-level activity entry — paths and digests, never bytes", async () => {
    // ★ WHY THIS EXISTS. Staging is the one mutation on the inbound path that the tenant can
    //   neither see nor undo: the control plane places content inside a run the tenant owns.
    //   The artifact rows are the mechanism's own bookkeeping — nothing renders them — so
    //   without this entry nothing in the Activity feed says content was placed at all.
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const secret = "sk-live-DO-NOT-LOG-0123456789";

    await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [
        { path: "/home/user/.aoa/mcp.json", bytes: bytes(secret) },
        { path: "/home/user/.aoa/AGENTS.md", bytes: bytes("# instructions") },
      ],
    });

    const rows = await admin`
      SELECT action, actor_type, actor_id, entity_type, entity_id, run_id, agent_id, details
      FROM activity_log WHERE company_id = ${COMPANY} AND entity_id = ${jobId}`;
    // ★ ONE entry for a TWO-file bundle. A bundle is a single control-plane act; per-file rows
    //   would flood the feed with the mechanism's granularity instead of the decision's.
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.action).toBe("job.staged_input");
    expect(entry.actor_type).toBe("system");
    expect(entry.actor_id).toBe("control-plane");
    expect(entry.entity_type).toBe("job");
    expect(entry.entity_id).toBe(jobId);
    // ★ `run_id` FKs `heartbeat_runs`; a distributed attemptId is not one, so passing it would
    //   23503 and roll the artifact rows back with it. The JOB-013 bridge forces it null for the
    //   same reason.
    expect(entry.run_id).toBeNull();
    expect(entry.agent_id).toBeNull();

    const details = entry.details as { attempt: number; fileCount: number; files: { path: string; sha256: string }[] };
    expect(details.fileCount).toBe(2);
    expect(details.attempt).toBe(1);
    expect(details.files.map((f) => f.path).sort()).toEqual(
      ["/home/user/.aoa/AGENTS.md", "/home/user/.aoa/mcp.json"],
    );
    expect(details.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);

    // ★★ NO BYTES, AND NO SECRET MATERIAL, anywhere in the serialized row. Staged files are
    //   exactly the content — MCP configs, credential-adjacent instructions — whose bytes must
    //   never reach a durable, broadly-readable audit surface. Asserted against the WHOLE
    //   serialized row, not the fields we happened to think of.
    const serialized = JSON.stringify(entry);
    // ★★★ BOTH ARMS ARE LOAD-BEARING, AND THE SECOND IS THE ONE THAT BITES. Measured by
    //   mutation: putting the raw bytes into the payload leaves the `sk-live-…` string
    //   REDACTED — `insertActivityLog` runs `sanitizeRecord`, whose `looksLikeSecretValue`
    //   catches secret-SHAPED strings — while `# instructions` passes through verbatim. So a
    //   test that only checked for a credential would have gone green on a leak of every other
    //   byte. The sanitizer is a backstop against secret-shaped material, never a licence to
    //   put content in the payload and let it filter.
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("# instructions");
    // The storage address is not the tenant's business either.
    expect(serialized).not.toContain("organizations/");
  });

  it("★ a REPLAYED stage adds no second entry — the audit tracks acts, not calls", async () => {
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const files = [{ path: "/home/user/.aoa/AGENTS.md", bytes: bytes("# instructions") }];

    await stageJobInputFiles({ appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files });
    await stageJobInputFiles({ appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files });

    // The second call recognises the committed row for the same (path, digest) and writes
    // nothing — no object, no row, and so no entry. An audit that counted CALLS would tell a
    // founder the control plane staged twice when it staged once.
    const rows = await admin`
      SELECT count(*)::int AS n FROM activity_log
      WHERE company_id = ${COMPANY} AND entity_id = ${jobId}`;
    expect(rows[0]?.n).toBe(1);
    expect(storage.puts).toHaveLength(1);
  });

  it("★★ a FAILED upload mid-bundle leaves NO objects behind — P2-a", async () => {
    // ★★★ WHY THIS IS THE WORST KIND OF LEAK. The upload loop used to sit OUTSIDE the
    //   compensation, so a failure on the second file left the first file's object stored with
    //   no row naming it. The storage port has no list operation — an object nobody recorded
    //   can never be found again. These orphans are permanent AND undiscoverable, and they
    //   accumulate one per partial stage for the life of the bucket, billed and invisible.
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    let uploads = 0;
    const failing: typeof storage = {
      ...storage,
      putObject: async (put) => {
        uploads += 1;
        // The SECOND file fails. The first has already been written.
        if (uploads === 2) throw new Error("object store unavailable");
        return storage.putObject(put);
      },
    };

    await expect(
      stageJobInputFiles({
        appDb: app.db, storage: failing, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
        files: [
          { path: "/home/user/.aoa/a.md", bytes: bytes("first") },
          { path: "/home/user/.aoa/b.md", bytes: bytes("second") },
        ],
      }),
    ).rejects.toThrow(/object store unavailable/);

    // ★ The first file's object was written AND then deleted. Not "never written" — the
    //   compensation is what makes the difference, so assert the delete happened.
    expect(storage.puts).toHaveLength(1);
    expect(storage.deletes).toEqual(storage.puts.map((put) => put.objectKey));

    // And no half-staged rows: the row transaction never ran.
    const rows = await admin`SELECT count(*)::int AS n FROM job_artifacts WHERE job_id = ${jobId}`;
    expect(rows[0]?.n).toBe(0);
  });

  it("★★ a restage with DIFFERENT bytes at the same path is REFUSED — P2-b", async () => {
    // ★★★ The replay probe matches on path AND digest, so changed bytes used to mint a
    //   SECOND committed row for the same path. The partial unique index keys on `identifier`
    //   (org, job, attempt, identifier WHERE status='committed'), which is minted per stage, so
    //   nothing stopped it — and `listForJob` has NO ORDER BY, so which of the two the offer
    //   carried was genuinely unspecified. The run would receive one of two versions of its own
    //   instructions, picked by the query planner.
    const { admin, app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const PATH = "/home/user/.aoa/AGENTS.md";

    await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [{ path: PATH, bytes: bytes("version one") }],
    });

    const restage = stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId,
      files: [{ path: PATH, bytes: bytes("version TWO") }],
    });
    await expect(restage).rejects.toThrow(StagedInputRefusedError);
    await expect(restage).rejects.toMatchObject({ reason: "conflicting_restage" });

    // ★ EXACTLY ONE effective file, and it is the first version. Refused BEFORE a byte moved,
    //   so there is no second object to orphan either — which is the half a "supersede" design
    //   would have had to answer for.
    const rows = await admin`
      SELECT sha256 FROM job_artifacts WHERE job_id = ${jobId} AND status = 'committed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sha256).toBe(sha256("version one"));
    expect(storage.puts).toHaveLength(1);
  });

  it("★ stages nothing for an empty file list — the ONLY non-throwing refusal", async () => {
    const { app } = ctx();
    const { jobId, attemptId } = await seedJob();
    const storage = makeStubStorage();
    const result = await stageJobInputFiles({
      appDb: app.db, storage, organizationId: ORG, companyId: COMPANY, jobId, attemptId, files: [],
    });
    // ★ This one RETURNS, and the union type says so: `no_files` is the sole `staged: false`
    //   variant. The caller asked for nothing, so the postcondition holds vacuously and the
    //   run must proceed distributed. A blanket "any false throws" would turn every ordinary
    //   run into a legacy one — which is why the fix narrowed the type instead.
    expect(result).toEqual({ staged: false, reason: "no_files" });
    expect(storage.puts).toHaveLength(0);
  });
});
