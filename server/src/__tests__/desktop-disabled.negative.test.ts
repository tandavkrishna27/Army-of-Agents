// DSK-001 Lane C / I22 — DSK-00 negative closure.
//
// Desktop support must be provably INERT while it is disabled. These are NEGATIVE
// assertions: each one says a desktop surface does NOT exist or does NOT work.
//
// Two of I22's clauses failed when this ticket started (F27 here, F28 in
// execution-target-resolver.test.ts). They were live holes, not test gaps — writing a
// test around the behaviour as it stood would have enshrined it — so the fixes landed
// first and these assertions followed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Org-admin authz passes: it is exercised elsewhere, and isolating it here keeps these
// tests about the DESKTOP gate rather than about permissions.
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg: async () => true }),
}));
vi.mock("../services/execution-targets.js", () => ({
  createWorkerToken: () => "aoa_wtk_test",
  hashWorkerToken: () => "hash-of-token",
  stripWorkerSecret: (row: Record<string, unknown>) => {
    const { workerTokenHash: _omit, ...rest } = row;
    return rest;
  },
  // The list is whatever the fake db holds. D16 REJECTS filtering desktop rows out of
  // GET — that hides an already-enabled row instead of neutralising it, which is worse
  // for incident review. So this returns rows unfiltered ON PURPOSE, and the clause-1
  // assertion below is "creation is blocked, so no desktop row exists to list" — never
  // "the list filters".
  listExecutionTargets: async () => listRows,
  registerWorkerHeartbeat: async () => ({ updated: 1 }),
  rotateExecutionTargetWorkerToken: async () => null,
  revokeExecutionTargetWorkerToken: async () => null,
  resolveWorkerHeartbeatAuthority: async () => null,
}));
vi.mock("@armyofagents/db", () => ({ executionTargets: {} }));

import { executionTargetRoutes } from "../routes/execution-targets.js";
import { errorHandler } from "../middleware/error-handler.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read a source file with line endings normalised.
 *
 * These files are CRLF. A structural scan written against bare LF matches nothing, and
 * reports that as "the mount is not there" — a false NEGATIVE that would have made the
 * clause-2 assertion look satisfied for the worst possible reason. Normalise once.
 */
/** The two-space `}` that closes the flag block in app.ts. */
const BLOCK_CLOSE = ["", "  }", ""].join(String.fromCharCode(10));

const readSource = (...segments: string[]) =>
  readFileSync(join(HERE, ...segments), "utf8").split("\r\n").join("\n");

const FLAG_OPEN = "if (opts.distributedExecutionEnabled) {";

/**
 * Every distributed-execution flag block in app.ts, in source order.
 *
 * ★ This scan used to take `indexOf(FLAG_OPEN)` — the FIRST block — and measure
 * against its close. That was correct only while exactly one such block existed.
 * BRW-003d-1 added a SECOND one: the worker-control body-parser mounts, which
 * must be registered BEFORE the global `express.json()` and therefore cannot
 * share the block that mounts the routes, which is registered after it.
 *
 * The first-occurrence scan then measured the wrong block and reported the route
 * mount as outside the flag — a FALSE ALARM, but the mirror image of the false
 * negative this file's `readSource` comment already warns about. Enumerate the
 * blocks instead, and assert HOW MANY there are, so that adding a third is a
 * deliberate edit to this guard rather than another silent change of meaning.
 */
const flagBlocks = (source: string): Array<{ open: number; close: number }> => {
  const blocks: Array<{ open: number; close: number }> = [];
  for (let from = 0; ; ) {
    const open = source.indexOf(FLAG_OPEN, from);
    if (open === -1) break;
    const close = source.indexOf(BLOCK_CLOSE, open);
    expect(close, "a flag block is never closed by a two-space brace").toBeGreaterThan(open);
    blocks.push({ open, close });
    from = open + FLAG_OPEN.length;
  }
  return blocks;
};

/**
 * True when EVERY occurrence of `needle` in `source` sits inside some flag block.
 *
 * "Every", not "the first". A first-occurrence scan is the exact assumption that
 * broke this file when a second flag block appeared, and repeating it one level
 * down would mean a SECOND mount added outside the flag still reported true.
 */
