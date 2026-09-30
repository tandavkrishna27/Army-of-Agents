import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  GUARDED_JOB_MUTATORS,
  isActiveFence,
  classifyFence,
  JobFenceError,
} from "@armyofagents/db";
import {
  GOVERNED_FENCE_SURFACE,
  isActiveFence as fencingIsActiveFence,
  JobFenceError as FencingJobFenceError,
} from "../services/job-fencing.js";
import { createJobControlRepository } from "../../../packages/db/src/repositories/tenant/job-control.js";
import type { Db } from "../../../packages/db/src/client.js";

// -----------------------------------------------------------------------------
// JOB-004 — STATIC governed-fence-surface contract.
//
// Every governed job-control mutator on the tenant repository MUST gate on the ONE
// common active-fence guard (`guardActiveFence`, which decides admission through the
// shared `isActiveFence` predicate) BEFORE it touches or reads any governed row.
// This test AST-scans the REAL repository source and fails closed if:
//   * the returned repository object grows a method not on the closed allowlist
//     (so a future ticket cannot add an UNGUARDED governed mutator silently);
//   * any of the seven enumerated governed mutators does not call the guard;
//   * the guard does not run BEFORE the first `tx` access in a governed mutator;
//   * the guard is not itself bound to the shared `isActiveFence` predicate.
//
// It is a pure test (TypeScript AST + a lazy stub repository) — no database.
// -----------------------------------------------------------------------------

const JOB_CONTROL_PATH = fileURLToPath(
  new URL("../../../packages/db/src/repositories/tenant/job-control.ts", import.meta.url),
);
const JOB_FENCE_PATH = fileURLToPath(
  new URL("../../../packages/db/src/repositories/tenant/job-fence.ts", import.meta.url),
);

/** The CLOSED governed mutators, per the ticket's enumerated surface. DAT-002 adds
 * `commitArtifactVersion` (the fenced verified-commit sibling of the thin
 * `authorizeArtifactCommit`). */
const EXPECTED_GUARDED = [
  "acceptEvent",
  "authorizeArtifactCommit",
  // DAT-009 slice 2 — the fenced grant-INTENT write at upload-grant mint.
  "recordArtifactGrantIntent",
  "commitArtifactVersion",
  // DAT-003 — the fenced workspace-patch apply/review disposition mutator.
  "recordPatchApplyState",
  "readSecretHandle",
  // DAT-004 — the fenced lease-scoped secret-handle resolve authorization mutator.
  "resolveExecutionSecret",
  "completeAttempt",
  "recordServiceHealth",
  "applyProjectionReceipt",
  "ackControlCommand",
].sort();

/**
 * The closed allowlist of every OTHER repository method (pre-JOB-004 lifecycle,
 * placement, and read accessors, plus the JOB-004 renewal). The returned
 * repository object's method set must equal exactly (this ∪ the guarded set) — a
 * new method fails the test until an author classifies it here or as guarded.
 */
