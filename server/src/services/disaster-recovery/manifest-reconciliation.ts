// REL-003 (E11) — recovered-manifest object reconciliation (Lane A).
//
// After a disaster-recovery database + object-store restore, the authoritative
// object set is the `job_artifacts` rows with `status='committed'` (D1 — the
// `granted`/`quarantined` rows are disjoint, non-authoritative states). Recovery
// is only trustworthy if EVERY such object restores with matching bytes/hash/size
// and under its correct tenant/attempt prefix. This pure verifier decides that,
// object by object, over the recorded manifest row × a live `headObject` probe.
//
// It is PURE and side-effect free: the caller (the rehearsal harness below, and
// the operator runbook step 6) fetches the committed rows and probes each object's
// bytes via `StorageProvider.headObject`, then hands both to the verifier. No
// database, no network — so every branch is provable without live infra.
//
// It reuses the FROZEN worker-protocol vocabulary (`expectedAttemptObjectPrefix`
// for the scope/DE-23 check, `QUARANTINE_REASONS` for the disposition names) and
// invents no new vocabulary (D3). Fail-closed throughout (D2): an object the store
// cannot checksum is `hash_unverifiable`, never `verified`.

import { expectedAttemptObjectPrefix, isSafeWorkspacePath, QUARANTINE_REASONS } from "@armyofagents/worker-protocol";
import type { HeadObjectResult } from "../../storage/types.js";

/**
 * An authoritative committed-artifact row from `job_artifacts` (status='committed'),
 * projected to the fields reconciliation decides over. The caller extracts these
 * from the committed set; a committed row's completeness (non-null object_key /
 * sha256 / size_bytes / attempt) is the DAT-002 application invariant.
 */
export interface RecoveredManifestRow {
  organizationId: string;
  jobId: string;
  attempt: number;
  /** `job_artifacts.identifier` — the opaque artifact id. */
  artifactId: string;
  /** `job_artifacts.object_key` — the store key the bytes live under. */
  objectKey: string;
  /** `job_artifacts.sha256` — the recorded content hash (hex). */
  sha256: string;
  /** `job_artifacts.size_bytes` — the recorded byte size. */
  sizeBytes: number;
}

/**
 * Per-object disposition. `verified` is the ONLY promotable/served state. The
 * failure dispositions reuse the FROZEN `QUARANTINE_REASONS` names where they map
 * (`hash_mismatch` / `size_mismatch` / `wrong_prefix`), plus two non-quarantine
 * verdict-failing states: `missing` (nothing to quarantine) and `hash_unverifiable`
 * (the store could not supply a checksum — fail closed).
 */
export type ReconciliationDisposition =
  | "verified"
  | "wrong_prefix"
  | "missing"
  | "hash_unverifiable"
  | "hash_mismatch"
  | "size_mismatch";

export interface ReconciledObject {
  artifactId: string;
  objectKey: string;
  disposition: ReconciliationDisposition;
}

export type ReconciliationVerdict = "recovered" | "failed";

export interface RecoveredManifestReconciliation {
  /** `recovered` iff EVERY authoritative row is `verified`; otherwise `failed`. */
  verdict: ReconciliationVerdict;
  /** One entry per authoritative row, in input order. */
  objects: ReconciledObject[];
  /** Object keys safe to promote/serve — ONLY `verified` objects (I7). */
  promoted: string[];
  /** Object keys with a FROZEN-vocabulary quarantine disposition
   * (`hash_mismatch` / `size_mismatch` / `wrong_prefix`). `missing` and
   * `hash_unverifiable` are verdict-failing but have nothing to quarantine. */
  quarantined: string[];
}

/** The FROZEN quarantine-reason members a failure disposition maps onto (D3). */
const QUARANTINE_DISPOSITIONS: ReadonlySet<string> = new Set(QUARANTINE_REASONS);

/**
 * Classify one authoritative row against its live store probe. Each numbered guard
 * is an independent, deletable line (the mutation table §7: DELETE a guard, the
 * named test turns RED). Order is fail-closed and provenance-first: the scope check
 * (DE-23) runs before any byte is trusted, then existence, then the fail-closed
 * unverifiable check ahead of the hash compare, then hash, then size.
 */
