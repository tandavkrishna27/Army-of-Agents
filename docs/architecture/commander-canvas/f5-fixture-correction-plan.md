# F5 backup fixture startup and cleanup implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for the approved source batch. This is a self-reviewed source proposal; unchecked steps are not execution evidence.

**Execution update:** The approved three-file correction, targeted checks and conditional full verification are completed; see [F5 results](f5-repair-results.md). Unchecked proposal steps below are historical planning text; the result ledger is execution evidence. Source publication/landing, base adoption and Universe implementation remain separate.

**Goal:** Give real backup tests a bounded startup policy and cleanup ownership that survives setup expiry, while preserving both backup/restore assertions.

**Architecture:** A database-package test helper sequences named setup operations, stops progression after disposal, and observes pending startup before cleanup. The integration test owns its actual PostgreSQL instance, client and temporary directories. No general fixture framework or server-to-database test import.

**Tech stack:** Existing TypeScript, Vitest, embedded-postgres and postgres-js; no dependency changes.

**Spec:** [Measured F5 diagnostic](f5-attribution-results.md), [failed full qualification](full-baseline-qualification-results.md). These retain the failure and distinguish observed storage waits from unproved attribution of the earlier ten-second stall.

## Scope, base and finite budgets

The current request authorizes preparing and reviewing this concrete follow-up. Source authoring and its checks require the explicit bounded approval below, consistent with TK's earlier planning boundary. Universe feature implementation, source push, replatform landing and base adoption are excluded.

- Authoring base: local `4aebfa0f4aaf011cfd85347246c18d3cbde305ba`, containing the earlier reviewed baseline repairs on replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. Use isolated `codex/universe-f5-fixture-repair`; never reset existing worktrees or adopt a newer upstream head automatically.
- Exactly three source files: create `packages/db/src/__tests__/helpers/backup-fixture.ts`; create `packages/db/src/__tests__/backup-fixture.test.ts`; modify `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts` setup/teardown only.
- No change to `backup-lib.ts`, package manifests, lockfile, PostgreSQL flags, root/project Vitest configuration, concurrency or either integration test body. Keep the existing Windows integration skip; pure lifecycle tests run on every platform.
- **Startup policy: 30,000 ms** inside the helper; **35,000 ms beforeAll** as runner backstop. **Cleanup policy: 25,000 ms** inside helper; retain **30,000 ms afterAll**. No automatic retry. The root runner already declares a 30-second hook policy, while the database project has no explicit hook setting and the observed original fixture timed out at ten seconds. Set the fixture explicitly rather than depending on project inheritance.
- Thirty seconds is a proposed finite engineering allowance, not a measured worst-case bound: successful initialization samples ranged from 2.174 to 6.038 seconds and the failed run exceeded ten seconds. Preserve disk synchronization and prove the policy deterministically; clean qualification must still pass.
- A deadline rejects the caller and prevents later phases; **it cannot kill embedded-postgres's private initdb child**. Disposal observes the original promise and cleans late success. If it never settles, cleanup fails at its own bound and the isolated runtime must be stopped. No claim of guaranteed in-process cancellation or successful cleanup after a hang.

## Task 1 — bounded lifecycle with late-completion tests

**Consumes:** named asynchronous fixture operations and one ownership-aware cleanup callback. **Produces:** `createBackupFixture(steps, cleanup, budgets)` returning memoized `start()` and `dispose()` promises. The helper has no PostgreSQL or filesystem knowledge.

- [ ] Add the tests below first. A missing-module result is only scaffolding evidence; behavioral negative controls below are required.
- [ ] Add the proposed helper implementation:

```ts
export type BackupStep = { name: string; run(): Promise<void> };
export type BackupBudgets = { startupMs: number; cleanupMs: number };
export function createBackupFixture(
  steps: BackupStep[], cleanup: () => Promise<void>,
  budgets: BackupBudgets = { startupMs: 30_000, cleanupMs: 25_000 },
) {
  let closing = false;
  let stage = "not started";
  let rawStartup: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  function bound(work: Promise<void>, ms: number, expired: () => Error) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(expired()), ms);
      work.then(
        () => { clearTimeout(timer); resolve(); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
  function active() {
    if (closing) throw new Error("Backup fixture disposal requested");
  }
  function start(): Promise<void> {
    if (closing) return Promise.reject(new Error("Backup fixture disposed"));
    if (startup) return startup;
    rawStartup = (async () => {
      try {
        for (const step of steps) {
          active(); stage = step.name;
          await step.run(); active();
        }
      } catch (cause) {
        throw new Error(`Backup fixture setup failed during ${stage}`, { cause });
      }
    })();
    startup = bound(rawStartup, budgets.startupMs, () => {
      closing = true;
      return new Error(`Backup fixture setup exceeded ${budgets.startupMs}ms during ${stage}`);
    });
    return startup;
  }
  function dispose(): Promise<void> {
    closing = true;
    if (disposal) return disposal;
    const cleanupWork = (async () => {
      if (rawStartup) await rawStartup.catch(() => undefined);
      await cleanup();
    })();
    disposal = bound(cleanupWork, budgets.cleanupMs, () =>
      new Error(`Backup fixture cleanup exceeded ${budgets.cleanupMs}ms; last setup stage ${stage}`));
    return disposal;
  }
  return { start, dispose };
}
```