const EXPECTED_UNGUARDED = [
  "admission",
  "taskSourceIsAdmitted",
  "internalRunSourceIsAdmitted",
  "commanderSourceIsAdmitted",
  "serviceSourceIsAdmitted",
  "insertJobOnce",
  "findSubmission",
  "insertAttempt",
  "findInitialAttempt",
  "insertOutbox",
  "lockPlacementContext",
  "listPlacementCandidateSnapshots",
  "persistPlacementDecision",
  // DAT-008 — the secret-handle MINT surface, deliberately UNGUARDED. It runs inside
  // the placement transaction, under the row lock `lockPlacementContext` already took,
  // and at that point no lease and therefore no fence exists yet — a fence guard here
  // would be unsatisfiable, not stricter. The fenced surface is the RESOLVE
  // (`resolveExecutionSecret`), which is where a value is actually produced.
  "loadAgentAdapterBinding",
  "insertExecutionSecretHandle",
  // A tenant-scoped read of NON-SECRET handle references for the lease envelope.
  "listActiveExecutionSecretHandles",
  "lockWorkerLeaseAuthority",
  "lockEligibleLeaseCandidates",
  "snapshotLiveLeaseCapacity",
  "upsertLeaseRejectionCertificates",
  "cleanupLeaseRejectionCertificates",
  "acquirePlatformTargetAuthorityShared",
  "recheckPlatformTargetAuthority",
  "touchWorkerLeaseProfile",
  "currentDatabaseTime",
  "setLocalStatementTimeout",
  "offerLease",
  "cleanupExpiredOperationReceipts",
  "findOperationReceipt",
  "lockLeaseAckContext",
  "activateLeaseAck",
  "renewLease",
  "readAcceptedThroughSeq",
  "claimReadyOutbox",
  "deliverReadyOutbox",
  // JOB-006 server-authority (operator/reaper) surface: these lock the authoritative
  // job/attempt/lease rows directly and PERMANENTLY revoke the fence, so they are
  // deliberately NOT worker-fence-guarded (the reaper acts when the fence is stale).
  "requestCancellation",
  "listPendingControlCommands",
  "allocateRetryAttempt",
  "reapExpiredLeases",
  // DAT-006 device-authed orphan quarantine: an orphan is a DEAD-FENCE output, so this
  // mutator is DEVICE-authed (targetId + deviceGeneration recheck) and deliberately does
  // NOT gate on guardActiveFence — same species as the reaper methods above. It writes
  // only the `status='quarantined'` orphan row (structurally cannot touch a committed
  // attempt), so it stays outside the guarded surface (EXPECTED_GUARDED stays 10).
  "recordOrphanQuarantine",
  // JOB-011 SERVER-authored governance-projection surface: invoked ONLY from the
  // control-plane approval bridge (never a worker route), so they are outside the
  // worker-fenced closed set. They still gate on guardActiveFence internally
  // (defense in depth — a governance moment must act on a LIVE distributed attempt),
  // but they are classified here because they are not worker-reachable mutators.
  "recordGovernedProjection",
  "markGovernedProjectionApplied",
  "queueGovernedControlCommand",
  // JOB-011 guard-only lock: `lockActiveFence` calls guardActiveFence and returns its
  // locked lease+attempt WITHOUT writing anything (a read-only serialization primitive
  // the approval bridge uses to close a create TOCTOU). It is not a worker-reachable
  // governed mutator, so it is classified here like the other control-plane methods.
  "lockActiveFence",
  // DEP-011 reaper Slice B (B1): the READ-ONLY lease-truth classifier for the
  // adapter-manager's orphan reaper PULL. UNGUARDED by design — like the reaper and
  // quarantine methods it acts precisely WHEN the fence is gone, so guardActiveFence
  // would refuse every real call; its safety is classifying dead only on monotonic
  // status/generation columns. Not a worker-reachable governed mutator.
  "classifyLeaseTruth",
  // SVC-002 the service reconciler's surface, deliberately UNGUARDED and classified in
  // the SAME commit that adds it (this test fails closed on any unclassified method).
  //
  // None of the six is worker-side and none is reached through a lease: they run in the
  // control-plane sweeper's own tenant transaction, BEFORE any job exists, so at that point
  // there is no fence to guard against and `guardActiveFence` would be unsatisfiable rather
  // than stricter same reasoning DAT-008's `insertExecutionSecretHandle` is classified
  // here. The duplicate-placement invariant they uphold lives in the partial unique index
  // `service_instances_live_service_uq`, not in a fence.
  //
  // `attributeServiceInstance` writes only `job_id` / `attempt_id`, never `status`.
  //
  // ★ CORRECTION (SVC-007a, extended by SVC-003b). The sentence that stood here —
  // "`recordServiceHealth` stays the sole (and guarded) writer of instance status" — was
  // already FALSE at `053f90fc8`: SVC-003a introduced `writeServiceInstanceStatus` as the ONE
  // writer of that column and gave it TWO entry points, `recordServiceHealth` and the fenced
  // `applyServiceProjectionForFence` (the latter lives inside `acceptEvent`, itself a guarded
  // mutator, so it adds no method to this surface). SVC-003b's liveness deadline adds a THIRD
  // entry point below, and SVC-007a's cancelled-attempt backstop a FOURTH. All of them are
  // inner functions rather than members of this surface, so the drift was invisible to this
  // test. It is corrected rather than quietly deleted, because a stale comment on a
  // fail-closed list is the thing that makes the list read as more than it proves.
  "lockServiceForReconcile",
  "countNonTerminalInstances",
  "insertServiceInstance",
  "attributeServiceInstance",
  "listReconcilableServices",
  "findServiceGenerationDefinition",
  // ★★★ SVC-003b — the liveness deadline's sweep, UNGUARDED, and classified in the SAME
  // commit that adds it (this test fails closed, and it is what caught the omission).
  //
  // It is the SAME SPECIES as `reapExpiredLeases`, `recordOrphanQuarantine` and
  // `classifyLeaseTruth`: it acts precisely WHEN the fence is gone. `guardActiveFence` demands
  // an ACTIVE lease for a named (job, attempt, lease) triple, and the deadline has no lease id
  // and no worker to name — it has an organization and a clock, and it exists exactly because
  // the worker has stopped saying anything. A guard here would be unsatisfiable, not stricter,
  // and would make the deadline a dead lever.
  //
  // ITS SAFETY IS ELSEWHERE, and stated so this classification is not read as "unchecked":
  // (1) the population is the shared `nonTerminalServiceInstanceStatus()` predicate, so it can
  // only ever see live rows; (2) it takes `FOR UPDATE SKIP LOCKED`, so a row an ingest is
  // projecting onto right now is skipped rather than raced; (3) the frozen predecessor set is
  // computed SERVER-SIDE and enforced here independently of the caller's decider; and (4) the
  // write is conditional on the status read under the lock, through the same single
  // `writeServiceInstanceStatus` the two fenced authors use.
  "sweepServiceInstanceLiveness",
  // SVC-007a — the service CREATE, the desired-state control and the operator read, classified
  // in the SAME commit that adds them.
  //
  // Five of SVC-007a's six are outside the fence for SVC-002's reason above (its "six" is a
  // different set — the six-method block SVC-002 classified, above `lockServiceForReconcile`,
  // and no longer the block immediately preceding this one now that SVC-003b's sweep sits
  // between them): they run in the
  // control plane's own tenant transaction and mostly BEFORE any job exists, so there is no
  // fence to guard against and `guardActiveFence` would be unsatisfiable rather than stricter.
  // `insertServiceGeneration` writes an immutable row that no worker can reach at all
  // (`aoa_app` holds only SELECT and INSERT on `service_generations`).
  "insertServiceGeneration",
  "updateServiceDesiredState",
  "findServiceForCompany",
  "listServicesForCompany",
  "findLiveServiceInstance",
  // ★★★ THE SIXTH IS THE ONE THAT NEEDS ITS OWN PARAGRAPH, because it is a FOURTH entry point
  // onto `writeServiceInstanceStatus` and it is UNGUARDED. (SVC-007a wrote THIRD, which was
  // true on its own branch; SVC-003b's sweep above is the third in the merged tree.)
  //
  // WHY A FENCE CANNOT GUARD IT. Its precondition is that the attempt this instance is
  // attributed to is ALREADY TERMINAL — that is the only state it acts in. A terminal attempt
  // has no active lease, so `guardActiveFence` would refuse EVERY real call. That is exactly
  // the reaper/quarantine/`classifyLeaseTruth` reasoning above: a method that acts precisely
  // WHEN the fence is gone cannot be gated on the fence being present.
  //
  // WHAT STANDS IN FOR THE FENCE, and it is four things, not a promise: (1) the attempt's
  // terminal, non-`succeeded` status is RE-READ from the database under the instance's row
  // lock, so the caller cannot assert it; (2) an already-terminal instance is a no-op; (3)
  // legality is the frozen `SERVICE_INSTANCE_TRANSITIONS` predecessor set computed by the
  // server, and an EMPTY set REFUSES rather than writing; (4) the write itself goes through
  // `writeServiceInstanceStatus`, conditional on the exact status read under that lock. It is
  // not worker-reachable: no wire operation resolves to it (E9-F006).
  "terminalizeServiceInstanceForCancelledAttempt",
  // ★★★ SVC-005a — the generation rollout's TWO methods, classified in the SAME commit that
  // adds them (this test fails closed, and it is what caught the omission — again).
  //
  // `bumpServiceGeneration` is the writer `services.generation` never had. It is outside the
  // fence for SVC-002's reason and more strongly: it touches `services` and nothing else, runs
  // in the control plane's own tenant transaction under the service's advisory + row lock, and
  // NO WORKER CAN REACH IT AT ALL — no wire operation resolves to it and `services` is not a
  // table any fenced mutator writes. `guardActiveFence` demands an ACTIVE lease for a named
  // (job, attempt, lease) triple; a rollout has no lease and names no worker, so a guard here
  // would be unsatisfiable rather than stricter.
  //
  // WHAT STANDS IN FOR THE FENCE, and it is three things: (1) the caller must already hold the
  // service's row lock, and the write is a COMPARE-AND-SET on `expectedGeneration` so a caller
  // that forgot the lock still cannot overwrite a generation it did not read; (2) it can only
  // move FORWARD BY ONE — both the expected and the next value are derived from a single
  // parameter, so no caller can express a skip or a rewind; (3) its only production caller
  // reaches it through `rollServiceGeneration`, which runs `assertAdmissibleOrganization`
  // first (FND-007, Decision #121).
  "bumpServiceGeneration",
  // `listUnwitnessedGenerationPredecessors` is a READ. It writes nothing, so there is no
  // mutation for a fence to gate, and it is listed here for the same reason
  // `findLiveServiceInstance` and `listReconcilableServices` are: this surface is closed, so a
  // read that is not classified fails the suite. Its own safety property is the opposite of a
  // permission: it must be FAIL-CLOSED in the sense of returning MORE rows rather than fewer —
  // a row it fails to return is a placement admitted on no evidence — which is why its NULL
  // arm is spelled out explicitly and why the join to `job_attempts` is LEFT rather than INNER.
  "listUnwitnessedGenerationPredecessors",
];

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found = node;
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

