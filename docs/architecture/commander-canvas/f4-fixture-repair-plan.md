# F4 blocked-task fixture repair implementation plan

**Latest readiness (September 13):** [Base integration and adoption](base-integration-results.md) are complete with full local qualification, required PR CI and exact source comparison. The existing Universe branch now contains the verified replatform landing. TK's requested discussion and explicit batch approval remain before feature implementation. Earlier dated preparation results below are historical.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

**Execution update:** TK selected Codex review and approved the bounded repair/check batch. [Results](f4-repair-results.md) record local commit 4aebfa0f4, 12 passing lifecycle cases, corrected strict typecheck and 11 passing integrations. Task 4 full qualification remains separately unapproved. Unchecked proposal steps below are not the execution ledger; the results report is authoritative. The external typecheck config shown below is corrected to the successful form; the original failed form and logs remain in evidence.

> **For agentic workers:** Use `superpowers:executing-plans` after TK explicitly approves source authoring and the bounded checks below. This document is a reviewed proposal, not execution approval. Steps remain unchecked until observed.

**Goal:** Make the blocked-task database fixture fail honestly on startup and clean up only resources it owns, preserving all four task assertions.

**Architecture:** A small injected, test-only lifecycle helper owns startup and disposal. The integration fixture supplies the actual PostgreSQL, migration, seed and client operations; deterministic tests exercise failure paths without replacing the task service or its assertions.

**Tech Stack:** Existing TypeScript, Vitest, embedded-postgres, postgres-js and Drizzle. No package, application or schema change.

**Spec:** [F4 evidence and original repair requirements](fixture-repair-plan.md), [installed-source attribution](fixture-static-evidence.json), [latest diagnostic outcome](fixture-loader-check-results.md).

## Global constraints and decision

- Proposed authoring base: local `b5cc42643223c433a8263564c7142761472a13d9`, descendant of replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. Proposed isolated branch: `codex/universe-f4-fixture-repair`. Neither is adopted by Universe here.
- Universe retains source pin `183e46a9c65fc3105c7e3d125629276814df7dbb`. Preserve the original checkout, previous correction commits and excluded premature draft.
- This explicitly proposes expanding Stage B's former one-file F4 boundary to three **test-only** files, to make falsy rejection and cleanup faults independently testable. No general fixture framework or dependency patch.
- F5 backup source, timeout and assertions stay unchanged. Its timeout was not reproduced; successful diagnostics do not establish a repair. The original backup test remains required in qualification.
- Retain blocked-task setup/teardown bounds of 180/60 seconds, its Windows skip and its four original business assertions. No retry loop, worker reduction, new skip or timeout increase.
- Codex authors evidence; TK accepts execution scope and product readiness; TK supplies independent Claude review. Source push, upstream landing, base adoption and Universe implementation are separate actions.

## Exact file boundary

| Action | Repository path | Responsibility |
|---|---|---|
| Create | `server/src/__tests__/helpers/blocked-task-fixture.ts` | Own startup/disposal state; preserve failure cause; serialize cleanup |
| Create | `server/src/__tests__/blocked-task-fixture.test.ts` | Deterministic lifecycle faults and occupied-port regression |
| Modify | `server/src/__tests__/blocked-task-scan.integration.test.ts` | Adapt real resources to helper; remove swallowed setup-error protocol |
| Read unchanged | `server/src/__tests__/helpers/embedded-pg-port.ts` | Existing free-port probe |
| Read unchanged | `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts` | Original backup qualification; no diagnostic patch in repair commit |

All source paths below are relative to the future isolated correction checkout. Code blocks are proposed contents, not compiled or executed source.

## Task 1 — failure-safe fixture lifecycle

**Consumes:** injected resource operations and existing port allocator. **Produces:** `createBlockedTaskFixture<T extends object>(deps)` with `start(): Promise<T>` and `dispose(): Promise<void>`; no application exports.

- [ ] Create the regression file first with the test code below. An initial missing-module failure is scaffolding evidence only. The deliberate negative controls later establish that tests detect the relevant behavioral regressions.
- [ ] Create `helpers/blocked-task-fixture.ts` with this implementation:

```ts
export type FixturePostgres = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
export type FixtureDependencies<T extends object> = {
  createDirectory(): Promise<string>;
  allocatePort(): Promise<number>;
  createPostgres(directory: string, port: number): Promise<FixturePostgres>;
  migrate(url: string): Promise<void>;
  connect(url: string): T;
  seed(db: T): Promise<void>;
  closeDb(db: T): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
};

export function createBlockedTaskFixture<T extends object>(d: FixtureDependencies<T>) {
  let directory: string | undefined;
  let pg: FixturePostgres | undefined;
  let db: T | undefined;
  let started = false;
  let closing = false;
  let startup: Promise<T> | undefined;
  let disposal: Promise<void> | undefined;
  let stage = "not started";

  function active() {
    if (closing) throw new Error("Fixture disposal requested during startup");
  }
  async function initialise(): Promise<T> {
    try {
      stage = "directory";
      directory = await d.createDirectory(); active();
      stage = "port";
      const port = await d.allocatePort(); active();
      stage = "construct";
      pg = await d.createPostgres(directory, port); active();
      stage = "initialise";
      await pg.initialise(); active();
      stage = "start";
      await pg.start();
      started = true;
      active();
      const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
      stage = "migrate";
      await d.migrate(url); active();
      stage = "connect";
      db = d.connect(url); active();
      stage = "seed";
      await d.seed(db); active();
      return db;
    } catch (cause) {
      throw new Error(`Blocked-task fixture failed during ${stage}`, { cause });
    }
  }
  function start(): Promise<T> {
    if (closing) return Promise.reject(new Error("Fixture has been disposed"));
    return startup ??= initialise();
  }
  function dispose(): Promise<void> {
    closing = true;
    return disposal ??= (async () => {
      // Observe pending startup before cleaning up its resources. Its original
      // rejection still reaches the caller of start()/Vitest beforeAll.
      if (startup) await startup.catch(() => undefined);
      const errors: unknown[] = [];
      if (db) {
        try { await d.closeDb(db); } catch (error) { errors.push(error); }
      }
      if (started && pg) {
        try { await pg.stop(); started = false; }
        catch (error) { errors.push(error); }
      }
      // A failed stop must never be followed by deletion of a live cluster.
      if (directory && !started && errors.length === 0) {
        try { await d.removeDirectory(directory); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Blocked-task fixture cleanup failed");
    })();
  }
  return { start, dispose };
}
```

`started` means the library's startup promise resolved, not merely that its constructor returned. Installed-source evidence shows bare rejection occurs after the child closes; avoiding `stop()` there prevents waiting for a second exit event. This is specific to the inspected dependency version. If a different failure can leave a live child before successful start, stop the isolated container, retain its directory/logs and investigate; do not infer ownership from a port or use private process fields.

Disposal requested while startup is pending waits for that operation and prevents subsequent stages. It cannot cancel a hung library promise. The unchanged hook deadlines report failure; the outer container boundary terminates residual processes. Do not claim `Promise.race` or a hook timeout cancels PostgreSQL. A failing close still attempts owned-cluster shutdown; any cleanup error remains visible and preserves the directory.

### Deterministic tests

Create `server/src/__tests__/blocked-task-fixture.test.ts`:

```ts
import { createServer } from "node:net";
import { expect, it, vi } from "vitest";
import { createBlockedTaskFixture } from "./helpers/blocked-task-fixture.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

function harness() {
  const events: string[] = [];
  const step = (name: string) => vi.fn(async () => { events.push(name); });
  const db = { fixture: true };
  const pg = { initialise: step("initialise"), start: step("start"), stop: step("stop") };
  const d = {
    createDirectory: vi.fn(async () => { events.push("directory"); return "/fixture-owned"; }),
    allocatePort: vi.fn(async () => { events.push("port"); return 58300; }),
    createPostgres: vi.fn(async (_directory: string, _port: number) => pg),
    migrate: vi.fn(async (_url: string) => { events.push("migrate"); }),
    connect: vi.fn((_url: string) => { events.push("connect"); return db; }),
    seed: vi.fn(async (_db: typeof db) => { events.push("seed"); }),
    closeDb: vi.fn(async (_db: typeof db) => { events.push("close"); }),
    removeDirectory: vi.fn(async (_dir: string) => { events.push("remove"); }),
  };
  return { events, db, pg, d, f: createBlockedTaskFixture(d) };
}

it("starts once and disposes once in ownership order", async () => {
  const h = harness();
  expect(await h.f.start()).toBe(h.db);
  expect(await h.f.start()).toBe(h.db);
  await Promise.all([h.f.dispose(), h.f.dispose()]);
  expect(h.events).toEqual(["directory", "port", "initialise", "start", "migrate", "connect", "seed", "close", "stop", "remove"]);
  expect(h.d.createPostgres).toHaveBeenCalledWith("/fixture-owned", 58300);
  expect(h.d.migrate).toHaveBeenCalledWith("postgres://test:test@127.0.0.1:58300/postgres");
  expect(h.d.connect).toHaveBeenCalledWith("postgres://test:test@127.0.0.1:58300/postgres");
});

it.each([undefined, new Error("bind failed")])("fails closed on rejected start: %s", async cause => {
  const h = harness(); h.pg.start.mockRejectedValueOnce(cause);
  await expect(h.f.start()).rejects.toMatchObject({ message: "Blocked-task fixture failed during start", cause });
  await h.f.dispose();
  expect(h.d.migrate).not.toHaveBeenCalled();
  expect(h.d.connect).not.toHaveBeenCalled();
  expect(h.d.seed).not.toHaveBeenCalled();
  expect(h.pg.stop).not.toHaveBeenCalled();
  expect(h.d.removeDirectory).toHaveBeenCalledOnce();
});

it("does not stop after init failure", async () => {
  const h = harness(); h.pg.initialise.mockRejectedValueOnce(new Error("init failed"));
  await expect(h.f.start()).rejects.toThrow("during initialise");
  await h.f.dispose(); expect(h.pg.stop).not.toHaveBeenCalled();
});
it("stops a started cluster after migration failure without an unacquired client", async () => {
  const h = harness(); h.d.migrate.mockRejectedValueOnce(new Error("migration failed"));
  await expect(h.f.start()).rejects.toThrow("during migrate");
  await h.f.dispose();
  expect(h.d.closeDb).not.toHaveBeenCalled(); expect(h.pg.stop).toHaveBeenCalledOnce();
});
it("closes client before stopping after seed failure", async () => {
  const h = harness(); h.d.seed.mockRejectedValueOnce(new Error("seed failed"));
  await expect(h.f.start()).rejects.toThrow("during seed");
  await h.f.dispose(); expect(h.events.slice(-3)).toEqual(["close", "stop", "remove"]);
});
it("still stops after client-close failure and retains cleanup error and directory", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("close failed");
  h.d.closeDb.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
  expect(h.pg.stop).toHaveBeenCalledOnce(); expect(h.d.removeDirectory).not.toHaveBeenCalled();
});
it("retains directory and error on stop failure", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("stop failed");
  h.pg.stop.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
  expect(h.d.removeDirectory).not.toHaveBeenCalled();
});
it("does not swallow directory removal failure", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("remove failed");
  h.d.removeDirectory.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
});
it("cannot start after disposal", async () => {
  const h = harness(); await h.f.dispose();
  await expect(h.f.start()).rejects.toThrow("disposed");
  expect(h.d.createDirectory).not.toHaveBeenCalled();
});
it("serializes disposal with pending start and prevents later queries", async () => {
  const h = harness();
  let finish!: () => void; let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  h.pg.start.mockImplementationOnce(() => { entered(); return new Promise<void>(resolve => { finish = resolve; }); });
  const starting = h.f.start();
  const rejection = expect(starting).rejects.toThrow("during start");
  await entry; const disposing = h.f.dispose(); finish();
  await rejection; await disposing;
  expect(h.d.migrate).not.toHaveBeenCalled(); expect(h.d.seed).not.toHaveBeenCalled();
  expect(h.pg.stop).toHaveBeenCalledOnce(); expect(h.d.removeDirectory).toHaveBeenCalledOnce();
});
it("avoids an occupied preferred port without closing its listener", async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    const free = await allocateEmbeddedPgPort(address.port);
    expect(free).not.toBe(address.port); expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});
```

These are 12 cases (the rejection row expands to two). Real port allocation retains the existing probe-to-bind race; exhaustion is a reported environment failure, not grounds to skip or retry.

## Task 2 — bind the original integration fixture

**Files:** modify only `server/src/__tests__/blocked-task-scan.integration.test.ts`. **Consumes:** helper above and unchanged `allocateEmbeddedPgPort`. **Produces:** a real migrated and seeded `Db`, or a thrown setup Error.