`bound` keeps fulfillment/rejection observers attached after expiry, so a late rejection is observed. `dispose` waits for the **raw** setup chain, not the already-expired public promise. Never replace that wait with `Promise.race` followed by unsafe deletion.

Use this deterministic test harness and cases in `backup-fixture.test.ts`:

```ts
import { afterEach, expect, it, vi } from "vitest";
import { createBackupFixture } from "./helpers/backup-fixture.js";
afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(pending: "initialise" | "start" | "seed" = "initialise") {
  const gate = deferred(), entered = deferred();
  const events: string[] = [];
  let started = false;
  const cleanup = vi.fn(async () => {
    if (started) events.push("stop");
    events.push("remove");
  });
  const f = createBackupFixture(["initialise", "start", "seed"].map(name => ({
    name, async run() {
      events.push(name);
      if (name === pending) { entered.resolve(); await gate.promise; }
      if (name === "start") started = true;
    },
  })), cleanup, { startupMs: 30_000, cleanupMs: 25_000 });
  return { f, gate, entered, events, cleanup };
}
it.each(["initialise", "start", "seed"] as const)("owns late %s completion", async phase => {
  vi.useFakeTimers(); const h = harness(phase);
  const starting = h.f.start();
  const rejection = expect(starting).rejects.toThrow(`during ${phase}`);
  await h.entered.promise;
  await vi.advanceTimersByTimeAsync(30_000); await rejection;
  const disposing = h.f.dispose();
  expect(h.cleanup).not.toHaveBeenCalled();
  h.gate.resolve(); await disposing;
  expect(h.events).toEqual(phase === "initialise"
    ? ["initialise", "remove"] : phase === "start"
    ? ["initialise", "start", "stop", "remove"]
    : ["initialise", "start", "seed", "stop", "remove"]);
  await h.f.dispose(); expect(h.cleanup).toHaveBeenCalledOnce();
});
it("reports cleanup expiry without deleting pending initialization", async () => {
  vi.useFakeTimers(); const h = harness();
  const rejected = expect(h.f.start()).rejects.toThrow("during initialise");
  await h.entered.promise; await vi.advanceTimersByTimeAsync(30_000); await rejected;
  const failedCleanup = expect(h.f.dispose()).rejects.toThrow("cleanup exceeded");
  await vi.advanceTimersByTimeAsync(25_000); await failedCleanup;
  expect(h.cleanup).not.toHaveBeenCalled();
  // Release synthetic work; never leave an actual test process hung.
  h.gate.resolve(); await vi.runAllTimersAsync();
  expect(h.cleanup).toHaveBeenCalledOnce();
});
it("accepts slow successful setup once within its explicit budget", async () => {
  vi.useFakeTimers(); const h = harness(); const starting = h.f.start();
  expect(h.f.start()).toBe(starting);
  await h.entered.promise; await vi.advanceTimersByTimeAsync(12_000);
  h.gate.resolve(); await starting; await h.f.dispose();
  expect(h.events).toEqual(["initialise", "start", "seed", "stop", "remove"]);
});
it.each([undefined, new Error("init failure")])("retains rejection cause %s", async cause => {
  const h = harness(); const rejected = expect(h.f.start()).rejects.toMatchObject({ cause });
  await h.entered.promise; h.gate.reject(cause); await rejected;
  await h.f.dispose(); expect(h.events).toEqual(["initialise", "remove"]);
});
it("does not swallow cleanup failure", async () => {
  const h = harness(); h.gate.resolve(); await h.f.start();
  const error = new Error("cleanup fault"); h.cleanup.mockRejectedValueOnce(error);
  await expect(h.f.dispose()).rejects.toBe(error);
  expect(h.cleanup).toHaveBeenCalledOnce();
});
it("cannot allocate after disposal", async () => {
  const h = harness(); await h.f.dispose();
  await expect(h.f.start()).rejects.toThrow("disposed");
  expect(h.events).toEqual(["remove"]);
});
```

