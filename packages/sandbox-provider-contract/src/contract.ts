// -----------------------------------------------------------------------------
// The parameterized, provider-neutral sandbox provider-driver CONTRACT suite.
//
// `runSandboxProviderContract(makeDriver, options)` exercises ANY driver that
// structurally satisfies `SandboxProviderDriver` and returns a structured report.
// It imports NO test framework (keeping the package's runtime dependency set to
// `@armyofagents/worker-protocol` + `zod` + Node built-ins); a `.test.ts` wrapper
// runs the suite and asserts the report. The single suite authored here is the
// one a real provider (E2B) is later validated by (CLI-001/D2) — E6 runs it only
// against the fake.
//
// Contract coverage: all eight core ops present + callable; optional-op
// negotiation via `UnsupportedProviderOperation`; deadline (hang) handling;
// idempotency-key `create` replay; reconcile → zero live resources; redacted
// list/inspect projection (no tenant/E2B key disclosure); deterministic
// pagination; and golden-corpus presence.
// -----------------------------------------------------------------------------

import {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  UnsupportedProviderOperation,
  projectionLeakKeys,
  type ProviderOpArgs,
  type ProviderOpResult,
  type SandboxProviderDriver,
  type SandboxProviderDriverFactory,
} from "./port.js";
import { GOLDEN_JOURNEY_FIXTURES, loadGoldenFixture } from "./vectors.js";

export interface ContractCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ContractReport {
  readonly passed: boolean;
  readonly checks: readonly ContractCheckResult[];
}

export interface ContractOptions {
  /** When provided, the golden-corpus presence check loads the nine FND-004
   * fixtures from this directory. Omitted → the corpus check is skipped. */
  readonly fixturesDir?: string;
}

/** True iff `err` is an UnsupportedProviderOperation for `op` — matched by class
 * OR duck-typed (`name` + `operation`), so a provider that throws its own
 * cross-package class conforms without importing this module. The authoritative
 * field is `operation` (worker-daemon's `UnsupportedProviderOperation`); the
 * legacy `op` field is still accepted for back-compat. */
function isUnsupportedProviderOperation(err: unknown, op: string): boolean {
  if (err instanceof UnsupportedProviderOperation) return err.operation === op;
  if (typeof err !== "object" || err === null) return false;
  if ((err as { name?: unknown }).name !== "UnsupportedProviderOperation") return false;
  const record = err as { operation?: unknown; op?: unknown };
  return record.operation === op || record.op === op;
}

function args(providerId: string, extra: Partial<ProviderOpArgs> = {}): ProviderOpArgs {
  return { providerId, ...extra };
}

async function createResource(
  driver: SandboxProviderDriver,
  extra: Partial<ProviderOpArgs> = {},
): Promise<string> {
  const result = await driver.invoke("create", args(driver.providerId, extra));
  if (result.kind !== "created") {
    throw new Error(`create returned kind ${result.kind}, expected "created"`);
  }
  return result.resource.resourceId;
}

export type CheckFn = () => Promise<{ ok: boolean; detail: string }>;

/** Run a single named check, converting an unexpected throw into a failed result.
 * Exported so the sibling DEP-008 isolation suite reuses the EXACT accumulator
 * shape (no forked runner). */
export async function runCheck(name: string, fn: CheckFn): Promise<ContractCheckResult> {
  try {
    const { ok, detail } = await fn();
    return { name, ok, detail };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { name, ok: false, detail: `threw unexpectedly: ${message}` };
  }
}

/**
 * Run the full provider-neutral conformance suite. `makeDriver` must return a
 * FRESH driver each call; the suite obtains a new one per independent check.
 */