function classifyObject(
  row: RecoveredManifestRow,
  probe: HeadObjectResult | undefined,
): ReconciliationDisposition {
  // A-G4 (scope / DE-23): the key must be a SAFE relative POSIX key under this
  // row's own org/job/attempt prefix — the exact `objectKeyHasPrefix` semantics the
  // FROZEN worker-protocol commit schema enforces (no `..`/absolute/backslash/NUL,
  // and a non-empty suffix after the prefix). A key outside it, or an unsafe key a
  // compromised restore planted, is a foreign/misplaced object, never `verified`.
  const prefix = expectedAttemptObjectPrefix({
    organizationId: row.organizationId,
    jobId: row.jobId,
    attempt: row.attempt,
  });
  if (!(isSafeWorkspacePath(row.objectKey) && row.objectKey.startsWith(prefix) && row.objectKey.length > prefix.length)) {
    return "wrong_prefix";
  }
  // A-G1 (existence): a probe reporting the object absent (or no probe at all) is
  // `missing` — nothing to quarantine, but the recovery cannot pass.
  if (!probe || probe.exists !== true) {
    return "missing";
  }
  // A-G5 (fail-closed, D2): the store could not supply a checksum (undefined, or an
  // empty string a future provider might emit). An unverifiable object is never
  // `verified` — a recovery cannot pass on bytes it could not integrity-check.
  // Checked BEFORE the hash compare so an absent checksum is not read as an ordinary
  // mismatch. Falsy (not `=== undefined`) so an empty checksum fails closed too.
  if (!probe.checksumSha256) {
    return "hash_unverifiable";
  }
  // A-G2 (hash): the restored bytes must hash to the recorded sha256.
  if (probe.checksumSha256 !== row.sha256) {
    return "hash_mismatch";
  }
  // A-G3 (size): the restored byte length must equal the recorded size.
  if (probe.contentLength !== row.sizeBytes) {
    return "size_mismatch";
  }
  return "verified";
}

/**
 * Reconcile the recovered authoritative manifest against the store. `probes` maps
 * each object key to its `headObject` result. Pure; the verdict is `recovered` iff
 * every row verifies (I6).
 */
export function evaluateRecoveredManifestReconciliation(
  manifest: readonly RecoveredManifestRow[],
  probes: ReadonlyMap<string, HeadObjectResult>,
): RecoveredManifestReconciliation {
  const objects: ReconciledObject[] = manifest.map((row) => ({
    artifactId: row.artifactId,
    objectKey: row.objectKey,
    disposition: classifyObject(row, probes.get(row.objectKey)),
  }));
  // A-G6 (verdict): recovered iff EVERY object verified; any non-verified row fails
  // the whole recovery (missing-required-blocks-pass).
  const verdict: ReconciliationVerdict = objects.every((o) => o.disposition === "verified")
    ? "recovered"
    : "failed";
  // A-G7 (promoted exclusion): ONLY `verified` objects may be promoted/served.
  const promoted = objects.filter((o) => o.disposition === "verified").map((o) => o.objectKey);
  const quarantined = objects
    .filter((o) => QUARANTINE_DISPOSITIONS.has(o.disposition))
    .map((o) => o.objectKey);
  return { verdict, objects, promoted, quarantined };
}

/**
 * The rehearsal harness — the production caller that keeps the verifier from being
 * orphaned (I8; the REL-004 anti-orphan lesson). It fetches nothing itself: the
 * operator wires `rows` to the committed `job_artifacts` set and `headObject` to the
 * live `StorageProvider.headObject`, then this probes every row's object and routes
 * the pair through `evaluateRecoveredManifestReconciliation`. Removing the verifier
 * call cannot produce a correct verdict, so the I8 test fails.
 */
export async function runManifestReconciliation(input: {
  rows: readonly RecoveredManifestRow[];
  headObject: (objectKey: string) => Promise<HeadObjectResult>;
}): Promise<RecoveredManifestReconciliation> {
  const probes = new Map<string, HeadObjectResult>();
  for (const row of input.rows) {
    probes.set(row.objectKey, await input.headObject(row.objectKey));
  }
  return evaluateRecoveredManifestReconciliation(input.rows, probes);
}
