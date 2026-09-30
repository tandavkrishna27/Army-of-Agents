// Phase 2 Task 11 — consolidated security regression suite: ALL FOUR
// instance_admin promotion paths, in ONE file, so a future change that
// re-enables any single path is caught here even if the per-path test that
// originally locked it in (Tasks 7/8/10) is later modified, skipped, or
// deleted. Each dimension has DEEPER coverage in its own file — this is the
// single canonical place a reviewer or CI dashboard can point at to answer
// "is cloud_auth still admin-less?":
//   (1)+(2) better-auth hooks  -> cloud-auth-cutover.test.ts (Task 10)
//   (3)     bootstrap_ceo      -> bootstrap-ceo-cloud-auth.test.ts (Task 7)
//   (4)     board-claim        -> board-claim-cloud-auth.test.ts (Task 8)
//   chokepoint                 -> instance-admin-bootstrap-gate.test.ts (Task 4)
//   zero-write defense-in-depth -> cloud-auth-no-instance-admin-minted.test.ts (Task 11)
//   self-hosted preserved      -> cloud-auth-cutover.test.ts + first-user-bootstrap.test.ts
import { describe, it, expect } from "vitest";
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { claimBoardOwnership } from "../board-claim.js";

const cloudAuthCfg = {
  deploymentMode: "cloud_auth",
  deploymentExposure: "public",
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com",
  googleClientId: "x",
  googleClientSecret: "y",
  headlessBootstrap: false,
} as any;

const db: any = { select: () => ({ from: () => ({ where: async () => [] }) }) };

describe("cloud_auth: all four instance_admin promotion paths are inert", () => {
  it("(1) better-auth user.create hook is not wired", () => {
    expect((buildBetterAuthConfig(db, cloudAuthCfg, [], "s") as any).databaseHooks?.user?.create?.after).toBeUndefined();
  });

  it("(2) better-auth session.create hook is not wired", () => {
    expect((buildBetterAuthConfig(db, cloudAuthCfg, [], "s") as any).databaseHooks?.session?.create?.after).toBeUndefined();
  });

  it("(3) bootstrap_ceo promotion is disallowed", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });

  it("(4) board-claim is inert", async () => {
    const r = await claimBoardOwnership(db, {
      token: "t",
      code: "c",
      userId: "u",
      deploymentMode: "cloud_auth",
    } as any);
    expect(r.status).toBe("invalid");
  });

  it("the shared chokepoint agrees with all four sites — cloud_auth disabled, self-hosted preserved", () => {
    expect(instanceAdminBootstrapEnabled("cloud_auth")).toBe(false);
    expect(instanceAdminBootstrapEnabled("authenticated")).toBe(true);
    expect(instanceAdminBootstrapEnabled("local_trusted")).toBe(true);
  });
});

describe("first cloud_auth user does NOT get instance_admin", () => {
  it("a fresh cloud_auth instance wires no promotion hooks at all — the first signed-in user is an ordinary user, not instance_admin", () => {
    const built = buildBetterAuthConfig(db, cloudAuthCfg, [], "s") as any;
    // databaseHooks is present (better-auth requires the key) but empty — no
    // user.create/session.create callback exists that could ever call
    // promoteFirstUserToInstanceAdmin.
    expect(built.databaseHooks).toEqual({});
  });

  it("self-hosted (authenticated) STILL auto-provisions the first user via the same hooks", () => {
    const built = buildBetterAuthConfig(db, { ...cloudAuthCfg, deploymentMode: "authenticated" }, [], "s") as any;
    expect(typeof built.databaseHooks.user.create.after).toBe("function");
    expect(typeof built.databaseHooks.session.create.after).toBe("function");
  });

  it("self-hosted (local_trusted) STILL auto-provisions the first user via the same hooks", () => {
    const built = buildBetterAuthConfig(db, { ...cloudAuthCfg, deploymentMode: "local_trusted" }, [], "s") as any;
    expect(typeof built.databaseHooks.user.create.after).toBe("function");
    expect(typeof built.databaseHooks.session.create.after).toBe("function");
  });
});
