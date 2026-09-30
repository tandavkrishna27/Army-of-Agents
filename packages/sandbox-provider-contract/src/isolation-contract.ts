// -----------------------------------------------------------------------------
// DEP-008 — the provider-neutral, HOSTILE sandbox isolation/cleanup conformance
// suite (DE-17 post-fence cleanup authority + DE-26 managed-sandbox isolation).
//
// This is the adversarial sibling of DEP-000's happy-path `runSandboxProvider
// Contract`. `runSandboxIsolationConformance(makeDriver, options)` exercises ANY
// driver that structurally satisfies `SandboxProviderDriver` and returns a
// structured `ContractReport`, mirroring the happy-path suite's framework-free
// runner EXACTLY (a FRESH driver per independent check via `makeDriver()`, the
// shared `runCheck` accumulator, `assertIsolationReport`). It imports NO test
// framework and NO worker-daemon — every hostile authority invariant is asserted
// provider-neutrally over the opaque invoke-driver port; denials are matched
// DUCK-TYPED (by `name` + a discriminant field) so a real adapter throwing its OWN
// cross-package `EffectAuthorityWithdrawnError` / `CleanupAuthorityDeniedError` /
// `ResourceNotAvailableError` conforms without importing this module (DEP-008 D3).
//
// The suite is CERTIFIED against the hostile reference driver (a broken/leaking/
// escalating/oracle-exposing driver MUST fail the paired check — non-vacuousness
// is enforced by `wrapDriver` sabotage tests). E6 certifies the suite + the
// reference, NOT E2B; CLI-001/D2 reruns it against real E2B (E6-F008 stays open).
//
// The eight checks map 1:1 to the eight isolation/cleanup invariants (design §2).
// -----------------------------------------------------------------------------

import { runCheck, type ContractCheckResult, type ContractReport } from "./contract.js";
import {
  projectionLeakKeys,
  type ProviderOpArgs,
  type ProviderOpResult,
  type SandboxProviderDriver,
  type SandboxProviderDriverFactory,
} from "./port.js";

/** Options for the isolation suite. `maxDestroyAttempts` is the bounded destroy
 * retry ceiling the convergence check expects the driver to honor (default 3, the
 * worker-daemon `converge` default). */
export interface IsolationOptions {
  readonly maxDestroyAttempts?: number;
}

function args(providerId: string, extra: Partial<ProviderOpArgs> = {}): ProviderOpArgs {
  return { providerId, ...extra };
}