const mountedInsideAFlagBlock = (source: string, needle: string): boolean => {
  const blocks = flagBlocks(source);
  const positions: number[] = [];
  for (let from = 0; ; ) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    positions.push(at);
    from = at + needle.length;
  }
  expect(positions.length, `${needle} is not mounted at all`).toBeGreaterThan(0);
  return positions.every((at) => blocks.some((b) => at > b.open && at < b.close));
};
const ORG = "77777777-7777-4777-8777-777777777777";
const boardAdmin = { type: "board", source: "session", userId: "operator-9", companyIds: [] };

let listRows: unknown[] = [];
const inserted: Record<string, unknown>[] = [];

/**
 * `workerSession` is the distributed-execution flag, already derived in app.ts as
 * `distributedExecutionEnabled && tenantAppDb && operatorDb && workerSessionSigningKey`.
 * Omitting it here IS the flag-off deployment.
 */
function makeApp({ desktopEnabled }: { desktopEnabled: boolean }) {
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [{ id: "et-1", organizationId: ORG, ...v }];
        },
      }),
    }),
  } as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardAdmin;
    next();
  });
  app.use("/api", executionTargetRoutes({
    db,
    workerSession: desktopEnabled
      ? { appDb: db, operatorDb: db, sessionSigningKey: "x".repeat(32) }
      : undefined,
  }));
  app.use(errorHandler);
  return app;
}

const post = (app: express.Express, kind: string) =>
  request(app).post(`/api/organizations/${ORG}/execution-targets`)
    .send({ slug: `et-${kind.replace(/_/g, "-")}`, kind, trustClass: "local_trusted" });

afterEach(() => {
  vi.clearAllMocks();
  listRows = [];
  inserted.length = 0;
});

describe("I22 clause 1 — flag-off, a desktop execution target cannot be created", () => {
  // F27: executionTargetRoutes is mounted at app.ts:535, 97 lines OUTSIDE the
  // distributed-execution flag block, and the create handler inserted `...input`
  // directly. `kind` accepts "desktop" and `status` defaults to "active", so an org
  // admin could register an ACTIVE desktop target on a deployment where desktop does
  // not exist — and it would then route work to a control-plane run (F28).

  it("REFUSES the create and persists nothing", async () => {
    const res = await post(makeApp({ desktopEnabled: false }), "desktop");
    expect(res.status).toBe(403);
    // The teeth: no row reached the database.
    expect(inserted).toEqual([]);
  });

  it("says WHY, so an operator is not left guessing", async () => {
    const res = await post(makeApp({ desktopEnabled: false }), "desktop");
    // Status asserted too: without it this passes on a 201 whose body merely echoes
    // kind:"desktop" — a test that would have gone green against the hole itself.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/desktop/i);
  });

  it("does NOT refuse other kinds — the gate is desktop-specific, not a blanket ban", async () => {
    // Non-vacuity. A guard that refused everything would pass the assertion above while
    // breaking every deployment.
    const res = await post(makeApp({ desktopEnabled: false }), "local_host");
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });

  it("ALLOWS desktop once distributed execution is enabled", async () => {
    // The other half of non-vacuity: this is a flag, not a permanent prohibition. If
    // this ever fails, the gate has stopped being conditional and DSK-002 is blocked.
    const res = await post(makeApp({ desktopEnabled: true }), "desktop");
    expect(res.status).toBe(201);
  });

  it("GET returns no desktop row, because none can be created", async () => {
    const app = makeApp({ desktopEnabled: false });
    await post(app, "desktop");
    const res = await request(app).get(`/api/organizations/${ORG}/execution-targets`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/"kind":"desktop"/);
  });

  it("GET does NOT filter — an already-enabled row stays visible to incident review", async () => {
    // D16 rejects filtering explicitly. If a desktop row exists (created before the
    // gate, or while the flag was on), hiding it would be strictly worse: an operator
    // reviewing an incident must be able to SEE it. This pins the rejected alternative
    // so nobody "fixes" clause 1 by filtering.
    listRows = [{ id: "old", organizationId: ORG, slug: "legacy", kind: "desktop" }];
    const res = await request(makeApp({ desktopEnabled: false }))
      .get(`/api/organizations/${ORG}/execution-targets`);
    expect(JSON.stringify(res.body)).toMatch(/"kind":"desktop"/);
  });
});

