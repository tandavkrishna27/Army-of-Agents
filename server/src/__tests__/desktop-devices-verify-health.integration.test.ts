// E11 M2 — the desktop-devices read path with computed HEALTH and the read-only VERIFY
// action, exercised against a real embedded Postgres. Mirrors the enrollment integration
// test's boot/seed shape.
//
// What this pins that the unit tests cannot:
//   • HEALTH is computed against the DB clock inside `listDesktopDevices` and appears per row
//     (recent -> healthy, old -> stale, null -> never_seen, and a re-enrolled row whose
//     last_seen_at predates its new enrolled_at -> never_seen, not healthy off the old key).
//   • VERIFY re-derives over the STORED key material: a consistent device verifies true; a
//     device whose stored thumbprint does NOT match its stored key (a record the DB CHECK
//     still admits) verifies false.
//   • Cross-org isolation: an admin of org A verifying a device that belongs to org B gets a
//     404 — the org-admin gate on :orgId is not sufficient; the row must belong to that org.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import express from "express";
import request from "supertest";
import { applyPendingMigrations, createDb } from "@armyofagents/db";
import { desktopDeviceRoutes } from "../routes/desktop-devices.js";
import { errorHandler } from "../middleware/error-handler.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG_A = "81000000-0000-4000-8000-000000000001";
const ORG_B = "81000000-0000-4000-8000-000000000002";
const ADMIN_USER = "e11m2-admin-user";
const OTHER_USER = "e11m2-non-admin-user";

// One execution_target per worker (organizationTargetUq requires distinct targets per
// org-scoped worker).
const T_RECENT = "82000000-0000-4000-8000-000000000001";
const T_OLD = "82000000-0000-4000-8000-000000000002";
const T_NEVER = "82000000-0000-4000-8000-000000000003";
const T_MISMATCH = "82000000-0000-4000-8000-000000000004";
const T_CROSS = "82000000-0000-4000-8000-000000000005";
const T_REENROLL = "82000000-0000-4000-8000-000000000006";

const D_RECENT = "83000000-0000-4000-8000-000000000001";
const D_OLD = "83000000-0000-4000-8000-000000000002";
const D_NEVER = "83000000-0000-4000-8000-000000000003";
const D_MISMATCH = "83000000-0000-4000-8000-000000000004";
const D_CROSS = "83000000-0000-4000-8000-000000000005";
const D_REENROLL = "83000000-0000-4000-8000-000000000006";

const PROFILE_HASH = "a".repeat(64);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let ownerDb: ReturnType<typeof createDb> | null = null;
let setupError: unknown = null;

function ed25519(): { publicKey: string; thumbprint: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { publicKey: der.toString("base64url"), thumbprint: createHash("sha256").update(der).digest("hex") };
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) :
        !address || typeof address === "string" ? reject(new Error("port allocation failed")) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

/** An express app whose actor is the board user named by the `x-e11m2-user` header. */
function makeApp() {
  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => {
    const userId = req.header("x-e11m2-user") ?? null;
    req.actor = userId
      ? { type: "board", source: "session", userId } as never
      : { type: "none" } as never;
    next();
  });
  httpApp.use("/api", desktopDeviceRoutes({ db: ownerDb! }));
  httpApp.use(errorHandler);
  return httpApp;
}

async function seedDesktopTarget(sql: Sql, id: string, orgId: string, slug: string) {
  await sql`INSERT INTO execution_targets
    (id, organization_id, owner_user_id, scope, target_authority_key, slug, kind, trust_class, status)
    VALUES (${id}, ${orgId}, NULL, 'organization', ${`organization:${orgId}`}, ${slug},
      'desktop', 'dedicated_tenant', 'active')`;
}