/** True iff `err` is an Error-like carrying exactly `name` (duck-typed identity). */
function isNamed(err: unknown, name: string): err is { name: string; message: string } {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

/** Capture whatever `fn` throws (or `undefined` if it did not throw). */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

const GOVERNED_EFFECT_OPS = ["create", "execute", "checkpoint", "restore", "health"] as const;
const FROZEN_DENIAL_CLASSES = ["metadata", "private", "control_plane", "not_allowlisted"] as const;

// Synthetic sensitive canaries — opaque test tokens held ONLY inside the double,
// NEVER a tenant/E2B field (CAV-002). They exist to be proven absent.
const CANARY = {
  command: "CANARY-COMMAND-3f1c9a",
  env: "CANARY-ENV-7b2e40",
  logs: "CANARY-LOGS-d5a118",
  secret: "CANARY-SECRET-0c9f6b",
  providerCredential: "CANARY-PROVIDER-CRED-a20e77",
  tenantId: "CANARY-TENANT-91d3c2",
  customerByte: "CANARY-CUSTOMER-4e8a5f",
} as const;

function serializedContainsAny(result: unknown, needles: readonly string[]): string | null {
  const serialized = JSON.stringify(result) ?? "";
  for (const needle of needles) {
    if (serialized.includes(needle)) return needle;
  }
  return null;
}

/**
 * Run the full provider-neutral HOSTILE isolation/cleanup conformance suite.
 * `makeDriver` must return a FRESH driver each call; the suite obtains a new one
 * per independent check (and may create additional fresh drivers WITHIN a check
 * for isolated sub-scenarios).
 */
export async function runSandboxIsolationConformance(
  makeDriver: SandboxProviderDriverFactory,
  options: IsolationOptions = {},
): Promise<ContractReport> {
  const maxDestroyAttempts = options.maxDestroyAttempts ?? 3;
  const checks: ContractCheckResult[] = [];

  // §2.1 — Effect-authority withdrawal is terminal + idempotent; post-fence,
  // governed effects are denied while the narrow cleanup authority stays usable.
  checks.push(
    await runCheck("effect-authority-withdrawal", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      // Active fence: a governed effect op succeeds (precondition — non-vacuous).
      const created = await driver.invoke("create", args(pid));
      if (created.kind !== "created") return { ok: false, detail: "active-fence create did not succeed" };
      const rid = created.resource.resourceId;
      const exec = await driver.invoke("execute", args(pid, { resourceId: rid }));
      if (exec.kind !== "executed") return { ok: false, detail: "active-fence execute did not succeed" };

      // Withdraw (latch) via a non-effect op carrying the withdrawal flag.
      await driver.invoke("list", args(pid, { params: { withdrawEffectAuthority: true } }));

      // Every ADVERTISED governed effect op now denies with EffectAuthorityWithdrawnError.
      // Gate on supportedOperations() so a partial-optional adapter is not false-rejected
      // for an optional op (checkpoint/restore/health) it never advertised — the concrete
      // E6-F008 seam CLI-001/D2 reuses when it drives a real adapter through this suite.
      const supported = new Set(driver.supportedOperations().map(String));
      const governed = GOVERNED_EFFECT_OPS.filter((op) => supported.has(op));
      for (const op of governed) {
        const err = await caught(() => driver.invoke(op, args(pid, { resourceId: rid })));
        if (!isNamed(err, "EffectAuthorityWithdrawnError")) {
          return { ok: false, detail: `post-fence ${op} did not deny with EffectAuthorityWithdrawnError (got ${String(err)})` };
        }
      }
      // The narrow cleanup authority stays USABLE post-fence: each cleanup/read op must
      // SUCCEED with its expected kind (never throw, never be withdrawn) — the DE-17 core.
      // Ordered so the read ops observe the still-live resource before destroy reclaims it.
      const cleanupOrder = [
        { op: "list", kind: "list" },
        { op: "inspect", kind: "inspect" },
        { op: "cancel", kind: "acknowledged" },
        { op: "kill", kind: "acknowledged" },
        { op: "destroy", kind: "acknowledged" },
        { op: "reconcile_cleanup", kind: "cleanup" },
      ] as const;
      for (const { op, kind } of cleanupOrder) {
        let result: ProviderOpResult;
        try {
          result = await driver.invoke(op, args(pid, { resourceId: rid, params: { authority: "cleanup" } }));
        } catch (err) {
          return { ok: false, detail: `post-fence cleanup op ${op} threw (${String(err)}); the narrow cleanup authority must stay usable after fence loss` };
        }
        if (result.kind !== kind) {
          return { ok: false, detail: `post-fence cleanup op ${op} returned kind ${result.kind}, expected ${kind}` };
        }
        if (op === "inspect" && result.kind === "inspect" && result.projection === null) {
          return { ok: false, detail: "post-fence cleanup inspect returned a null projection for a live owned resource" };
        }
      }
      // Terminal + idempotent: re-withdraw never resurrects effect authority.
      await driver.invoke("list", args(pid, { params: { withdrawEffectAuthority: true } }));
      const stillDenied = await caught(() => driver.invoke("execute", args(pid)));
      if (!isNamed(stillDenied, "EffectAuthorityWithdrawnError")) {
        return { ok: false, detail: "withdrawal was not terminal (effect authority resurrected)" };
      }
      return { ok: true, detail: "post-fence governed effects denied (terminal), cleanup authority usable" };
    }),
  );

  // §2.2 — Effect ops are unrepresentable under cleanup authority: the cleanup
  // surface denies create/execute/resume/checkpoint/health/openEgress; the narrow
  // teardown/read ops succeed.
  checks.push(
    await runCheck("effect-ops-unrepresentable-under-cleanup", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      const created = await driver.invoke("create", args(pid));
      if (created.kind !== "created") return { ok: false, detail: "setup create failed" };
      const rid = created.resource.resourceId;

      // Every ADVERTISED effectful op on the cleanup facet denies with
      // CleanupAuthorityDeniedError (gate on supportedOperations() — see §2.1).
      const expectedAttempt: Record<string, string> = {
        create: "create",
        execute: "execute",
        restore: "resume",
        checkpoint: "checkpoint",
        health: "health",
      };
      const supported = new Set(driver.supportedOperations().map(String));
      for (const op of GOVERNED_EFFECT_OPS.filter((o) => supported.has(o))) {
        const err = await caught(() => driver.invoke(op, args(pid, { resourceId: rid, params: { authority: "cleanup" } })));
        if (!isNamed(err, "CleanupAuthorityDeniedError")) {
          return { ok: false, detail: `cleanup-facet ${op} did not deny with CleanupAuthorityDeniedError (got ${String(err)})` };
        }
        const attempted = (err as { attemptedOperation?: unknown }).attemptedOperation;
        if (attempted !== expectedAttempt[op]) {
          return { ok: false, detail: `cleanup-facet ${op} denied with attemptedOperation=${String(attempted)}, expected ${expectedAttempt[op]}` };
        }
      }
      // openEgress under cleanup authority is denied too.
      const egressErr = await caught(() => driver.invoke("execute", args(pid, { params: { authority: "cleanup", openEgress: true } })));
      if (!isNamed(egressErr, "CleanupAuthorityDeniedError")) {
        return { ok: false, detail: `cleanup-facet openEgress did not deny with CleanupAuthorityDeniedError (got ${String(egressErr)})` };
      }

      // The narrow cleanup/read ops SUCCEED on the cleanup facet (owned resource).
      const list = await driver.invoke("list", args(pid, { params: { authority: "cleanup" } }));
      if (list.kind !== "list") return { ok: false, detail: "cleanup-facet list must succeed" };
      const inspect = await driver.invoke("inspect", args(pid, { resourceId: rid, params: { authority: "cleanup" } }));
      if (inspect.kind !== "inspect" || inspect.projection === null) return { ok: false, detail: "cleanup-facet inspect(owned) must succeed" };
      for (const op of ["cancel", "kill"] as const) {
        const ack = await driver.invoke(op, args(pid, { resourceId: rid, params: { authority: "cleanup" } }));
        if (ack.kind !== "acknowledged") return { ok: false, detail: `cleanup-facet ${op}(owned) must succeed` };
      }
      const destroy = await driver.invoke("destroy", args(pid, { resourceId: rid, params: { authority: "cleanup" } }));
      if (destroy.kind !== "acknowledged") return { ok: false, detail: "cleanup-facet destroy(owned) must succeed" };
      const reconcile = await driver.invoke("reconcile_cleanup", args(pid, { params: { authority: "cleanup" } }));
      if (reconcile.kind !== "cleanup") return { ok: false, detail: "cleanup-facet reconcile must succeed" };
      return { ok: true, detail: "cleanup authority denies every effect op; narrow teardown/read ops succeed" };
    }),
  );

  // §2.3 — No existence oracle: a cross-resource, wrong-generation, and truly-absent
  // cleanup target all collapse to the SAME error IDENTITY (name + fixed message).
  checks.push(
    await runCheck("no-existence-oracle", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      const owned = await driver.invoke("create", args(pid, { params: { resourceGeneration: 1 } }));
      const other = await driver.invoke("create", args(pid, { params: { resourceGeneration: 5 } }));
      if (owned.kind !== "created" || other.kind !== "created") return { ok: false, detail: "setup creates failed" };
      const ownedId = owned.resource.resourceId;
      const otherId = other.resource.resourceId;

      // Three distinct probes, each on the cleanup facet: absent id, wrong-generation
      // of an existing id, and a cross-resource id (existing but caller asserts a
      // non-matching generation). All must throw ResourceNotAvailableError.
      const probes: Array<[string, ProviderOpArgs]> = [
        ["absent", args(pid, { resourceId: "ghost-does-not-exist", params: { authority: "cleanup" } })],
        ["wrong-generation", args(pid, { resourceId: ownedId, params: { authority: "cleanup", targetGeneration: 999 } })],
        ["cross-resource", args(pid, { resourceId: otherId, params: { authority: "cleanup", targetGeneration: 1 } })],
      ];
      const identities: Array<{ label: string; name: string; message: string }> = [];
      for (const [label, probeArgs] of probes) {
        // Assert across BOTH a read (inspect) and a teardown (cancel) op.
        for (const op of ["inspect", "cancel"] as const) {
          const err = await caught(() => driver.invoke(op, probeArgs));
          if (!isNamed(err, "ResourceNotAvailableError")) {
            return { ok: false, detail: `${label} ${op} did not throw ResourceNotAvailableError (got ${String(err)})` };
          }
          identities.push({ label: `${label}:${op}`, name: err.name, message: err.message });
        }
      }
      // Every identity must be BYTE-IDENTICAL (no case can be distinguished).
      const [first, ...rest] = identities;
      for (const id of rest) {
        if (id.name !== first.name || id.message !== first.message) {
          return { ok: false, detail: `identities diverged: ${first.label}(${first.message}) vs ${id.label}(${id.message}) — existence oracle` };
        }
      }
      if (first.message.length === 0) return { ok: false, detail: "ResourceNotAvailableError message must be fixed/non-empty" };

      // The cleanup-facet list must be OWNERSHIP-SCOPED: listing under the owned
      // generation must NOT disclose the foreign-generation resource — otherwise `list`
      // is an existence oracle that crosses the very boundary the point ops enforce.
      const scoped = await driver.invoke("list", args(pid, { params: { authority: "cleanup", targetGeneration: 1 } }));
      if (scoped.kind !== "list") return { ok: false, detail: "cleanup-facet list did not return a list result" };
      const scopedIds = scoped.list.resources.map((r) => r.resourceId);
      if (scopedIds.includes(otherId)) {
        return { ok: false, detail: `cleanup list under generation 1 disclosed the foreign-generation resource ${otherId} (list existence oracle)` };
      }
      if (!scopedIds.includes(ownedId)) {
        return { ok: false, detail: "cleanup list under generation 1 omitted the owned resource" };
      }
      return { ok: true, detail: `absent/wrong-generation/cross-resource collapse to one identity ("${first.message}"); cleanup list ownership-scoped` };
    }),
  );

  // §2.4 — Monotonic convergence: none→cancel→kill→destroy never regresses; ignored
  // cancel/kill escalate to a forced destroy retried up to a BOUNDED ceiling;
  // convergence leaves zero live resources; an empty pass never fails open.
  checks.push(
    await runCheck("monotonic-cleanup-convergence", async () => {
      // (a) Escalation converges to zero: ignored cancel + ignored kill → forced destroy.
      {
        const d = await makeDriver();
        const pid = d.providerId;
        await d.invoke("create", args(pid, { params: { faults: { ignoreCancel: true, ignoreKill: true } } }));
        const rec = await d.invoke("reconcile_cleanup", args(pid, { params: { authority: "cleanup" } }));
        if (rec.kind !== "cleanup" || rec.cleanup.cleanupStatus !== "success") {
          return { ok: false, detail: `escalation converge did not succeed: ${JSON.stringify(rec)}` };
        }
        const list = await d.invoke("list", args(pid, { params: { authority: "cleanup" } }));
        if (list.kind !== "list" || list.list.resources.length !== 0) {
          return { ok: false, detail: "escalation converge left live resources (did not converge to zero)" };
        }
      }
      // (b) No regression: after destroy, a cancel must NOT resurrect the resource.
      {
        const d = await makeDriver();
        const pid = d.providerId;
        const c = await d.invoke("create", args(pid));
        if (c.kind !== "created") return { ok: false, detail: "setup create failed (b)" };
        const rid = c.resource.resourceId;
        await d.invoke("destroy", args(pid, { resourceId: rid }));
        await d.invoke("cancel", args(pid, { resourceId: rid })); // no-op on a gone resource
        const list = await d.invoke("list", args(pid));
        if (list.kind !== "list" || list.list.resources.length !== 0) {
          return { ok: false, detail: "a post-destroy cancel resurrected the resource (regression)" };
        }
      }
      // (c) Bounded destroy ceiling: destroyFailures == ceiling → failed; ceiling-1 → success.
      {
        const dFail = await makeDriver();
        await dFail.invoke("create", args(dFail.providerId, { params: { faults: { destroyFailures: maxDestroyAttempts } } }));
        const recFail = await dFail.invoke("reconcile_cleanup", args(dFail.providerId, { params: { authority: "cleanup" } }));
        if (recFail.kind !== "cleanup" || recFail.cleanup.cleanupStatus !== "failed") {
          return { ok: false, detail: `destroy-failure at the ceiling must report failed (bounded), got ${JSON.stringify(recFail)}` };
        }
        const dOk = await makeDriver();
        await dOk.invoke("create", args(dOk.providerId, { params: { faults: { destroyFailures: maxDestroyAttempts - 1 } } }));
        const recOk = await dOk.invoke("reconcile_cleanup", args(dOk.providerId, { params: { authority: "cleanup" } }));
        if (recOk.kind !== "cleanup" || recOk.cleanup.cleanupStatus !== "success") {
          return { ok: false, detail: `destroy-failure below the ceiling must still converge, got ${JSON.stringify(recOk)}` };
        }
      }
      // (d) Empty pass never fails open: an empty reconcile does not consume the latch.
      {
        const d = await makeDriver();
        const pid = d.providerId;
        const empty = await d.invoke("reconcile_cleanup", args(pid, { params: { authority: "cleanup", emptyPass: true } }));
        if (empty.kind !== "cleanup" || empty.cleanup.cleanupStatus !== "success") {
          return { ok: false, detail: "empty reconcile pass did not report success" };
        }
        await d.invoke("create", args(pid));
        const rec = await d.invoke("reconcile_cleanup", args(pid, { params: { authority: "cleanup" } }));
        const list = await d.invoke("list", args(pid, { params: { authority: "cleanup" } }));
        if (rec.kind !== "cleanup" || rec.cleanup.cleanupStatus !== "success" || (list.kind === "list" && list.list.resources.length !== 0)) {
          return { ok: false, detail: "a real converge after an empty pass failed open (left resources live)" };
        }
      }
      return { ok: true, detail: "monotonic converge to zero; bounded destroy retries; empty pass never fails open" };
    }),
  );

  // §2.5 — Zero-byte management projection (NON-VACUOUS): the resource HOLDS
  // synthetic sensitive detail; list/inspect return ONLY the provider-neutral keys
  // and NONE of the sensitive canary bytes appear in any projection/result.
  checks.push(
    await runCheck("zero-byte-management-projection", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      const sensitive = { command: CANARY.command, env: CANARY.env, logs: CANARY.logs, secret: CANARY.secret };
      const canaries = Object.values(sensitive);
      const created = await driver.invoke("create", args(pid, { params: { sensitive } }));
      if (created.kind !== "created") return { ok: false, detail: "setup create failed" };
      const rid = created.resource.resourceId;

      for (const facet of [undefined, "cleanup"] as const) {
        const params = facet ? { authority: facet } : undefined;
        const inspect = await driver.invoke("inspect", args(pid, { resourceId: rid, params }));
        if (inspect.kind !== "inspect" || inspect.projection === null) {
          return { ok: false, detail: `inspect returned no projection (facet=${facet ?? "effect"})` };
        }
        const leaks = projectionLeakKeys(inspect.projection);
        if (leaks.length > 0) return { ok: false, detail: `inspect projection leaks non-neutral keys: ${leaks.join(", ")}` };
        const inspectLeak = serializedContainsAny(inspect, canaries);
        if (inspectLeak) return { ok: false, detail: `inspect result leaked sensitive canary: ${inspectLeak}` };

        const list = await driver.invoke("list", args(pid, { params }));
        if (list.kind !== "list") return { ok: false, detail: "list did not return a list result" };
        for (const projection of list.list.resources) {
          const listLeaks = projectionLeakKeys(projection);
          if (listLeaks.length > 0) return { ok: false, detail: `list projection leaks non-neutral keys: ${listLeaks.join(", ")}` };
        }
        const listLeak = serializedContainsAny(list, canaries);
        if (listLeak) return { ok: false, detail: `list result leaked sensitive canary: ${listLeak}` };
      }
      return { ok: true, detail: "list/inspect projections carry only neutral keys; zero sensitive bytes leak (non-vacuous)" };
    }),
  );

  // §2.6 — Network denial + no bypass: active-fence egress to a non-allowlisted /
  // metadata / private / control-plane destination is refused carrying the exact
  // frozen class; an allowlisted destination succeeds; post-fence openEgress denied.
  checks.push(
    await runCheck("network-denial-no-bypass", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      const created = await driver.invoke("create", args(pid));
      if (created.kind !== "created") return { ok: false, detail: "setup create failed" };
      const rid = created.resource.resourceId;

      // Allowlisted egress under an active fence succeeds.
      const allowed = await driver.invoke("execute", args(pid, { resourceId: rid, params: { egress: { classification: "allow" } } }));
      if (allowed.kind !== "executed") return { ok: false, detail: "allowlisted egress did not succeed" };

      // Every frozen denial class is refused carrying its exact class.
      for (const cls of FROZEN_DENIAL_CLASSES) {
        const err = await caught(() => driver.invoke("execute", args(pid, { resourceId: rid, params: { egress: { classification: cls } } })));
        if (!isNamed(err, "SandboxEgressDeniedError")) {
          return { ok: false, detail: `egress to ${cls} was not refused (got ${String(err)})` };
        }
        const denied = (err as { destinationClass?: unknown }).destinationClass;
        if (denied !== cls) return { ok: false, detail: `egress denial carried class ${String(denied)}, expected ${cls}` };
      }

      // Post-fence openEgress is denied on BOTH facets (no direct socket path).
      await driver.invoke("list", args(pid, { params: { withdrawEffectAuthority: true } }));
      const cleanupEgress = await caught(() => driver.invoke("execute", args(pid, { params: { authority: "cleanup", openEgress: true } })));
      if (!isNamed(cleanupEgress, "CleanupAuthorityDeniedError")) {
        return { ok: false, detail: `post-fence cleanup openEgress not denied (got ${String(cleanupEgress)})` };
      }
      const effectEgress = await caught(() => driver.invoke("execute", args(pid, { resourceId: rid, params: { openEgress: true } })));
      if (!isNamed(effectEgress, "EffectAuthorityWithdrawnError")) {
        return { ok: false, detail: `post-fence effect openEgress not denied (got ${String(effectEgress)})` };
      }
      return { ok: true, detail: "egress refused per frozen class; allowlisted succeeds; post-fence openEgress denied" };
    }),
  );

  // §2.7 — Provider-credential + customer-byte absence: NO provider credential,
  // tenant identifier, or customer byte appears in ANY result across the lifecycle.
  checks.push(
    await runCheck("no-credential-or-customer-byte-leak", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;
      const secrets = { providerCredential: CANARY.providerCredential, tenantId: CANARY.tenantId, customerByte: CANARY.customerByte };
      const canaries = Object.values(secrets);
      const created = await driver.invoke("create", args(pid, { params: { secrets } }));
      if (created.kind !== "created") return { ok: false, detail: "setup create failed" };
      const rid = created.resource.resourceId;

      const results: Array<[string, ProviderOpResult]> = [
        ["create", created],
        ["execute", await driver.invoke("execute", args(pid, { resourceId: rid }))],
        ["inspect", await driver.invoke("inspect", args(pid, { resourceId: rid }))],
        ["list", await driver.invoke("list", args(pid))],
        ["cancel", await driver.invoke("cancel", args(pid, { resourceId: rid }))],
        ["kill", await driver.invoke("kill", args(pid, { resourceId: rid }))],
        ["reconcile_cleanup", await driver.invoke("reconcile_cleanup", args(pid))],
      ];
      for (const [label, result] of results) {
        const leak = serializedContainsAny(result, canaries);
        if (leak) return { ok: false, detail: `${label} result leaked a credential/tenant/customer canary: ${leak}` };
      }
      return { ok: true, detail: "no provider-credential / tenant-id / customer byte leaks across the lifecycle (non-vacuous)" };
    }),
  );

  // §2.8 — Bounded lifecycle faults: TTL, ignored cancel, forced kill, destroy-
  // failure, worker-crash, provider-outage all reach a bounded terminal outcome
  // (no hang, no orphan); leaked-resource reconciliation converges to zero.
  checks.push(
    await runCheck("bounded-lifecycle-faults", async () => {
      const driver = await makeDriver();
      const pid = driver.providerId;

      // TTL expiry → deterministic timedOut terminal (never a hang).
      const rTtl = await driver.invoke("create", args(pid));
      if (rTtl.kind !== "created") return { ok: false, detail: "setup create failed (ttl)" };
      const ttl = await driver.invoke("execute", args(pid, { resourceId: rTtl.resource.resourceId, deadlineMs: 0 }));
      if (ttl.kind !== "executed" || ttl.timedOut !== true) return { ok: false, detail: "TTL expiry did not reach a timedOut terminal" };

      // Worker-crash → defined failed terminal (never a hang).
      const rCrash = await driver.invoke("create", args(pid));
      if (rCrash.kind !== "created") return { ok: false, detail: "setup create failed (crash)" };
      const crash = await driver.invoke("execute", args(pid, { resourceId: rCrash.resource.resourceId, params: { lifecycleFault: "crash" } }));
      if (crash.kind !== "executed" || crash.terminalState !== "failed") return { ok: false, detail: "worker-crash did not reach a failed terminal" };

      // Provider-outage → REPORTED (never raised), and a retry converges to zero.
      {
        const d = await makeDriver();
        await d.invoke("create", args(d.providerId));
        const outage = await d.invoke("reconcile_cleanup", args(d.providerId, { params: { lifecycleFault: "outage" } }));
        if (outage.kind !== "cleanup" || outage.cleanup.cleanupStatus !== "failed") {
          return { ok: false, detail: "provider-outage reconcile must be reported failed, not raised" };
        }
        const retry = await d.invoke("reconcile_cleanup", args(d.providerId));
        const list = await d.invoke("list", args(d.providerId));
        if (retry.kind !== "cleanup" || retry.cleanup.cleanupStatus !== "success" || (list.kind === "list" && list.list.resources.length !== 0)) {
          return { ok: false, detail: "a retry after a provider outage did not converge to zero" };
        }
      }

      // Ignored cancel / forced kill / destroy-failure + leaked reconciliation → zero orphans.
      {
        const d = await makeDriver();
        const pid2 = d.providerId;
        await d.invoke("create", args(pid2, { params: { faults: { ignoreCancel: true } } })); // cancel ignored → kill
        await d.invoke("create", args(pid2, { params: { faults: { ignoreCancel: true, ignoreKill: true, destroyFailures: maxDestroyAttempts - 1 } } }));
        await d.invoke("create", args(pid2)); // a plain leaked resource
        const rec = await d.invoke("reconcile_cleanup", args(pid2, { params: { authority: "cleanup" } }));
        const list = await d.invoke("list", args(pid2, { params: { authority: "cleanup" } }));
        if (rec.kind !== "cleanup" || rec.cleanup.cleanupStatus !== "success" || (list.kind === "list" && list.list.resources.length !== 0)) {
          return { ok: false, detail: "leaked-resource reconciliation did not converge to zero orphans" };
        }
      }
      return { ok: true, detail: "every lifecycle fault reaches a bounded terminal; leaked reconciliation converges to zero" };
    }),
  );

  const passed = checks.every((c) => c.ok);
  return { passed, checks };
}

/** Throw a descriptive error if any isolation check failed (test-friendly). */
export function assertIsolationReport(report: ContractReport): void {
  if (report.passed) return;
  const failures = report.checks.filter((c) => !c.ok).map((c) => `  - ${c.name}: ${c.detail}`);
  throw new Error(`sandbox isolation conformance FAILED:\n${failures.join("\n")}`);
}