- [ ] Run this test file once before helper authoring, once after. Mutate only the isolated candidate to remove the post-await `active()` check; late-initialise must wrongly proceed and fail its assertion. Restore the helper. Mutate `dispose()` to await public `startup` instead of `rawStartup`; the pending-resource test must fail. Restore before final checks. These deliberate red runs are evidence, never a qualifying source tree.
- [ ] Typecheck the database package; its existing tsconfig includes `src`, including these tests and helper. No external temporary tsconfig is needed for this package.

## Task 2 — bind actual resource ownership

**Consumes:** Task 1 helper and existing `allocatePort()` in the backup test. **Produces:** same `backupDir` and `connectionString` used by the untouched two test bodies, with explicit setup/disposal.

- [ ] Import the helper. Replace the fixture declarations and hooks before the first `it` with named operations matching the following binding. Keep `allocatePort`, suite label, existing imports and Windows guard.

```ts
let dataDir: string | undefined;
let backupDir: string;
let connectionString: string;
let pg: EmbeddedPostgres | undefined;
let client: ReturnType<typeof postgres> | undefined;
let port: number;
let initialised = false, startAttempted = false, started = false;
const fixture = createBackupFixture([
  { name: "data-directory", async run() {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-backup-test-"));
  } },
  { name: "backup-directory", async run() {
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-backup-files-"));
  } },
  { name: "port", async run() { port = await allocatePort(); } },
  { name: "initialise", async run() {
    pg = new EmbeddedPostgres({ databaseDir: dataDir!, port, password: "postgres" });
    await pg.initialise(); initialised = true;
  } },
  { name: "start", async run() {
    startAttempted = true;
    await pg!.start(); started = true;
  } },
  { name: "create-database", async run() { await pg!.createDatabase("aoa_test"); } },
  { name: "connect", async run() {
    connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/aoa_test`;
    client = postgres(connectionString);
  } },
  { name: "schema", async run() { const sql = client!; await sql`CREATE SCHEMA drizzle`; } },
  { name: "journal-table", async run() { const sql = client!;
    await sql`CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text, created_at bigint)`;
  } },
  { name: "journal-row", async run() { const sql = client!;
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('test_hash', 1234567890)`;
  } },
  { name: "users-table", async run() { const sql = client!;
    await sql`CREATE TABLE public.test_users (id serial PRIMARY KEY, name text)`;
  } },
  { name: "users-row", async run() { const sql = client!;
    await sql`INSERT INTO public.test_users (name) VALUES ('alice wonderland')`;
  } },
  { name: "close-seed-client", async run() { await client!.end(); client = undefined; } },
], () => cleanupBackupResources({
  closeClient: client ? () => client!.end({ timeout: 5 }) : undefined,
  stop: started ? () => pg!.stop() : undefined,
  unsafe: startAttempted && !started ? "start failed; retain directories"
    : pg && !initialised ? "initialization incomplete; retain directories" : undefined,
  directories: [dataDir, backupDir].filter((value): value is string => !!value),
  remove: directory => fs.rm(directory, { recursive: true, force: true }),
}));
beforeAll(() => fixture.start(), 35_000);
afterAll(() => fixture.dispose(), 30_000);
```

The two filesystem paths come only from this fixture's successful `mkdtemp` calls. No host cleanup script or computed repository path is involved. Retaining data after uncertain startup is intentional and must be reported as cleanup failure, not a successful teardown. Closing a seed client uses a five-second postgres-js allowance, inside the broader cleanup deadline. The two original test bodies retain their current connection behavior; broader query-client refactoring is excluded.

- [ ] Check resource ownership against the binding: late successful `start` sets `started` before the helper checks disposal; a failed seed still owns `client`; close failure retains `client`; stop failure prevents directory removal; raw initialization must settle before cleanup can remove anything.
- [ ] Export the cleanup function below from the same helper file and import it alongside `createBackupFixture` in the integration fixture. Test it with injected operations, without importing the real backup suite. The binding passes only acquired resources; an uncertain start uses `unsafe` and never calls the installed library's potentially hanging stop path.

```ts
export async function cleanupBackupResources(owner: {
  closeClient?: () => Promise<void>;
  stop?: () => Promise<void>;
  unsafe?: string;
  directories: string[];
  remove(directory: string): Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  if (owner.closeClient) {
    try { await owner.closeClient(); } catch (error) { errors.push(error); }
  }
  if (owner.stop) {
    try { await owner.stop(); } catch (error) { errors.push(error); }
  }
  if (owner.unsafe) errors.push(new Error(owner.unsafe));
  if (errors.length === 0) {
    for (const directory of owner.directories) {
      try { await owner.remove(directory); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Backup fixture cleanup failed");
}
```

Add `cleanupBackupResources` to the helper import in the deterministic test file, then append:

```ts
it.each(["close", "stop", "unsafe", "remove", "none"])("cleanup ownership: %s", async fault => {
  const events: string[] = [];
  const error = new Error(fault);
  const perform = (name: string) => async () => {
    events.push(name); if (fault === name) throw error;
  };
  const work = cleanupBackupResources({
    closeClient: perform("close"),
    stop: fault === "unsafe" ? undefined : perform("stop"),
    unsafe: fault === "unsafe" ? "uncertain startup" : undefined,
    directories: ["/owned/data", "/owned/backups"],
    remove: async () => { events.push("remove"); if (fault === "remove") throw error; },
  });
  if (fault === "none") await work;
  else await expect(work).rejects.toBeInstanceOf(AggregateError);
  expect(events).toEqual(fault === "unsafe" ? ["close"]
    : fault === "close" || fault === "stop" ? ["close", "stop"]
    : ["close", "stop", "remove", "remove"]);
});
it("removes only acquired directories before postgres is constructed", async () => {
  const remove = vi.fn(async (_directory: string) => {});
  await cleanupBackupResources({ directories: ["/owned/data"], remove });
  expect(remove).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("/owned/data");
});
```

The table proves that close failure still attempts stop, uncertain start never calls stop/removal, stop failure prevents deletion, and removal failures remain visible. A rejected cleanup cannot be relabeled a successful teardown.

- [ ] Compare the two `it(...)` blocks byte-for-byte against the authoring base. They must be identical. No copy of diagnostic timing wrappers belongs in the repaired integration test.

## Task 3 — bounded verification and review

- [ ] Record exact candidate SHA, three-file diff, manifest and unchanged test-body hashes. Source remains local and isolated.
- [ ] In the existing offline non-root task runtime, verify source identity and SDK exports before tests. Use the same immutable image and approved environment allowlist, no host home/repository/socket mount, no new install or dependency fetch. Materialize the committed candidate as an actual Git checkout from a bundle; build prerequisites only as specified in the existing qualification runner.
- [ ] Run deterministic helper/adapter tests and package typecheck; retain deliberate red controls separately. After clean tests, run the real backup fixture once and the existing blocked-task helper test once to guard the reference contract.

```sh
corepack pnpm exec vitest run packages/db/src/__tests__/backup-fixture.test.ts
corepack pnpm --filter @armyofagents/db typecheck
corepack pnpm exec vitest run packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts server/src/__tests__/blocked-task-fixture.test.ts
```

- [ ] Maximum ten minutes for this targeted batch, including three planned negative-control invocations; no repeated green-seeking run. Preserve outcomes and restore the exact committed source after negative controls. On a real timeout/cleanup failure, stop the isolated runtime, preserve evidence and review the failing phase before another allowance.
- [ ] Author-review the final diff, test evidence, deadlines, late rejection observers and cleanup ownership. A target pass supports the correction only, not full baseline acceptance.
- [ ] Once the full qualification batch is approved, run the existing complete typecheck/four-shard/gated-build procedure against the clean correction commit. Reconcile every test identity and skip, including original backups. Do not reuse the instrumented successful shard as a substitute. Build runs only after all prior gates pass; use the existing outer run bounds and evidence ledger.

## Author self-review and approval boundary

Reviewed against measured phases, the installed library's initialization/start/stop implementation, the F4 helper, database project configuration and the previous failure record. Selected local budgets; retained synchronization and original assertions; avoided private-child termination or a new framework. The known gap is explicit: a permanently stuck initializer cannot be cancelled by this helper; the runner must record failure and stop the dedicated container. No claim that a 30-second budget fixes storage contention itself.

Self-review corrections incorporated: split seed queries into separate disposal checkpoints; defined the cleanup adapter and its exact test cases instead of leaving them implicit; retained raw-startup observation after public expiry; kept uncertain start away from library stop and filesystem deletion. The three-file boundary remains intact. This is author review, not a new Claude review.

**Readiness for the next bounded source batch:** this proposal supplies the file boundary, implementation, behavioral tests, adapter acceptance cases, commands and failure handling. Its code has not been compiled or executed. Approval sought is only authoring these three test files and running the targeted batch. Full qualification can be authorized alongside it as a conditional follow-up after review passes; source publication/merge, base adoption and Universe coding still remain separate.
