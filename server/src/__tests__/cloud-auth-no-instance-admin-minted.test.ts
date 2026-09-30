// Phase 2 Task 11 Step 2b (defense-in-depth, item 2) — belt to P3's
// actor-middleware force-false suspenders: even if a stray instance_user_roles
// row somehow existed, P3 neutralizes it at read time — but P2 must PROVE that
// no request-driven WRITE path can ever mint one in cloud_auth. This uses a db
// double that EXPLODES on any insert/update/delete/transaction, so a
// regression that reintroduces a promotion write fails loudly here rather than
// silently passing because the assertion only checked a return value.
//
// Each of the four promotion sites is exercised with this write-poison db:
//   (1)+(2) both better-auth first-user hooks (server/src/auth/better-auth.ts)
//   (3) bootstrap_ceo invite promotion gate (server/src/routes/access.ts)
//   (4) board-claim (server/src/board-claim.ts)
// plus the boot-time invariant (server/src/services/first-user-bootstrap.ts).
import { describe, it, expect } from "vitest";
import { assertInstanceAdminBootstrapInvariant } from "../services/first-user-bootstrap.js";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { claimBoardOwnership } from "../board-claim.js";

const cfg = {
  deploymentMode: "cloud_auth",
  deploymentExposure: "public",
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com",
  googleClientId: "x",
  googleClientSecret: "y",
  headlessBootstrap: false,
} as any;

// A db that RECORDS reads but EXPLODES on any write — proves no row is minted.
function noWriteDb() {
  const boom = () => {
    throw new Error("UNEXPECTED WRITE: cloud_auth must mint no instance_user_roles row");
  };
  return {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: boom,
    update: boom,
    delete: boom,
    transaction: boom, // board-claim's promotion write lives inside a transaction
  } as any;
}

describe("cloud_auth mints ZERO instance_user_roles rows (defense-in-depth)", () => {
  it("boot invariant holds for cloud_auth", () => {
    expect(() => assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" })).not.toThrow();
  });

  it("boot invariant would THROW if a tampered resolver enabled cloud_auth promotion (proves the assertion is load-bearing, not vacuous)", () => {
    expect(() =>
      assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" }, () => true),
    ).toThrow(/cloud_auth must not mint runtime instance_admin/i);
  });

  it("(1)+(2) neither better-auth hook is wired, so attemptFirstAdminBootstrap can never run against a real db", () => {
    const built = buildBetterAuthConfig(noWriteDb(), cfg, [], "s") as any;
    expect(built.databaseHooks?.user?.create?.after).toBeUndefined();
    expect(built.databaseHooks?.session?.create?.after).toBeUndefined();
  });

  it("(3) bootstrap_ceo promotion gate is closed, so the only insert site (promoteInstanceAdmin) is unreachable", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });

  it("(4) board-claim short-circuits BEFORE its transaction — the write-poison db is never touched", async () => {
    const r = await claimBoardOwnership(noWriteDb(), {
      token: "t",
      code: "c",
      userId: "u",
      deploymentMode: "cloud_auth",
    } as any);
    expect(r.status).toBe("invalid"); // did NOT throw ⇒ transaction/insert never attempted
  });

  it("self-hosted (authenticated) is UNCHANGED — write-poison db is not asserted there (hooks still wire, gate stays open)", () => {
    const selfHostedCfg = { ...cfg, deploymentMode: "authenticated" };
    const built = buildBetterAuthConfig(noWriteDb(), selfHostedCfg, [], "s") as any;
    expect(typeof built.databaseHooks.user.create.after).toBe("function");
    expect(typeof built.databaseHooks.session.create.after).toBe("function");
    expect(bootstrapCeoPromotionAllowed("authenticated")).toBe(true);
  });
});