async function seedWorker(sql: Sql, input: {
  id: string; orgId: string; targetId: string; label: string;
  publicKey: string; thumbprint: string; enrolledAt: Date; lastSeenAt: Date | null;
  deviceGeneration?: number;
}) {
  await sql`INSERT INTO workers
    (id, scope, organization_id, owner_user_id, execution_target_id, target_authority_key,
     device_public_key, device_thumbprint, device_generation, profile_hash, enrolled_at,
     last_seen_at, label, status)
    VALUES (${input.id}, 'organization', ${input.orgId}, NULL, ${input.targetId},
      ${`organization:${input.orgId}`}, ${input.publicKey}, ${input.thumbprint},
      ${input.deviceGeneration ?? 1},
      ${PROFILE_HASH}, ${input.enrolledAt}, ${input.lastSeenAt}, ${input.label}, 'enrolled')`;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e11m2-devices-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    ownerDb = createDb(adminUrl);

    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${ORG_A}, 'E11M2 Org A', 'e11m2-org-a'), (${ORG_B}, 'E11M2 Org B', 'e11m2-org-b')`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      (${ADMIN_USER}, 'Admin', 'e11m2-admin@example.invalid', true, now(), now()),
      (${OTHER_USER}, 'NonAdmin', 'e11m2-nonadmin@example.invalid', true, now(), now())`;
    // ADMIN_USER is an owner of ORG_A (has execution_target:manage); a member (not admin) of
    // ORG_B, so it can never verify ORG_B devices even by path.
    await admin`INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at) VALUES
      (${ORG_A}, ${ADMIN_USER}, 'owner', 'active', now()),
      (${ORG_B}, ${ADMIN_USER}, 'member', 'active', now())`;

    const recent = ed25519();
    const old = ed25519();
    const never = ed25519();
    const mismatch = ed25519();
    const cross = ed25519();
    const reenroll = ed25519();

    await seedDesktopTarget(admin, T_RECENT, ORG_A, "e11m2-recent");
    await seedDesktopTarget(admin, T_OLD, ORG_A, "e11m2-old");
    await seedDesktopTarget(admin, T_NEVER, ORG_A, "e11m2-never");
    await seedDesktopTarget(admin, T_MISMATCH, ORG_A, "e11m2-mismatch");
    await seedDesktopTarget(admin, T_CROSS, ORG_B, "e11m2-cross");
    await seedDesktopTarget(admin, T_REENROLL, ORG_A, "e11m2-reenroll");

    const now = Date.now();
    // A normally-behaving device enrols, THEN checks in — so `enrolled_at` PRECEDES
    // `last_seen_at`. (An earlier draft set enrolled_at = now() with lastSeenAt in the past,
    // which is exactly the re-enrolled-but-unseen state the generation boundary now catches.)
    const enrolledLongAgo = new Date(now - 60 * 60_000); // 1 h ago
    await seedWorker(admin, {
      id: D_RECENT, orgId: ORG_A, targetId: T_RECENT, label: "Recent laptop",
      publicKey: recent.publicKey, thumbprint: recent.thumbprint,
      enrolledAt: enrolledLongAgo, lastSeenAt: new Date(now - 60_000), // seen 1 min ago -> healthy
    });
    await seedWorker(admin, {
      id: D_OLD, orgId: ORG_A, targetId: T_OLD, label: "Old laptop",
      publicKey: old.publicKey, thumbprint: old.thumbprint,
      enrolledAt: new Date(now - 3 * 24 * 60 * 60_000), // enrolled 3 days ago
      lastSeenAt: new Date(now - 2 * 24 * 60 * 60_000), // last seen 2 days ago -> stale
    });
    await seedWorker(admin, {
      id: D_NEVER, orgId: ORG_A, targetId: T_NEVER, label: "Never-seen laptop",
      publicKey: never.publicKey, thumbprint: never.thumbprint,
      enrolledAt: enrolledLongAgo, lastSeenAt: null, // -> never_seen
    });
    await seedWorker(admin, {
      id: D_MISMATCH, orgId: ORG_A, targetId: T_MISMATCH, label: "Mismatched-key laptop",
      publicKey: mismatch.publicKey,
      thumbprint: "0".repeat(64), // valid key, WRONG stored thumbprint (CHECK still admits it)
      enrolledAt: enrolledLongAgo, lastSeenAt: new Date(now - 60_000),
    });
    await seedWorker(admin, {
      id: D_CROSS, orgId: ORG_B, targetId: T_CROSS, label: "Org-B laptop",
      publicKey: cross.publicKey, thumbprint: cross.thumbprint,
      enrolledAt: enrolledLongAgo, lastSeenAt: new Date(now - 60_000),
    });
    // ★ Re-enrolled (gen 2): `rotateWorker` bumped enrolled_at to 30 s ago while the prior
    // generation's last_seen_at (60 s ago) was preserved. The new key has NOT checked in, so
    // health must be never_seen — NOT healthy off the superseded key's heartbeat (Codex P2).
    await seedWorker(admin, {
      id: D_REENROLL, orgId: ORG_A, targetId: T_REENROLL, label: "Re-enrolled laptop",
      publicKey: reenroll.publicKey, thumbprint: reenroll.thumbprint, deviceGeneration: 2,
      enrolledAt: new Date(now - 30_000), lastSeenAt: new Date(now - 60_000), // seen BEFORE re-enrol
    });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await ownerDb?.$client.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