- [ ] Import `createBlockedTaskFixture` and `allocateEmbeddedPgPort` from their `.js` helper paths. Remove module `pg`, `dataDir`, random `PORT`, `setupError` and the old catch-and-ignore hooks. Retain `let db: Db`, existing constructor type and identifiers.
- [ ] Supply this adapter and replace the hooks. The company seed is the original SQL; no task-service or assertion change:

```ts
const fixture = createBlockedTaskFixture<Db>({
  createDirectory: () => mkdtemp(join(tmpdir(), "aoa-blocked-scan-test-")),
  allocatePort: () => allocateEmbeddedPgPort(),
  createPostgres: async (directory, port) => {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const Constructor = EmbeddedPostgres as unknown as EmbeddedPostgresCtor;
    return new Constructor({ databaseDir: join(directory, "db"), user: "test", password: "test", port, persistent: false });
  },
  migrate: async url => { await applyPendingMigrations(url); },
  connect: url => createDb(url),
  seed: async database => {
    await database.execute(sql`
      INSERT INTO companies (organization_id, id, name, issue_prefix)
      VALUES ('00000000-0000-0000-0000-000000000001', ${companyId}, 'Blocked Scan Co', 'BSC')
    `);
  },
  closeDb: async database => { await database.$client.end({ timeout: 5 }); },
  removeDirectory: directory => rm(directory, { recursive: true, force: true }),
});
beforeAll(async () => {
  if (process.platform === "win32") return;
  db = await fixture.start();
}, 180_000);
afterAll(async () => { await fixture.dispose(); }, 60_000);
```

- [ ] Remove each `if (setupError)` statement in `beforeEach` and the four tests. Leave the company's task/dependency deletion, `seedTask`, `seedDependency`, IDs and all assertion expressions unchanged. A thrown beforeAll prevents body execution; do not replace it with per-test success/skip guards.
- [ ] Compare the complete diff against the original: four task tests still cover sole completed dependency, one incomplete dependency, multiple incomplete dependencies, and all-terminal done/cancelled dependencies. Keep normal file parallelism for the known competitor test.

## Task 3 — bounded verification proposal, then review the source

This task requires subsequent explicit execution approval. It does not consume prior diagnostic allowances.

- [ ] Verify clean b5 source and create the proposed isolated branch; never reset an existing branch or overwrite a directory. Author only the three allowed source files. Use a fresh Git-backed Linux checkout in the existing isolated runtime configuration; preserve actual HEAD plus the hashed three-file patch for pre-commit checks.
- [ ] Use the immutable Node image, non-root UID/GID 1000, offline task volume and allowlisted environment from [diagnostic results](fixture-loader-check-results.md). Fresh source path `/workspace/f4-repair`; refuse if already present. No live AoA database, host repo/home/socket mount, credentials or package downloads. Setup bound 15 minutes, checks total 60 minutes; stop on infrastructure failure.
- [ ] Offline frozen install and **six** explicit prebuilds, each success-gated, followed by the loader-aware check:

```sh
corepack pnpm install --offline --frozen-lockfile
corepack pnpm --filter @armyofagents/worker-protocol build
corepack pnpm --filter @armyofagents/sandbox-fake-provider build
corepack pnpm --filter @armyofagents/worker-daemon build
corepack pnpm --filter @armyofagents/sandbox-provider-contract build
corepack pnpm --filter @armyofagents/sandbox-e2b-provider build
corepack pnpm --filter @armyofagents/plugin-sdk build
node --import tsx --input-type=module -e "await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"
```

Verify the SDK package name against its pinned manifest before execution; a mismatch stops preparation rather than silently running another package. Use the machine-enforced prerequisite/result checks from the [last executed gate](evidence/fixture-loader-check-2026-09-12/executed-runner.mjs), extended to these exact commands. Require current-attempt source/patch identity, exit 0 and no signal/timeout before dependent launch. An expected negative test result is handled only in its named negative-control phase.

- [ ] Run the test-first missing-module check once before adding the helper, then two deliberate negative controls against the proposed complete code: (a) change the helper's catch `throw new Error(...)` to `return db as T`; (b) restore the helper and change `if (started && pg)` to `if (pg)`. Run the same unit command for each, at most five minutes each:

```sh
corepack pnpm exec vitest run server/src/__tests__/blocked-task-fixture.test.ts
```

The first mutation must fail the rejected-start assertions; the second must fail no-stop-after-failed-start assertions. A module/collection failure is not valid negative-control evidence. Preserve each temporary diff and log, then restore the exact proposed helper bytes. These mutations never enter the repair commit. Run the unit command once on restored source: all 12 cases must pass, no unhandled errors. Do not retry to obtain green.

