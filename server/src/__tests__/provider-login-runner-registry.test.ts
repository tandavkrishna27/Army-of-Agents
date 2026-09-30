/**
 * The interactive-login RUNNER REGISTRY (review I-2).
 *
 * Separate file because it needs the opposite mock topology to
 * provider-login-routes.test.ts: there `commander-login.js` is REAL (the
 * lifecycle is under test) and `commander-login-runtime.js` is stubbed; here
 * the runtime is REAL and `createCommanderLoginService` is intercepted purely
 * to capture the provider-dispatch deps it is handed.
 *
 * What this pins, and why it is not covered elsewhere:
 *
 *   1. `requireLoginRunner` THROWS for an unregistered provider. This throw is
 *      the entire guard against spawning the wrong provider's CLI against the
 *      wrong credential home. Before Task 9b the dispatch was
 *      `provider === "openai" ? codex : claude`, whose ELSE branch was correct
 *      only because the type was narrowed to those two members — widening it to
 *      the catalog's `ProviderId` in that same change ARMED that else branch, so
 *      the explicit throw replaced it. Nothing else in the suite asserts it, and
 *      a future "helpful" default fallback would restore the hazard with a fully
 *      green suite.
 *   2. All three dispatch seams — authHome, spawn, credential evidence — go
 *      through it. Getting one right and one wrong is the realistic mistake.
 *   3. `hasLoginRunner` is a VALUE check (review M-1). `google: undefined` is the
 *      half-finished Stage B edit the gate exists to catch, and `hasOwnProperty`
 *      would wave it through.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  commanderLoginChallenges: makeTableProxy("commander_login_challenges"),
}));

/** Captures the deps `buildCommanderLoginService` hands the lifecycle. */
const capturedDeps = vi.hoisted(() => ({
  current: null as null | Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../services/commander-login.js", () => ({
  createCommanderLoginService: (deps: Record<string, (...args: never[]) => unknown>) => {
    capturedDeps.current = deps;
    return {};
  },
}));

import {
  buildCommanderLoginService,
  hasLoginRunner,
  requireLoginRunner,
} from "../services/commander-login-runtime.js";

type Deps = {
  resolveAuthHome: (
    provider: string,
    env: NodeJS.ProcessEnv,
    scope: { companyId: string; userId: string; executionTargetId: string | null },
  ) => string;
  runLogin: (provider: string, args: { runId: string; env: NodeJS.ProcessEnv }) => unknown;
  credentialPresent: (provider: string, authHome: string) => Promise<boolean>;
};

function deps(): Deps {
  buildCommanderLoginService({} as never);
  if (!capturedDeps.current) throw new Error("deps were not captured");
  return capturedDeps.current as unknown as Deps;
}

describe("login runner registry", () => {
  let aoaHome: string;

  beforeEach(() => {
    capturedDeps.current = null;
    aoaHome = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-login-registry-"));
  });

  afterEach(() => {
    fs.rmSync(aoaHome, { recursive: true, force: true });
  });

  /* ── hasLoginRunner ─────────────────────────────────────────────────── */

  it("reports the two wired providers as drivable", () => {
    expect(hasLoginRunner("openai")).toBe(true);
    expect(hasLoginRunner("anthropic")).toBe(true);
  });

  it("reports an unwired catalog provider as NOT drivable", () => {
    // `google` is a real catalog id with a real `manualLoginCommand` and NO
    // runner — the exact shape the start route must answer with a 400.
    expect(hasLoginRunner("google")).toBe(false);
    expect(hasLoginRunner("pi")).toBe(false);
    expect(hasLoginRunner("cursor")).toBe(false);
  });

  it("reports a provider id that is not in the catalog at all as NOT drivable", () => {
    expect(hasLoginRunner("nope")).toBe(false);
  });

  /* ── requireLoginRunner ─────────────────────────────────────────────── */

  it("returns a COMPLETE runner for each wired provider, with distinct credential files", () => {
    const codex = requireLoginRunner("openai");
    const claude = requireLoginRunner("anthropic");
    // Codex P1 #9: the credential-evidence file is per-provider. Both being
    // auth.json would make a Claude login report `completed` off Codex's file.
    expect(codex.credentialFileName).toBe("auth.json");
    expect(claude.credentialFileName).toBe(".credentials.json");
    expect(codex.credentialFileName).not.toBe(claude.credentialFileName);
    for (const runner of [codex, claude]) {
      expect(typeof runner.runLogin).toBe("function");
    }
  });

  it("THROWS for an unregistered provider rather than defaulting to one", () => {
    // The load-bearing assertion of this file. A default here would spawn some
    // other provider's CLI against some other provider's credential home.
    expect(() => requireLoginRunner("google" as never)).toThrow(
      /no interactive login runner/i,
    );
  });

  /* ── the dispatch seams the lifecycle actually calls ────────────────── */

  it("resolves a REAL authHome for a wired provider", () => {
    const home = deps().resolveAuthHome(
      "openai",
      { AOA_HOME: aoaHome },
      { companyId: "c1", userId: "u1", executionTargetId: "target-1" },
    );
    expect(home).toMatch(/[\\/]openai$/);
  });

  it("routes each provider to its OWN authHome", () => {
    const d = deps();
    const env = { AOA_HOME: aoaHome };
    const scope = { companyId: "c1", userId: "u1", executionTargetId: "target-1" };
    expect(d.resolveAuthHome("openai", env, scope)).toMatch(/[\\/]openai$/);
    expect(d.resolveAuthHome("anthropic", env, scope)).toMatch(/[\\/]anthropic$/);
  });

  it("THROWS from resolveAuthHome for an unregistered provider", () => {
    expect(() =>
      deps().resolveAuthHome(
        "google",
        {},
        { companyId: "c1", userId: "u1", executionTargetId: "target-1" },
      ),
    ).toThrow(/no interactive login runner/i);
  });

  it("THROWS from runLogin for an unregistered provider — never spawns a CLI", () => {
    expect(() => deps().runLogin("google", { runId: "r1", env: {} })).toThrow(
      /no interactive login runner/i,
    );
  });

  it("REJECTS from credentialPresent for an unregistered provider", async () => {
    // Not merely "returns false": a false here would be read as "the login did
    // not complete", quietly mislabelling the outcome instead of surfacing the
    // configuration error.
    await expect(deps().credentialPresent("google", "/tmp/whatever")).rejects.toThrow(
      /no interactive login runner/i,
    );
  });

  it("reports credential absence (not a throw) for a WIRED provider", async () => {
    await expect(
      deps().credentialPresent("openai", "/tmp/definitely-not-a-real-auth-home"),
    ).resolves.toBe(false);
  });
});
