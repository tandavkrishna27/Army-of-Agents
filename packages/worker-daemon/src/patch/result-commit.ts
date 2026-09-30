/**
 * CLI-003/D4 — the fenced, idempotent RESULT COMMIT (the DAT-003 producer's first
 * worker-daemon consumer).
 *
 * After a coding run finishes, its result files are captured (via the CLI-002
 * `readFile`/`listDir` staging seam — a provider-neutral, DAT-001 capture concern),
 * diffed against the run's base into a frozen `WorkspacePatchManifestV1` by
 * {@link buildWorkspacePatch}, and committed to the control plane. This module owns
 * the two acceptance invariants of that commit:
 *
 *   - §2.3 OUTPUT CANNOT COMMIT AFTER LEASE LOSS. The commit is gated through the
 *     WRK-005 {@link FenceCloseProxy}.`commit()` worker-side authority: once the
 *     fence closes (lease lost / renew rejected / cancel / completion) the commit
 *     throws {@link FenceClosedError} LOCALLY, BEFORE the round-trip — the server's
 *     `guardActiveFence`-first half (DAT-002/003) is the real gate, this is defense
 *     in depth so a doomed commit never even leaves the worker.
 *   - §2.2 DUPLICATE RESULT DELIVERY IS HARMLESS. Idempotency keys on the ARTIFACT
 *     IDENTITY (`patchInput.artifactId`), NEVER the non-unique `versionNumber`
 *     (`job-control.ts:2489`): a re-delivered commit returns the recorded outcome
 *     and performs no second round-trip. The server half is ALSO idempotent
 *     (DAT-002 `onConflictDoNothing`-returns-existing), so this is belt-and-suspenders.
 *
 * The actual round-trip is injected as `commitVia` — in the wired world it serializes
 * the frozen `artifact_commit` request and calls the daemon transport client's
 * `artifactCommit` (CLI-003/D4). The live presigned upload of the patch object
 * (transfer-grant → PUT → commit, DAT-002 slice 7) is a documented CLI-003 non-goal;
 * this module commits an already-addressable patch manifest.
 *
 * Boundary-legal: relative modules + the frozen worker-protocol type only (E4-D01).
 */

import type { WorkspacePatchManifestV1 } from "@armyofagents/worker-protocol";

import type { GovernedEffectAuthority } from "../lease/fence-close-proxy.js";
import { buildWorkspacePatch, type BuildWorkspacePatchInput } from "./build-patch.js";

/** The outcome of a control-plane artifact commit, as the caller's `commitVia`
 * resolves it from the server response. `versionNumber` is server-assigned and NOT
 * an idempotency key (the artifact identity is). */
export interface ArtifactCommitOutcome {
  readonly committed: boolean;
  readonly artifactId: string;
  readonly versionNumber?: number;
}

export interface CommitRunResultInput {
  /** The WRK-005 worker-side fence gate. A closed fence denies the commit locally. */
  readonly proxy: GovernedEffectAuthority;
  /** The base→result manifests + identity the DAT-003 producer diffs into a patch. */
  readonly patchInput: BuildWorkspacePatchInput;
  /** The injected round-trip: serialize + POST the frozen `artifact_commit` request. */
  readonly commitVia: (patch: WorkspacePatchManifestV1) => Promise<ArtifactCommitOutcome>;
}

export interface ResultCommitter {
  /** Build + fenced-idempotently commit a run's result. Throws {@link FenceClosedError}
   * (from the proxy) if the fence has closed before a first commit of this artifact. */
  commit(input: CommitRunResultInput): Promise<ArtifactCommitOutcome>;
}

/**
 * A per-run result committer. Its idempotency ledger is scoped to this instance
 * (one per run), keyed on artifact identity — so a duplicate delivery WITHIN the run
 * is a no-op, while distinct runs never share state.
 */
export function createResultCommitter(): ResultCommitter {
  // artifactId → recorded outcome (idempotency key = artifact identity, NOT versionNumber).
  const committed = new Map<string, ArtifactCommitOutcome>();
  // artifactId → the single in-flight commit, so CONCURRENT same-artifact deliveries
  // share ONE round-trip instead of racing the check-then-act on `committed`.
  const inFlight = new Map<string, Promise<ArtifactCommitOutcome>>();

  return {
    async commit(input: CommitRunResultInput): Promise<ArtifactCommitOutcome> {
      const artifactId = input.patchInput.artifactId;

      // §2.2 — a re-delivery of an already-committed artifact returns the recorded
      // outcome and performs NO second round-trip (and never re-touches the gate, so
      // a duplicate arriving after fence close is still a harmless no-op).
      const existing = committed.get(artifactId);
      if (existing !== undefined) return existing;
      // A concurrent in-flight commit of the same artifact: await it (one round-trip).
      const pending = inFlight.get(artifactId);
      if (pending !== undefined) return pending;

      const run = (async () => {
        // Build the frozen patch (the DAT-003 producer self-validates fail-closed).
        const { patch } = buildWorkspacePatch(input.patchInput);
        // §2.3 — gate the round-trip through the fence proxy: a closed fence throws
        // FenceClosedError HERE, before `commitVia` runs, so nothing crosses the wire.
        // (A concurrent lease loss after the check is caught server-side by
        // guardActiveFence, not this worker-side proxy — belt-and-suspenders.)
        const outcome = await input.proxy.commit(() => input.commitVia(patch));
        committed.set(artifactId, outcome);
        return outcome;
      })();
      inFlight.set(artifactId, run);
      try {
        return await run;
      } finally {
        // A failed commit (e.g. FenceClosedError) is NOT cached — a later retry may
        // legitimately re-attempt; only a successful outcome sticks in `committed`.
        inFlight.delete(artifactId);
      }
    },
  };
}
