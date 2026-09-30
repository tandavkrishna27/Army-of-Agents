// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the server-side CREATE gate.
//
// A DISTINCT shape from `gateOwnedOp` (there is no existing sandbox to inspect): it
// is verify -> spec-label match -> the durable ledger -> `provider.create`. Gating
// `create` is what the durable, identity-namespaced ledger FORCES — the provider's
// own `#idempotency` (`e2b-provider.ts:156`) is keyed by the worker-chosen
// `idempotencyKey` ALONE and sits BELOW the gate, so identity-namespacing has to
// happen at the server layer, which means `create` must carry the capability.
//
// Gating `create` ALSO closes the separate "arbitrary foreign labels on a new
// sandbox" hole: the caller may create ONLY its OWN-labeled sandbox
// (`labelsEqual(spec.resourceLabels, cap.ownedLabels)`), else the uniform refusal.
//
// ★ THE STRIP. `provider.create` is called with `idempotencyKey: ""`. The provider's
// key-alone `#idempotency` would otherwise HIT tenant A's entry on tenant B's replay
// of A's key and hand B tenant A's `{sandboxId, resourceLabels}` — a leak THROUGH the
// provider. Stripping makes the durable ledger the SOLE idempotency authority with no
// residual (a legit replay is a ledger HIT that bypasses the provider entirely).
//
// ★ CONCURRENCY. A per-(identity,key) mutex spans check -> create -> record so two
// same-key creates on ONE instance can't both miss and double-provision. PLUS a
// check-after-create: when the write-once CAS reports `already_present` (a concurrent
// writer — another replica sharing the ledger volume, or a defeated in-process mutex —
// won), re-read the winner, RETURN it, and TEAR DOWN this call's just-created loser so
// exactly one sandbox survives. The cross-replica case itself (a shared-volume ledger)
// is deploy-owed (β1.6); the check-after-create MECHANISM ships here.
// -----------------------------------------------------------------------------

import type { KeyObject } from "node:crypto";

import type { CreateResult, CreateSandboxSpec, ProviderOpContext, SandboxProvider } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError, labelsEqual } from "@armyofagents/worker-daemon";
import type { OwnedLabelsCapability } from "@armyofagents/provider-wire";

import { verifyOrUniform } from "./owned-op-gate.js";
import { IdempotencyLedgerError, type IdempotencyLedger, type LedgerRecord } from "./idempotency-ledger.js";
import type { KeyedMutex } from "./keyed-mutex.js";

export interface CreateGateDeps {
  readonly provider: SandboxProvider;
  readonly controlPlanePublicKey: KeyObject;
  /** ms-epoch clock for the capability expiry check. */
  readonly now: () => number;
  /** The durable, identity-namespaced idempotency ledger (the SOLE idempotency layer). */
  readonly ledger: IdempotencyLedger;
  /** The AM-local per-(identity,key) mutex spanning check -> create -> record. */
  readonly createLock: KeyedMutex;
}

/**
 * Gate a `create`. Returns the created (or ledger-replayed) `CreateResult`, or throws
 * the UNIFORM ResourceNotAvailableError on any refusal (absent/invalid capability, or
 * a spec whose labels are not the caller's own).
 */
export async function gateCreate(
  deps: CreateGateDeps,
  spec: CreateSandboxSpec,
  ctx: ProviderOpContext,
  capability: OwnedLabelsCapability | undefined,
): Promise<CreateResult> {
  const { provider, controlPlanePublicKey, now, ledger, createLock } = deps;

  // 1. Verify FIRST, OUTSIDE the mutex (fail-closed — an unauthenticated caller must
  //    never acquire a per-key lock).
  const ownedLabels = verifyOrUniform(capability, controlPlanePublicKey, now());

  // 2. The caller may create ONLY its OWN-labeled sandbox. A foreign spec-label tuple is
  //    refused IDENTICALLY to an absent capability (the uniform error — no oracle).
  if (!labelsEqual(spec.resourceLabels, ownedLabels)) {
    throw new ResourceNotAvailableError();
  }

  // 3. The durable ledger key = the UNAMBIGUOUS (identity, idempotencyKey). The mutex is
  //    keyed by the SAME string, so check -> create -> record is serialized per key.
  const key = ledger.key(ownedLabels, ctx.idempotencyKey);

  return createLock.runExclusive(key, async () => {
    const hit = ledger.lookup(key);
    if (hit) return replay(hit); // legit replay — BYPASS provider.create

    // MISS -> provision with a STRIPPED idempotencyKey (the ledger is the sole layer).
    const created = await provider.create(spec, { ...ctx, idempotencyKey: "" });
    const outcome = ledger.record(key, { sandboxId: created.sandboxId, resourceLabels: created.resourceLabels });

    if (outcome === "already_present") {
      // A concurrent writer won the CAS. We are DEFINITIVELY a loser — `link()` EEXIST'd on
      // ANOTHER writer's entry, and each provider.create mints a fresh id, so our
      // just-created sandbox is a duplicate. Tear it down FIRST, before the fallible winner
      // re-read, so a corrupt/failed lookup can never STRAND it as an orphan (review LOW).
      await teardownLoser(provider, created.sandboxId, ctx);
      const winner = ledger.lookup(key);
      // The CAS reported the slot present, so a correct FS always reads it back; a `null`
      // here is unreachable on a sound FS — fail closed rather than replay a missing record.
      if (!winner) throw new IdempotencyLedgerError();
      return replay(winner);
    }
    return created;
  });
}

/** Synthesize a `CreateResult` from a recorded ledger entry — served WITHOUT touching
 * the provider, so `providerOpId` names the ledger, not a provider op. */
function replay(record: LedgerRecord): CreateResult {
  return { sandboxId: record.sandboxId, resourceLabels: record.resourceLabels, providerOpId: `ledger-replay:${record.sandboxId}` };
}

/** Tear down a create that lost the ledger CAS. BEST-EFFORT: the winner return is what
 * matters; a failed teardown leaves a TTL-bounded orphan (the deploy-owed crash-orphan
 * class, β1.6) rather than failing an otherwise-successful create. */
async function teardownLoser(provider: SandboxProvider, sandboxId: string, ctx: ProviderOpContext): Promise<void> {
  try {
    await provider.destroy(sandboxId, ctx);
  } catch {
    // Swallow — the caller's create succeeded (the winner is valid); a live loser is
    // bounded by the sandbox TTL and reconciled later.
  }
}