describe("I22 clause 2 — flag-off, the worker-control surface is not mounted at all", () => {
  // Holds today. The proof is STRUCTURAL rather than a live request: booting the whole
  // app to observe a 404 would test express's router, not the property. The property is
  // that the mount is lexically INSIDE the flag block — an unmounted route 404s by
  // construction, and no ordering or middleware change can quietly expose it.
  const appSource = readSource("..", "app.ts");

  it("mounts workerControlRoutes only inside the distributed-execution flag block", () => {
    // Pin the block COUNT. The scan below is only as meaningful as the set it
    // searches, and a new flag block should force a conscious look at this file
    // rather than quietly widening what "inside the flag" is allowed to mean.
    //   1. the worker-control body-parser mounts (BRW-003d-1), before express.json()
    //   2. the route mounts, after it
    expect(flagBlocks(appSource)).toHaveLength(2);
    expect(mountedInsideAFlagBlock(appSource, "workerControlRoutes(")).toBe(true);
  });

  it("★ WRK-010: the session-renew route is REGISTERED in worker-control.ts (dormant by absence)", () => {
    // Dormancy for the renewal route is a CONJUNCTION, and only (a) is this ticket's:
    //   (a) the registration lives in routes/worker-control.ts — OWNED here: red before
    //       Step 4 landed, and red again the day someone relocates it onto a router app.ts
    //       mounts UNCONDITIONALLY (which would break dormancy without touching this needle
    //       via app.ts, so the needle has to be the registration itself).
    //   (b) app.ts mounts workerControlRoutes only inside the flag block — green today, asserted
    //       by the standing test "mounts workerControlRoutes only inside the distributed-execution
    //       flag block" in this describe.
    //   (c) app.ts mounts workerControlRoutes exactly once — green today, asserted by the standing
    //       test "does NOT mount it anywhere else" in this describe.
    // (cited by construct, not line: an inserted test shifts line numbers, and this programme has
    // been bitten by stale line references.)
    // (b) and (c) are PRE-EXISTING, green on the shipped boot root, and cannot be reddened by
    // this ticket's diff. They are restated here BY REFERENCE so the conjunction is visible in
    // one place; neither is the clause — (a) is. A dormancy row backed only by (b)/(c) would be
    // a gate satisfied before the ticket started.
    const workerControlSource = readSource("..", "routes", "worker-control.ts");
    expect(workerControlSource).toContain("/worker-control/session/renew");
    // (b) and (c), restated by reference:
    expect(mountedInsideAFlagBlock(appSource, "workerControlRoutes(")).toBe(true);
    expect(appSource.split("workerControlRoutes(").length - 1).toBe(1);
  });

  it("mounts the DEVICE LISTING inside that block too (D17 / D-D5)", () => {
    // Lane D's listing is flag-gated BY CONSTRUCTION rather than by a guard — the
    // opposite of F27, which needed an explicit desktop refusal because its router sits
    // outside. If this router ever moves out, the listing becomes reachable flag-off and
    // DSK-00 clause (a) stops holding for it.
    expect(mountedInsideAFlagBlock(appSource, "desktopDeviceRoutes(")).toBe(true);
  });

  it("does NOT mount it anywhere else", () => {
    // A second mount outside the block would reopen the surface while the first
    // assertion still passed.
    const mounts = appSource.split("workerControlRoutes(").length - 1;
    expect(mounts).toBe(1);
  });

  it("proves the assertion is non-vacuous: executionTargetRoutes is OUTSIDE that block", () => {
    // The control case, and the reason clause 1 needed a code fix at all. If this ever
    // starts failing because the route moved inside the block, the create guard becomes
    // redundant — which is worth knowing, not worth hiding.
    // ★ This assertion used to read `mount > close` against the FIRST flag block.
    // Once BRW-003d-1 added a second block that scan silently changed meaning: it
    // began proving the mount is after the PARSER block, which is true of almost
    // everything in app.ts, rather than that it is outside the ROUTE block. It
    // still passed — which is why it had to be found by reading rather than by a
    // red test. Ask the real question instead: outside EVERY flag block.
    expect(mountedInsideAFlagBlock(appSource, "executionTargetRoutes(")).toBe(false);
  });
});