/**
 * The repository object literal `fn` returns — either returned directly, or bound to a
 * `const` in the same body and returned by name.
 *
 * ★ JOB-015 widened this. `createJobControlRepository` now binds its literal to
 * `const repository` so `renewLease` can call the PUBLIC
 * `repository.listPendingControlCommands(...)` instead of duplicating that query inline
 * (E3-F035: the duplication is what left the method with zero callers). The parser
 * previously accepted ONLY `return { … }` and threw "no returned object literal",
 * failing this whole suite to collect — a red that looks like a contract violation but
 * is a parser limitation. The widening is deliberately narrow: a `const` declared in
 * the SAME function body whose initializer is an object literal, resolved by name from
 * the return statement. An indirection the parser cannot follow still throws, which is
 * the fail-closed direction (a surface it cannot see must never read as an empty one).
 */
function returnedObjectLiteral(fn: ts.FunctionDeclaration): ts.ObjectLiteralExpression {
  const bound = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of fn.body!.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)
          && declaration.initializer
          && ts.isObjectLiteralExpression(declaration.initializer)) {
          bound.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isReturnStatement(statement) && statement.expression) {
      if (ts.isObjectLiteralExpression(statement.expression)) return statement.expression;
      if (ts.isIdentifier(statement.expression)) {
        const resolved = bound.get(statement.expression.text);
        if (resolved) return resolved;
      }
    }
  }
  throw new Error("no returned object literal");
}