function guard() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !ownerDb) throw new Error("test setup incomplete");
  return { admin, ownerDb };
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E11 M2 — desktop device health + verify (integration)",
  () => {
    it("positive control: all six seeded workers exist before the assertions", async () => {
      const { admin } = guard();
      const rows = await admin<{ id: string }[]>`SELECT id FROM workers
        WHERE id IN (${D_RECENT}, ${D_OLD}, ${D_NEVER}, ${D_MISMATCH}, ${D_CROSS}, ${D_REENROLL})`;
      expect(rows).toHaveLength(6);
    });

    it("GET desktop-devices returns org A's five devices with per-row computed health", async () => {
      guard();
      const res = await request(makeApp())
        .get(`/api/organizations/${ORG_A}/desktop-devices`)
        .set("x-e11m2-user", ADMIN_USER)
        .expect(200);
      const byId = new Map<string, { health: string }>(
        (res.body as { deviceId: string; health: string }[]).map((d) => [d.deviceId, d]),
      );
      expect(res.body).toHaveLength(5); // ORG_A only — the ORG_B device is not visible
      expect(byId.get(D_RECENT)?.health).toBe("healthy");
      expect(byId.get(D_OLD)?.health).toBe("stale");
      expect(byId.get(D_NEVER)?.health).toBe("never_seen");
      expect(byId.get(D_MISMATCH)?.health).toBe("healthy"); // liveness is independent of key integrity
      // ★ Re-enrolled (gen 2): last_seen_at predates the new enrolled_at, so the current key
      // has not checked in — never_seen, not healthy off the superseded key (Codex P2).
      expect(byId.get(D_REENROLL)?.health).toBe("never_seen");
      // The ORG_B device never appears in ORG_A's listing.
      expect(byId.has(D_CROSS)).toBe(false);
    });

    it("VERIFY passes for a consistent enrolment record", async () => {
      guard();
      const res = await request(makeApp())
        .post(`/api/organizations/${ORG_A}/desktop-devices/${D_RECENT}/verify`)
        .set("x-e11m2-user", ADMIN_USER)
        .expect(200);
      expect(res.body).toMatchObject({ verified: true, thumbprintMatches: true, keyValid: true });
    });

    it("VERIFY fails (RED) for a device whose stored thumbprint does not match its key", async () => {
      guard();
      const res = await request(makeApp())
        .post(`/api/organizations/${ORG_A}/desktop-devices/${D_MISMATCH}/verify`)
        .set("x-e11m2-user", ADMIN_USER)
        .expect(200);
      expect(res.body).toMatchObject({ verified: false, thumbprintMatches: false, keyValid: true });
    });

    it("VERIFY of an org-B device via the org-A path is a 404, not a 403", async () => {
      guard();
      // ADMIN_USER is an owner of ORG_A, so assertOrgAdmin(ORG_A) passes; the device belongs
      // to ORG_B, so the org-scoped SQL lookup finds nothing -> 404.
      await request(makeApp())
        .post(`/api/organizations/${ORG_A}/desktop-devices/${D_CROSS}/verify`)
        .set("x-e11m2-user", ADMIN_USER)
        .expect(404);
    });

    it("a non-admin member cannot list or verify (403)", async () => {
      guard();
      await request(makeApp())
        .get(`/api/organizations/${ORG_B}/desktop-devices`)
        .set("x-e11m2-user", ADMIN_USER) // member of ORG_B, not owner/admin
        .expect(403);
      await request(makeApp())
        .post(`/api/organizations/${ORG_B}/desktop-devices/${D_CROSS}/verify`)
        .set("x-e11m2-user", ADMIN_USER)
        .expect(403);
    });

    it("an unauthenticated request is refused (401)", async () => {
      guard();
      // assertBoard maps actor.type 'none' to 401 (not the 403 a wrong-role board gets).
      await request(makeApp())
        .get(`/api/organizations/${ORG_A}/desktop-devices`)
        .expect(401);
    });
  },
);