describe("WRK-011 — the self-hello-refresh route is dormant when distributed execution is off", () => {
  // ★ WEAKER than /worker-control/'s dormancy, and this test says so (design §3.3).
  // executionTargetRoutes is mounted OUTSIDE app.ts's flag block (app.ts:588), so the
  // hello-refresh route's absence flag-off rests on ONE conditional registration —
  // `if (opts.workerSession) router.post("/execution-targets/self/hello", …)` — not on a
  // structural non-mount. Proving it by SOURCE SCAN is the strongest available proof; a
  // 404-on-an-unmounted-router test would only prove express's router, not the property.
  const routesSource = readSource("..", "routes", "execution-targets.ts");
  const HELLO_PATH = '"/execution-targets/self/hello"';

  // True iff the `router.post(` registering `pathLiteral` is immediately preceded by the
  // `if (opts.workerSession)` conditional (M18 deletes that conditional).
  const registrationGuardedByWorkerSession = (pathLiteral: string): boolean => {
    const at = routesSource.indexOf(pathLiteral);
    expect(at, `${pathLiteral} is not registered at all`).toBeGreaterThan(0);
    const post = routesSource.lastIndexOf("router.post(", at);
    expect(post).toBeGreaterThan(0);
    return routesSource.slice(Math.max(0, post - 40), post).includes("if (opts.workerSession)");
  };

  it("★ registers the hello-refresh route ONLY under if (opts.workerSession) (M18)", () => {
    expect(routesSource).toContain(HELLO_PATH);
    expect(registrationGuardedByWorkerSession(HELLO_PATH)).toBe(true);
  });

  it("proves the scan is non-vacuous: the ALWAYS-mounted heartbeat route is NOT behind that guard", () => {
    // If this ever flips true, either the heartbeat route was gated (a behaviour change) or
    // the scan is matching the wrong registration — both worth a red.
    expect(registrationGuardedByWorkerSession('"/execution-targets/heartbeat"')).toBe(false);
  });
});

describe("I22 clause 5 — no desktop option can reach the environments UI", () => {
  // `ui/` contains ~104 occurrences of "desktop" and every one is a responsive
  // breakpoint ("desktop tier", "desktop width"), so a grep-based check would be pure
  // noise. The real property is narrower and stronger.
  const uiSource = readSource(
    "..", "..", "..", "ui", "src", "components", "settings", "sections", "EnvironmentsSection.tsx",
  );

  it("offers a CLOSED set of target types that does not include desktop", () => {
    const union = /type EnvTargetType = ([^;]+);/.exec(uiSource);
    expect(union, "EnvTargetType union not found — the shape changed").not.toBeNull();
    const members = [...union![1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(2); // the scan found a real union
    expect(members).not.toContain("desktop");
  });

  it("does NOT derive its options from EXECUTION_TARGET_KINDS", () => {
    // This is the half that keeps clause 5 true tomorrow. The union above is hardcoded,
    // so adding "desktop" to the shared kind constant cannot make an option appear. If
    // the UI ever starts mapping over that constant, a desktop option would render the
    // day DSK-002 lands — silently.
    expect(uiSource).not.toContain("EXECUTION_TARGET_KINDS");
  });
});

describe("I22 — the seven clauses are closed, and each names where it is proven", () => {
  // A manifest, so "DSK-00 is closed" is auditable in one place instead of being spread
  // across three files and a CI script. A clause with nowhere to point is a clause
  // nobody is asserting.
  const WHERE: Record<number, string> = {
    1: "this file — flag-off create is refused 403 and persists nothing",
    2: "this file — workerControlRoutes is mounted only inside the flag block",
    3: "execution-target-resolver.test.ts — desktop/e2b/unknown kinds THROW",
    4: "execution-target-resolver.test.ts — no-pin routing never returns desktop",
    5: "this file — the environments UI union is closed and not kind-derived",
    6: "scripts/check-desktop-surface-disabled.mjs — the distribution.md doc pin",
    7: "scripts/check-desktop-surface-disabled.mjs — no desktop package/update route",
  };

  it("accounts for all seven", () => {
    expect(Object.keys(WHERE).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const [clause, where] of Object.entries(WHERE)) {
      expect(where, `clause ${clause} has no home`).toMatch(/\S/);
    }
  });
});