function methodMembers(object: ts.ObjectLiteralExpression): Map<string, ts.Node> {
  const members = new Map<string, ts.Node>();
  for (const member of object.properties) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      members.set(member.name.text, member);
    } else if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name)) {
      members.set(member.name.text, member.initializer);
    }
  }
  return members;
}

/** Earliest source position of a call to `guardActiveFence(...)` in `node`. */
function guardCallStart(node: ts.Node): number {
  let start = Number.POSITIVE_INFINITY;
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)
      && current.expression.text === "guardActiveFence") {
      start = Math.min(start, current.getStart());
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return start;
}

/** Earliest source position of ANY `tx.select|insert|update|delete(...)` in `node`. */
function firstTxAccessStart(node: ts.Node): number {
  let start = Number.POSITIVE_INFINITY;
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression)
      && current.expression.expression.text === "tx"
      && ["select", "insert", "update", "delete"].includes(current.expression.name.text)) {
      start = Math.min(start, current.getStart());
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return start;
}

function callsIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)
      && current.expression.text === name) {
      found = true;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

describe("JOB-004 governed active-fence surface (static contract)", () => {
  const jobControl = parse(JOB_CONTROL_PATH);
  const repositoryFactory = findFunction(jobControl, "createJobControlRepository");
  const repositoryObject = returnedObjectLiteral(repositoryFactory);
  const methods = methodMembers(repositoryObject);

  it("enumerates the exact eight guarded mutators as the shared closed surface", () => {
    expect([...GUARDED_JOB_MUTATORS].sort()).toEqual(EXPECTED_GUARDED);
    // The server-side mirror agrees byte-for-byte with the db-owned list.
    expect([...GOVERNED_FENCE_SURFACE].sort()).toEqual(EXPECTED_GUARDED);
    expect([...GOVERNED_FENCE_SURFACE].sort()).toEqual([...GUARDED_JOB_MUTATORS].sort());
  });

  it("keeps the returned repository object a CLOSED method surface (fail-closed on new methods)", () => {
    const actual = [...methods.keys()].sort();
    const expected = [...new Set([...EXPECTED_UNGUARDED, ...GUARDED_JOB_MUTATORS])].sort();
    // A new repository method (governed or not) must be classified here before it
    // can land — an unclassified addition fails this equality.
    expect(actual).toEqual(expected);
  });

  it("defines and exposes every guarded mutator at runtime", () => {
    const repository = createJobControlRepository({} as unknown as Db);
    for (const name of GUARDED_JOB_MUTATORS) {
      expect(methods.has(name), `${name} must be defined on the repository object`).toBe(true);
      expect(typeof (repository as unknown as Record<string, unknown>)[name]).toBe("function");
    }
    expect(typeof (repository as unknown as Record<string, unknown>).renewLease).toBe("function");
  });

  it("gates EVERY guarded mutator on guardActiveFence BEFORE any tx access", () => {
    for (const name of GUARDED_JOB_MUTATORS) {
      const method = methods.get(name);
      expect(method, `${name} missing`).toBeDefined();
      const guardStart = guardCallStart(method!);
      const txStart = firstTxAccessStart(method!);
      expect(Number.isFinite(guardStart), `${name} must call guardActiveFence`).toBe(true);
      expect(
        guardStart < txStart,
        `${name} must call guardActiveFence before any tx.select/insert/update/delete`,
      ).toBe(true);
    }
  });

  it("also gates the conditional lease renewal on guardActiveFence before any tx access", () => {
    const renew = methods.get("renewLease");
    expect(renew).toBeDefined();
    const guardStart = guardCallStart(renew!);
    const txStart = firstTxAccessStart(renew!);
    expect(Number.isFinite(guardStart)).toBe(true);
    expect(guardStart < txStart).toBe(true);
  });

  it("binds the guard to the shared active-fence predicate", () => {
    const guard = findFunction(jobControl, "guardActiveFence");
    expect(callsIdentifier(guard, "isActiveFence"), "guardActiveFence must use isActiveFence").toBe(true);
    expect(callsIdentifier(guard, "classifyFence"), "guardActiveFence must classify the refusal").toBe(true);
    // The guard's locking read must evaluate expiry against a FRESH database clock.
    expect(guard.getFullText()).toContain("clock_timestamp()");
  });

  it("owns the predicate + closed surface in the shared job-fence module", () => {
    const fence = readFileSync(JOB_FENCE_PATH, "utf8");
    for (const token of ["isActiveFence", "classifyFence", "JobFenceError", "GUARDED_JOB_MUTATORS"]) {
      expect(fence).toContain(`export`);
      expect(fence).toContain(token);
    }
    // The server fence module re-exports the SAME predicate + error (identity check).
    expect(fencingIsActiveFence).toBe(isActiveFence);
    expect(FencingJobFenceError).toBe(JobFenceError);
    expect(typeof classifyFence).toBe("function");
  });

  it("declares the predicate honestly: active only when active + fresh + non-terminal", () => {
    expect(isActiveFence({ leaseStatus: "active", attemptStatus: "leased", expiresFresh: true })).toBe(true);
    expect(isActiveFence({ leaseStatus: "active", attemptStatus: "running", expiresFresh: true })).toBe(true);
    expect(isActiveFence({ leaseStatus: "offered", attemptStatus: "leased", expiresFresh: true })).toBe(false);
    expect(isActiveFence({ leaseStatus: "active", attemptStatus: "leased", expiresFresh: false })).toBe(false);
    expect(isActiveFence({ leaseStatus: "active", attemptStatus: "succeeded", expiresFresh: true })).toBe(false);
    expect(classifyFence({ leaseStatus: "active", attemptStatus: "succeeded", expiresFresh: true })).toBe("attempt_terminal");
    expect(classifyFence({ leaseStatus: "active", attemptStatus: "leased", expiresFresh: false })).toBe("stale_fence");
    expect(classifyFence({ leaseStatus: "active", attemptStatus: "leased", expiresFresh: true })).toBeNull();
  });
});