export async function runSandboxProviderContract(
  makeDriver: SandboxProviderDriverFactory,
  options: ContractOptions = {},
): Promise<ContractReport> {
  const checks: ContractCheckResult[] = [];

  // 1. Every core operation is advertised.
  checks.push(
    await runCheck("core-ops-advertised", async () => {
      const driver = await makeDriver();
      const supported = new Set(driver.supportedOperations().map(String));
      const missing = CORE_PROVIDER_OPERATIONS.filter((op) => !supported.has(op));
      return {
        ok: missing.length === 0,
        detail: missing.length === 0 ? "all eight core ops advertised" : `missing core ops: ${missing.join(", ")}`,
      };
    }),
  );

  // 2. Every core operation is callable and returns a well-formed result.
  checks.push(
    await runCheck("core-ops-callable", async () => {
      const driver = await makeDriver();
      const resourceId = await createResource(driver);
      const expectations: Array<[string, ProviderOpResult["kind"], Partial<ProviderOpArgs>]> = [
        ["execute", "executed", { resourceId }],
        ["inspect", "inspect", { resourceId }],
        ["list", "list", {}],
        ["cancel", "acknowledged", { resourceId }],
        ["kill", "acknowledged", { resourceId }],
        ["destroy", "acknowledged", { resourceId }],
        ["reconcile_cleanup", "cleanup", {}],
      ];
      for (const [op, kind, extra] of expectations) {
        const result = await driver.invoke(op as never, args(driver.providerId, extra));
        if (result.kind !== kind) {
          return { ok: false, detail: `core op ${op} returned kind ${result.kind}, expected ${kind}` };
        }
      }
      return { ok: true, detail: "all core ops callable with well-formed results" };
    }),
  );

  // 3. Optional-op negotiation: advertised optional ops work; unadvertised ones
  //    raise UnsupportedProviderOperation (and never a generic error).
  checks.push(
    await runCheck("optional-op-negotiation", async () => {
      const driver = await makeDriver();
      const supported = new Set(driver.supportedOperations().map(String));
      const resourceId = await createResource(driver);
      await driver.invoke("execute", args(driver.providerId, { resourceId }));
      for (const op of OPTIONAL_PROVIDER_OPERATIONS) {
        if (supported.has(op)) {
          const result = await driver.invoke(op, args(driver.providerId, { resourceId }));
          if (result.kind !== op) {
            return { ok: false, detail: `advertised optional op ${op} returned kind ${result.kind}` };
          }
          continue;
        }
        // Unadvertised → must raise UnsupportedProviderOperation. Matched
        // duck-typed (name + op) so a provider throwing its OWN cross-package
        // class — as the fake does, not importing this module — still conforms.
        let raised: unknown;
        try {
          await driver.invoke(op, args(driver.providerId, { resourceId }));
        } catch (err) {
          raised = err;
        }
        if (!isUnsupportedProviderOperation(raised, op)) {
          return {
            ok: false,
            detail: `unadvertised optional op ${op} did not raise UnsupportedProviderOperation with op=${op} (got ${String(raised)})`,
          };
        }
      }
      return { ok: true, detail: "optional ops negotiate correctly (supported work, unsupported raise)" };
    }),
  );

  // 4. Idempotency-key replay: create twice with one key → one resource
  //    (2nd deduplicated); a different key → a distinct resource.
  checks.push(
    await runCheck("idempotency-key-replay", async () => {
      const driver = await makeDriver();
      const first = await driver.invoke("create", args(driver.providerId, { idempotencyKey: "idem-A" }));
      const second = await driver.invoke("create", args(driver.providerId, { idempotencyKey: "idem-A" }));
      const third = await driver.invoke("create", args(driver.providerId, { idempotencyKey: "idem-B" }));
      if (first.kind !== "created" || second.kind !== "created" || third.kind !== "created") {
        return { ok: false, detail: "a create call did not return a created result" };
      }
      if (first.resource.resourceId !== second.resource.resourceId) {
        return { ok: false, detail: "replaying an idempotency key returned a different resource" };
      }
      if (second.deduplicated !== true) {
        return { ok: false, detail: "idempotency-key replay was not flagged deduplicated" };
      }
      if (first.deduplicated !== false) {
        return { ok: false, detail: "first create with a key was wrongly flagged deduplicated" };
      }
      if (third.resource.resourceId === first.resource.resourceId) {
        return { ok: false, detail: "a distinct idempotency key returned the same resource" };
      }
      return { ok: true, detail: "idempotency-key create replay is stable and deduplicated" };
    }),
  );

  // 5. Deadline handling: an execute with a zero (immediate) deadline models a
  //    hang and reports timedOut deterministically; a normal deadline does not.
  checks.push(
    await runCheck("deadline-handling", async () => {
      const driver = await makeDriver();
      const resourceId = await createResource(driver);
      const hung = await driver.invoke("execute", args(driver.providerId, { resourceId, deadlineMs: 0 }));
      const ok1 = hung.kind === "executed" && hung.timedOut === true;
      const normalResource = await createResource(driver);
      const normal = await driver.invoke("execute", args(driver.providerId, { resourceId: normalResource, deadlineMs: 60_000 }));
      const ok2 = normal.kind === "executed" && normal.timedOut === false;
      return {
        ok: ok1 && ok2,
        detail: ok1 && ok2 ? "deadline exceeded → timedOut, otherwise not" : `hung=${JSON.stringify(hung)} normal=${JSON.stringify(normal)}`,
      };
    }),
  );

  // 6. Reconcile → zero live resources (E6F-02): after creating resources and
  //    calling reconcile_cleanup, list is empty and inspect is null.
  checks.push(
    await runCheck("reconcile-zero-resources", async () => {
      const driver = await makeDriver();
      const ids = [await createResource(driver), await createResource(driver), await createResource(driver)];
      const cleanup = await driver.invoke("reconcile_cleanup", args(driver.providerId));
      if (cleanup.kind !== "cleanup" || cleanup.cleanup.cleanupStatus !== "success") {
        return { ok: false, detail: `reconcile_cleanup returned ${JSON.stringify(cleanup)}` };
      }
      const list = await driver.invoke("list", args(driver.providerId));
      if (list.kind !== "list" || list.list.resources.length !== 0) {
        return { ok: false, detail: `list after reconcile reported ${list.kind === "list" ? list.list.resources.length : "?"} resources` };
      }
      for (const id of ids) {
        const inspect = await driver.invoke("inspect", args(driver.providerId, { resourceId: id }));
        if (inspect.kind !== "inspect" || inspect.projection !== null) {
          return { ok: false, detail: `inspect(${id}) after reconcile was not null` };
        }
      }
      return { ok: true, detail: "reconcile_cleanup leaves zero live provider resources" };
    }),
  );

  // 7. Redacted projection: list/inspect never leak a tenant/E2B key (E6F-05).
  checks.push(
    await runCheck("redacted-projection", async () => {
      const driver = await makeDriver();
      const resourceId = await createResource(driver);
      const inspect = await driver.invoke("inspect", args(driver.providerId, { resourceId }));
      if (inspect.kind !== "inspect" || inspect.projection === null) {
        return { ok: false, detail: "inspect did not return a projection for a live resource" };
      }
      const inspectLeaks = projectionLeakKeys(inspect.projection);
      if (inspectLeaks.length > 0) {
        return { ok: false, detail: `inspect projection leaks non-neutral keys: ${inspectLeaks.join(", ")}` };
      }
      const list = await driver.invoke("list", args(driver.providerId));
      if (list.kind !== "list") {
        return { ok: false, detail: "list did not return a list result" };
      }
      for (const projection of list.list.resources) {
        const leaks = projectionLeakKeys(projection);
        if (leaks.length > 0) {
          return { ok: false, detail: `list projection leaks non-neutral keys: ${leaks.join(", ")}` };
        }
      }
      return { ok: true, detail: "list/inspect projections carry only provider-neutral keys" };
    }),
  );

  // 8. Deterministic pagination: repeated paginated list walks are byte-stable
  //    and cover exactly the live set with no duplicates.
  checks.push(
    await runCheck("deterministic-pagination", async () => {
      const driver = await makeDriver();
      const created = new Set<string>();
      for (let i = 0; i < 5; i += 1) created.add(await createResource(driver));
      const walk = async (): Promise<string[]> => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 100; guard += 1) {
          const page: ProviderOpResult = await driver.invoke("list", args(driver.providerId, { page: { cursor, limit: 2 } }));
          if (page.kind !== "list") throw new Error("list did not return a list result");
          seen.push(...page.list.resources.map((r) => r.resourceId));
          cursor = page.list.nextCursor;
          if (cursor === null) break;
        }
        return seen;
      };
      const first = await walk();
      const second = await walk();
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        return { ok: false, detail: `paginated walks diverged: ${JSON.stringify(first)} vs ${JSON.stringify(second)}` };
      }
      if (new Set(first).size !== first.length) {
        return { ok: false, detail: `paginated walk contained duplicates: ${JSON.stringify(first)}` };
      }
      if (first.length !== created.size || !first.every((id) => created.has(id))) {
        return { ok: false, detail: `paginated walk did not cover the live set exactly (${first.length} vs ${created.size})` };
      }
      return { ok: true, detail: "paginated list is deterministic and covers the live set exactly" };
    }),
  );

  // 9. Golden corpus present (only when a fixtures directory is supplied).
  if (options.fixturesDir !== undefined) {
    const fixturesDir = options.fixturesDir;
    checks.push(
      await runCheck("golden-corpus-present", async () => {
        let loaded = 0;
        for (const name of GOLDEN_JOURNEY_FIXTURES) {
          const fixture = await loadGoldenFixture(fixturesDir, name);
          if (typeof fixture.id !== "string") {
            return { ok: false, detail: `fixture ${name} has no string id` };
          }
          loaded += 1;
        }
        return {
          ok: loaded === GOLDEN_JOURNEY_FIXTURES.length && loaded === 9,
          detail: `${loaded} golden fixtures loaded`,
        };
      }),
    );
  }

  const passed = checks.every((c) => c.ok);
  return { passed, checks };
}

/** Throw a descriptive error if any contract check failed (test-friendly). */
export function assertContractReport(report: ContractReport): void {
  if (report.passed) return;
  const failures = report.checks.filter((c) => !c.ok).map((c) => `  - ${c.name}: ${c.detail}`);
  throw new Error(`sandbox provider contract FAILED:\n${failures.join("\n")}`);
}
