import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  issueAttachments,
  type Db,
} from "@armyofagents/db";
import { issueService } from "../services/issues.js";

// C6 (PR #291 round-2 review) — completeMissingCommentAttachments must serialize
// concurrent same-key retries so two overlapping completions can never each
// create the same missing attachment. The serialization uses a transaction-scoped
// Postgres advisory lock, which needs real transaction isolation, so this runs
// against an embedded Postgres. It collects + skips on Windows (embedded-postgres
// can't start on the CI Windows runner); the controller runs it on Linux.

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

const PORT = 59500 + Math.floor(Math.random() * 400);

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const commentId = "33333333-3333-4333-8333-333333333333";

const FILE_BODY = Buffer.from("proof-of-work bytes");
const FILE_NAME = "proof.png";
const FILE_SHA = createHash("sha256").update(FILE_BODY).digest("hex");

function makeStore() {
  // Content-addressed enough for the test: each call returns the real sha of the
  // buffer (matching production putFile) with a unique objectKey.
  let n = 0;
  return async (file: { contentType: string; buffer: Buffer; originalFilename: string | null }) => ({
    provider: "memory",
    objectKey: `issues/${issueId}/${n++}-${file.originalFilename ?? "file"}`,
    contentType: file.contentType,
    byteSize: file.buffer.length,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    originalFilename: file.originalFilename,
  });
}

async function countAttachments(): Promise<number> {
  const rows = await db
    .select({ id: issueAttachments.id })
    .from(issueAttachments)
    .where(
      and(
        eq(issueAttachments.issueId, issueId),
        eq(issueAttachments.issueCommentId, commentId),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-attach-race-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Windows local runs: UTF8/C avoids the WIN1252 migration-comment failure.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Attach Race Co', 'ARC')
    `);
    await db.execute(sql`
      INSERT INTO issues (id, company_id, title, status)
      VALUES (${issueId}, ${companyId}, 'Upload race', 'todo')
    `);
    await db.execute(sql`
      INSERT INTO issue_comments (id, company_id, issue_id, body)
      VALUES (${commentId}, ${companyId}, ${issueId}, 'see attached')
    `);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore cleanup failures
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "C6 — completeMissingCommentAttachments serializes concurrent retries",
  () => {
    it("two concurrent completions of the same missing file create the attachment exactly once", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      const svc = issueService(db);
      const runCompletion = () =>
        svc.completeMissingCommentAttachments({
          companyId,
          issueId,
          commentId,
          createdByUserId: null,
          createdByAgentId: null,
          files: [{ contentType: "image/png", buffer: FILE_BODY, originalFilename: FILE_NAME }],
          store: makeStore(),
        });

      // Fire both retries at once. The advisory lock must serialize them: the
      // first creates the attachment, the second re-reads the now-complete set
      // inside its own lock and creates nothing.
      const [a, b] = await Promise.all([runCompletion(), runCompletion()]);

      // Exactly one attachment row exists for the comment.
      expect(await countAttachments()).toBe(1);

      // Across both callers, the file was created exactly once.
      const totalCreated = a.created.length + b.created.length;
      expect(totalCreated).toBe(1);

      // Both callers see the completed attachment in their `all` view.
      expect(a.all).toHaveLength(1);
      expect(b.all).toHaveLength(1);
      expect(a.all[0].sha256).toBe(FILE_SHA);
    });

    it("is idempotent when the file already exists (creates nothing)", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const before = await countAttachments();

      const svc = issueService(db);
      const result = await svc.completeMissingCommentAttachments({
        companyId,
        issueId,
        commentId,
        createdByUserId: null,
        createdByAgentId: null,
        files: [{ contentType: "image/png", buffer: FILE_BODY, originalFilename: FILE_NAME }],
        store: makeStore(),
      });

      expect(result.created).toHaveLength(0);
      expect(await countAttachments()).toBe(before);
    });
  },
);