- [ ] Type-check the new tests explicitly: `server/tsconfig.json` excludes `src/__tests__`, so repository typecheck alone is insufficient. Write `/workspace/evidence/f4-types.json` outside tracked source:

```json
{
  "extends": "/workspace/f4-repair/server/tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"],
    "typeRoots": ["/workspace/f4-repair/server/node_modules/@types", "/workspace/f4-repair/node_modules/@types"]
  },
  "include": [
    "/workspace/f4-repair/server/src/__tests__/helpers/blocked-task-fixture.ts",
    "/workspace/f4-repair/server/src/__tests__/blocked-task-fixture.test.ts",
    "/workspace/f4-repair/server/src/__tests__/blocked-task-scan.integration.test.ts",
    "/workspace/f4-repair/server/src/types/**/*.d.ts"
  ],
  "exclude": []
}
```

Run `corepack pnpm exec tsc --project /workspace/evidence/f4-types.json` (15-minute bound). Attribute imported-source/config failures; do not relax strictness, suppress diagnostics or call transpilation a typecheck pass.

- [ ] After green unit and type checks, run one combined real-DB invocation with unchanged concurrency (15-minute bound):

```sh
corepack pnpm exec vitest run server/src/__tests__/blocked-task-scan.integration.test.ts server/src/__tests__/runtime-provider-keys-with-secret.integration.test.ts packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts
```

Require four blocked-task, five runtime-provider-key and two original backup cases: **11 executed integration cases**, no failed hooks or unhandled errors. Do not filter to the server project and accidentally exclude the DB project. Retain PostgreSQL port logs without connection strings/secrets. Concurrent selection is a stress sample, not proof that startup overlaps or all races are removed.

- [ ] Preserve logs and full tracked manifests, stop the isolated container after the integration command even on failure, and verify stopped/offline state. Do not delete failed-cluster directories; outer containment is required for late-starting work. Record timeouts/forced termination distinctly.
- [ ] Review the three-file diff and assertion preservation; after passing checks, commit only those files locally with message `test: make blocked-task fixture startup and cleanup explicit`. Record the commit, parent, tree and checks' patch identity. Publish documentation/evidence for TK/Claude review; do not push source automatically.

## Task 4 — separately approved clean-commit baseline qualification

After source review, qualify the actual committed repair SHA in a fresh Git-backed offline checkout using the same six-prebuild/export gate. No instrumentation or negative-control mutation. Setup bound 15 minutes; verification bound 150 minutes total, typecheck/build each 30 minutes and each shard 30 minutes within that total.

```sh
corepack pnpm -r typecheck
corepack pnpm exec vitest run --shard=1/4
corepack pnpm exec vitest run --shard=2/4
corepack pnpm exec vitest run --shard=3/4
corepack pnpm exec vitest run --shard=4/4
corepack pnpm build
```

Require successful setup/typecheck before shards. Test assertion failures may be collected across the four independent shards; infrastructure failure, timeout, source drift or unhandled process failure stops further launch. Build requires all four shards passing with no unhandled errors. Stop the container between shards and verify source hashes before restarting; do not recreate or change source/configuration. New tests may change shard placement: reconcile test identities across **all four**, not an assumed shard number. Preserve F1/F2/F3, the 12 new lifecycle/port cases, four F4 cases and both F5 cases; account for every remaining skip. A new F5 timeout stops acceptance and needs attribution, not a blanket timeout increase.

Only a passing full result supports a concrete proposal to land corrections through the replatform workflow and adopt the exact resulting source in Universe. Document upstream owner/path before that action. Never merge b5 or a repair commit merely because this plan names it. Base acceptance still does not authorize Universe coding.

## Author review and exit verdict

The proposal covers occupied port, bare rejection, ordinary rejection, post-start failure, client-close failure, stop failure, late startup and repeat cleanup. The integration adapter preserves actual migrations/company seed and all four assertions. Shutdown failures are visible; tests cannot disguise a startup failure as success. A probe is not a port reservation, and serialized cleanup is not cancellation.

This closes **F4 repair planning for independent review**, not F4 repair. F5 remains an original-test obligation in full qualification. No code, test run, container start, source commit, base adoption or Universe implementation occurred while writing this document.
