// server/src/services/job-input-staging.ts
//
// CLI-008 Unit B — THE CONTROL-PLANE STAGING WRITE. The first of the four orphaned
// components on the inbound byte path, given a caller.
//
// It is the exact inversion of DAT-009's export: the control plane authors bytes for a job
// BEFORE the work starts, puts them in object storage, and records a committed
// `job_artifacts` row so the frozen `artifact_transfer_grant` DOWNLOAD branch can later
// prove the object exists and presign a GET for the worker.
//
// ★ WHY THIS DOES NOT USE THE FENCED MUTATORS. `authorizeArtifactCommit`,
// `recordArtifactGrantIntent` and `commitArtifactVersion` are all in `GUARDED_JOB_MUTATORS`
// and each begins with `guardActiveFence`. That machinery is built for the OUTBOUND
// direction — a worker committing its own output under a live fence — and it is unusable
// here BY CONSTRUCTION, not merely by policy: `ActiveFenceRequest` demands `leaseId`,
// `fence`, `workerId`, `targetGeneration`, `profileHash` and `providerConstraintHash`, none
// of which exist before placement mints them. The control plane cannot even construct the
// argument. (Measured: a `leases` row correct in all thirteen identity fields but
// `status='offered'` still throws `stale_fence` — a fence begins at worker ACK, so the whole
// span from admission through placement, offer and ack-in-flight has none.)
//
// `JobArtifactsRepository.insert` is the path that works: a plain, UNGUARDED tenant-repo
// write, not in `GUARDED_JOB_MUTATORS`, never calling `guardActiveFence`. Both remaining
// barriers are real and both are satisfied simply by writing this way:
//   * RLS is enforced — a foreign `organization_id` fails `42501`; satisfied by writing
//     inside `runInTenant(organizationId)`.
//   * The composite FK `job_artifacts_org_job_fk` is enforced — a ghost job fails `23503`;
//     satisfied by staging only for a job that already exists.
// There is no CHECK on `status`, and `attempt`, `lease_id`, `fence_token`, `object_key` and
// `sha256` are all nullable — so `leaseId: null, fenceToken: null` is a legal committed row.
// `job-input-staging.integration.test.ts` pins the no-lease/no-fence property on real
// serving roles, because that property is the whole reason this path was chosen and it is
// the one a future refactor is most likely to break by "tidying" the write behind a guard.
//
// ★ ONE OBJECT PER FILE, NOT ONE BUNDLE ARCHIVE. Each staged file is its own committed
// artifact with its own sha256 and size, which is what `job_artifacts` already models and
// what the frozen grant already addresses. A bundle-document format would need a codec
// shared between the control plane and the sandbox provider, and those two packages have no
// common non-frozen home; per-file artifacts need no codec at all.
//
// ★ THE POINTER RIDES `extensions[]`; THE BYTES DO NOT. Task 1 measured the inline
// `extensions[]` ceiling at 48,960 bytes and chose object storage for the PAYLOAD. The
// worker still has to learn WHICH artifact to fetch and what it should hash to, and the
// frozen envelope has no field for that — `extensions` is the container the protocol
// designates for exactly this ("safe additive data"). The pointer is ~200 bytes per file,
// `critical: false` so a worker that does not understand it ignores it and simply stages
// nothing, which is what keeps staging OPTIONAL.

import { createHash } from "node:crypto";

import type { Db } from "@armyofagents/db";
import {
  WIRE_EXTENSION_LIMITS,
  canonicalizeJsonV1,
  expectedAttemptObjectPrefix,
} from "@armyofagents/worker-protocol";

import { runInTenant } from "../db/tenant-context.js";
import { insertActivity } from "./activity-log.js";
import type { StorageProvider } from "../storage/types.js";

/** `job_artifacts.kind` for a control-plane-authored inbound file. Distinct from every
 * worker-authored kind so a sweep or an audit can tell the directions apart. */
export const STAGED_INPUT_ARTIFACT_KIND = "staged_input";

/** The wire-extension namespace the staged-input pointer travels under. Reverse-DNS with a
 * name, as `wireExtensionSchema`'s namespace regex requires. */
export const STAGED_INPUT_EXTENSION_NAMESPACE = "com.armyofagents.job/staged-input";

/** The pointer payload's schema version, carried on the extension. */
export const STAGED_INPUT_EXTENSION_SCHEMA_VERSION = 1;

/** `activity_log.action` for a control-plane staging write. */
export const STAGED_INPUT_AUDIT_ACTION = "job.staged_input";

/** `activity_log.actor_id` for it. The control plane acts as itself here — no user and no
 * agent authored this, and attributing it to either would be a lie in the one record a
 * founder would consult to find out who put a file in their sandbox. */
export const STAGED_INPUT_AUDIT_ACTOR = "control-plane";

/** A file the control plane wants to exist inside the sandbox before the agent runs. */
export interface StagedInputFile {
  /** The ABSOLUTE in-sandbox path to write. */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Stored on the artifact row for audit; defaults to `application/octet-stream`. */
  readonly contentType?: string;
}

/** What the worker needs to fetch one staged file and prove it got the right bytes. */
export interface StagedInputPointer {
  /** The wire `artifactId` — also the `job_artifacts.identifier`. A UUID, because
   * `artifactIdSchema` brands `uuidSchema`. */
  readonly artifactId: string;
  /** The ABSOLUTE in-sandbox path this object's bytes are written to. */
  readonly path: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface StageJobInputFilesInput {
  readonly appDb: Db;
  readonly storage: StorageProvider;
  readonly organizationId: string;
  /** The Company the audit entry belongs to. `activity_log.company_id` FKs `companies` and is
   * still effectively NOT NULL for this writer — E0-F013 Decision 2 (a2) relaxed the column but
   * kept the guarantee with a CHECK scoped to the reserved `security.denied.` namespace, which
   * this product write is not in — so the tenant Organization alone cannot address the row. The
   * caller has it on `actor.companyId` and passes it down. */
  readonly companyId: string;
  readonly jobId: string;
  /** The attempt's ROW id. The attempt NUMBER (which the object key binds) is resolved from
   * it here — the submission response carries only the id, and deriving the number at the
   * call site would put a tenant read outside the tenant context. */
  readonly attemptId: string;
  readonly files: readonly StagedInputFile[];
  /** Injectable id minter (tests pin the ids). Defaults to `crypto.randomUUID`. */
  readonly newArtifactId?: () => string;
  readonly now?: () => Date;
}

/**
 * Why a stage refused to write anything. ★ NEITHER OF THESE IS A LEGAL RETURN — both throw.
 *
 * | reason | meaning |
 * |---|---|
 * | `unknown_attempt` | the attempt row is absent, invisible under RLS, or belongs to another job |
 * | `pointer_too_large` | the projected extension exceeds the frozen 16,384-byte value budget |
 * | `conflicting_restage` | this attempt already has DIFFERENT bytes committed at that path |
 *
 * Both mean the control plane's files WILL NOT BE THERE. See `StagedInputRefusedError`.
 */
export type StagedInputRefusalReason =
  | "unknown_attempt"
  | "pointer_too_large"
  | "conflicting_restage";

/**
 * A stage that could not honour its postcondition.
 *
 * ★★ WHY THIS THROWS INSTEAD OF RETURNING. A refusal and a success are not two outcomes of
 * one operation — a refusal means the sandbox will start WITHOUT the files the control plane
 * meant it to have, while placement runs, the attempt becomes leasable, and the legacy adapter
 * is suppressed. A worker then runs the agent with no MCP config and no instructions and
 * reports success: a silent wrong-content execution. Returning that outcome puts the burden of
 * noticing on a caller that provably cannot — the port type is `Promise<{staged: boolean}>`
 * (`run-execution-owner.ts:117`) and the composition root narrows the reason away before the
 * caller ever sees it.
 *
 * Throwing puts the decision where the reason exists. `resolveExecutionOwner`'s catch already
 * releases the claimed capacity and returns `transfer_error`, and its comment already says
 * *"A throw here is a LEGACY run, not a broken one"* — this makes that sentence true rather
 * than aspirational. Placement has not run, so no attempt is left leasable.
 */
export class StagedInputRefusedError extends Error {
  readonly reason: StagedInputRefusalReason;

  constructor(reason: StagedInputRefusalReason, detail: string) {
    super(`[cli-008] staged input refused (${reason}): ${detail}`);
    this.name = "StagedInputRefusedError";
    this.reason = reason;
  }
}

/**
 * ★★★ THE UNION IS NARROW ON PURPOSE, AND THAT IS THE LOAD-BEARING HALF OF THIS FIX.
 *
 * `no_files` is the only non-throwing `staged: false`, and the TYPE now states it: the caller
 * asked for nothing, so the postcondition holds vacuously. There is nowhere left to put a new
 * refusal that a caller would ignore — adding one means either widening this union (which reds
 * every exhaustive consumer) or throwing (which is correct). A silent refusal cannot be
 * introduced by accident, which is exactly how this one was introduced.
 */
export type StageJobInputFilesResult =
  | { readonly staged: false; readonly reason: "no_files" }
  | { readonly staged: true; readonly attempt: number; readonly pointers: readonly StagedInputPointer[] };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Would the ATTEMPT'S POINTER — everything already committed, plus what this call adds — fit
 * the frozen per-extension value budget?
 *
 * ★ WHY THIS IS A REFUSAL AND NOT A SURPRISE. The pointer is small — about 200 bytes a file —
 * but `valueMaxCanonicalBytes` is 16,384, so somewhere past ~70 files the extension stops
 * being wire-legal. `buildJobEnvelope` would then `safeParse` to null, the poll would raise
 * `internal_unavailable`, and the job would be PERMANENTLY UNLEASEABLE with nothing anywhere
 * naming the cause. Refusing here — before a single byte is written, with an attributable
 * reason the caller can act on — turns an undiagnosable cliff into an answer.
 *
 * ★★★ E7-F009 — IT USED TO PROJECT `input.files` ALONE, WHICH IS THE WRONG SET. The offer is
 * built from ALL committed rows for the attempt (`job-leasing.ts:628` `listForJob` → `:638`
 * `stagedInputPointersFromRows` → `:399` `stagedInputExtension`), so repeated stages against
 * one attempt inflated the REAL extension past the budget while every individual call reported
 * "fits". The front door was closed and the side door was not, and the side door led to
 * verbatim the cliff the refusal was written to prevent.
 *
 * The route was never the duplicate-row defect that was fixed alongside it: same-digest
 * restages replay and add nothing, different-digest restages now throw, but a second stage
 * adding a DIFFERENT PATH still appends committed rows. So the fix is the UNION, not a dedupe
 * at the reader — a dedupe would make this unreachable by accident and leave the projection
 * measuring the wrong set for the next multi-stage caller, which is a false claim of
 * enforcement rather than a guard.
 *
 * `existing` is deduped against by PATH: a file already committed at the same path either
 * replays (adding no row) or throws (`conflicting_restage`), so counting it twice would refuse
 * a bundle that fits. The union is the post-condition set — what `listForJob` will return
 * after this call — which is exactly what the offer will project.
 *
 * Computed from placeholder ids of the exact minted LENGTH (a uuid is 36 chars, a sha256 hex
 * digest is 64), so the projection is an upper bound on the real pointer rather than a guess.
 *
 * EXPORTED FOR TEST. The multi-stage route that reaches the union is only exercisable against
 * a real database, and the suite that has one is `job-input-staging.integration.test.ts` —
 * which does not run on every developer's machine. An untestable guard is a guard nobody can
 * prove is a guard, and F009's whole lesson is about a projection that measured the wrong set
 * unnoticed. Both lanes assert it: this one directly, that one end to end.
 */
export function pointerFitsExtension(
  existing: readonly StagedInputPointer[],
  files: readonly StagedInputFile[],
  prefix: string,
): boolean {
  const placeholderId = "0".repeat(36);
  const project = (path: string, size: number) => ({
    id: placeholderId,
    path,
    key: `${prefix}${placeholderId}`,
    sha256: "0".repeat(64),
    size,
  });
  const existingPaths = new Set(existing.map((pointer) => pointer.path));
  const projected = {
    files: [
      ...existing.map((pointer) => project(pointer.path, pointer.sizeBytes)),
      ...files
        .filter((file) => !existingPaths.has(file.path))
        .map((file) => project(file.path, file.bytes.byteLength)),
    ],
  };
  const bytes = new TextEncoder().encode(canonicalizeJsonV1(projected)).length;
  return bytes <= WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes;
}

/**
 * Stage `files` for a job that ALREADY EXISTS, before its attempt becomes leasable.
 *
 * Order is load-bearing: the object goes to the store FIRST and the committed row LAST, so a
 * committed row always has bytes behind it. The reverse order would let the download branch
 * prove existence for an object that is not there yet and presign a GET that 404s inside the
 * sandbox. If the row write fails the object is deleted best-effort — the storage port has no
 * list operation, so an object nobody recorded can never be found again.
 *
 * Idempotent per (attempt, path, digest): a replayed stage that finds a committed staged-input
 * row for the same path and digest reuses it instead of writing a second object. The
 * identifier is minted, so a replay is recognised by scanning this attempt's rows rather than
 * by guessing the id. DIFFERENT bytes at an already-staged path are REFUSED, not
 * superseded — see the `conflicting_restage` check.
 */
export async function stageJobInputFiles(
  input: StageJobInputFilesInput,
): Promise<StageJobInputFilesResult> {
  if (input.files.length === 0) return { staged: false, reason: "no_files" };

  const newArtifactId = input.newArtifactId ?? (() => crypto.randomUUID());
  const now = input.now ?? (() => new Date());

  // 1. Resolve the attempt NUMBER and this attempt's existing staged rows, in ONE tenant
  //    transaction. RLS supplies the organization; an attempt in another tenant simply is
  //    not visible, which is the refusal we want rather than an error to interpret.
  const resolved = await runInTenant(input.appDb, input.organizationId, async (repos) => {
    const attempt = await repos.attempts.getById(input.attemptId);
    if (!attempt || attempt.jobId !== input.jobId || typeof attempt.attemptNumber !== "number") {
      return null;
    }
    const rows = await repos.jobArtifacts.listForJob(input.jobId);
    return { attempt: attempt.attemptNumber, rows };
  });
  if (!resolved) {
    throw new StagedInputRefusedError(
      "unknown_attempt",
      `attempt ${input.attemptId} is not a visible attempt of job ${input.jobId}`,
    );
  }

  const existing = stagedInputPointersFromRows(resolved.rows, resolved.attempt);
  const prefix = expectedAttemptObjectPrefix({
    organizationId: input.organizationId,
    jobId: input.jobId,
    attempt: resolved.attempt,
  });
  // 1b. Refuse a bundle whose POINTER could not ride the envelope, BEFORE a byte moves.
  //     E7-F009: measured against the ATTEMPT's post-condition set (`existing` ∪ new), which
  //     is what the offer projects — not against this call's files alone.
  if (!pointerFitsExtension(existing, input.files, prefix)) {
    throw new StagedInputRefusedError(
      "pointer_too_large",
      `${input.files.length} new file(s) on top of ${existing.length} already committed project past the ${WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes}-byte extension budget`,
    );
  }

  // 1c. ★★ P2-b — REFUSE A RESTAGE THAT WOULD CHANGE BYTES AT AN ALREADY-STAGED PATH.
  //
  // The replay probe below matches on path AND digest, so identical bytes reuse the committed
  // row. DIFFERENT bytes at the same path used to mint a SECOND committed row: the partial
  // unique index keys on `identifier` (`organization_id, job_id, attempt, identifier WHERE
  // status='committed'`), which is minted per stage, so nothing stopped it — and `listForJob`
  // has NO `ORDER BY`, so which of the two the offer carried was genuinely unspecified. A run
  // would receive one of two versions of its own instructions, chosen by the query planner.
  //
  // ★ REFUSING rather than SUPERSEDING is deliberate, and the reason is a race, not tidiness.
  // `aoa_app` does hold UPDATE and DELETE here, so superseding is available — but by the time a
  // second stage arrives the worker may already hold, or be mid-fetch on, the first pointer.
  // Deleting the old object races a download; keeping it is a deliberate permanent orphan; and
  // either way the attempt briefly has two truths. A refusal has none of that: it is the only
  // outcome that cannot produce mixed content, and changed content means a new attempt, which
  // is how this path is used. Fail-closed, before a byte moves.
  const conflicting = input.files.find((file) =>
    existing.some((p) => p.path === file.path && p.sha256 !== sha256Hex(file.bytes)),
  );
  if (conflicting) {
    throw new StagedInputRefusedError(
      "conflicting_restage",
      `${conflicting.path} already has different bytes committed for attempt ${resolved.attempt}`,
    );
  }


  const pointers: StagedInputPointer[] = [];
  const pending: Array<{ pointer: StagedInputPointer; contentType: string }> = [];
  // ★★ P2-a — THE UPLOAD LOOP IS INSIDE THE COMPENSATION. It used to sit outside, so a
  // failure on the SECOND file left the FIRST file's object stored with no row naming it. The
  // storage port has no list operation, so an object nobody recorded can never be found again:
  // these orphans are permanent AND undiscoverable, and they accumulate silently, one per
  // partial stage, for the life of the bucket. `pending` is appended to as the loop goes, so
  // the catch always covers exactly what was actually written — a partial loop included.
  try {
    for (const file of input.files) {
      const sha256 = sha256Hex(file.bytes);
      const replay = existing.find((p) => p.path === file.path && p.sha256 === sha256);
      if (replay) {
        pointers.push(replay);
        continue;
      }
      const artifactId = newArtifactId();
      const pointer: StagedInputPointer = {
        artifactId,
        path: file.path,
        objectKey: `${prefix}${artifactId}`,
        sha256,
        sizeBytes: file.bytes.byteLength,
      };
      // 2. The bytes, BEFORE the row.
      await input.storage.putObject({
        objectKey: pointer.objectKey,
        body: Buffer.from(file.bytes),
        contentType: file.contentType ?? "application/octet-stream",
        contentLength: pointer.sizeBytes,
      });
      pending.push({ pointer, contentType: file.contentType ?? "application/octet-stream" });
      pointers.push(pointer);
    }

    if (pending.length > 0) {
      // 3. The committed rows. ★ NO LEASE, NO FENCE — `leaseId` and `fenceToken` are null and
      //    no fence has ever existed for this attempt. That is the property that makes an
      //    inbound write possible at all; do not "tidy" this behind `guardActiveFence`, which
      //    cannot be satisfied here and would remove the capability rather than secure it.
      await runInTenant(input.appDb, input.organizationId, async (repos, tx) => {
        for (const entry of pending) {
          await repos.jobArtifacts.insert({
            organizationId: input.organizationId,
            jobId: input.jobId,
            identifier: entry.pointer.artifactId,
            attempt: resolved.attempt,
            objectKey: entry.pointer.objectKey,
            sha256: entry.pointer.sha256,
            sizeBytes: entry.pointer.sizeBytes,
            contentType: stagedPathMarker(entry.pointer.path),
            kind: STAGED_INPUT_ARTIFACT_KIND,
            status: "committed",
            leaseId: null,
            fenceToken: null,
            committedAt: now(),
          });
        }

        // 3b. ONE BUNDLE-LEVEL AUDIT ENTRY, in the SAME transaction as the rows.
        //
        // ★ Why the control plane writing files into a tenant's sandbox must be visible: this is
        // the one mutation on the inbound path that the tenant can neither see nor undo. The
        // artifact rows are the mechanism's own bookkeeping; nothing renders them, and nothing
        // in the Activity feed would otherwise say that content was placed inside a run.
        //
        // ★ ONE ENTRY, NOT ONE PER FILE. A bundle is a single control-plane act. Per-file rows
        // would flood a tenant's feed with the mechanism's granularity instead of the decision's.
        //
        // ★★ NO BYTES AND NO SECRET MATERIAL. Paths, digests and a count — enough to answer
        // "what was placed, and is it what I think it is" and nothing more. The staged files are
        // exactly the kind of content (MCP configs, credentials-adjacent instructions) whose
        // BYTES must never reach a durable, broadly-readable audit surface. `insertActivityLog`
        // sanitizes `details`, but relying on a sanitizer to remove what should never have been
        // added is the wrong order.
        //
        // ★ `runId: null` is FORCED, exactly as the JOB-013 audit bridge forces it:
        // `activity_log.run_id` FKs `heartbeat_runs`, and a distributed attemptId is not a
        // heartbeat run — passing one through would 23503 and roll back the artifact rows with it.
        //
        // Same transaction as the rows, so the two cannot disagree. Of the two failure modes an
        // audit row with no artifacts is worse than artifacts with no audit row, but one
        // transaction avoids both, and the rows are already written inside one `runInTenant`.
        await insertActivity(tx, {
          companyId: input.companyId,
          actorType: "system",
          actorId: STAGED_INPUT_AUDIT_ACTOR,
          action: STAGED_INPUT_AUDIT_ACTION,
          entityType: "job",
          entityId: input.jobId,
          runId: null,
          details: {
            attempt: resolved.attempt,
            fileCount: pending.length,
            // Paths and digests only — deliberately not `objectKey`, which is a storage
            // address, and never the bytes.
            files: pending.map((entry) => ({
              path: entry.pointer.path,
              sha256: entry.pointer.sha256,
              sizeBytes: entry.pointer.sizeBytes,
            })),
          },
        });
      });
    }
  } catch (error) {
    // The row is the only durable record of the object; without it the object is unfindable
    // (the storage port has no list operation). Remove everything this call wrote — whether
    // the failure came from an upload mid-loop or from the row/audit transaction.
    //
    // Best-effort per object, and never masking the original error: a delete that fails leaves
    // an orphan, which is the condition we are already in, whereas throwing from the cleanup
    // would replace the real cause with a janitor complaint.
    for (const entry of pending) {
      await input.storage.deleteObject({ objectKey: entry.pointer.objectKey }).catch(() => undefined);
    }
    throw error;
  }

  return { staged: true, attempt: resolved.attempt, pointers };
}

/**
 * The in-sandbox path, encoded into the row's `content_type`.
 *
 * ★ This is deliberate and it is ugly, so it is documented rather than hidden. `job_artifacts`
 * has no path column, and adding one is a migration this unit does not need: the row already
 * carries a free-form `content_type`, no consumer parses it, and the staged-input rows are
 * identified by `kind = 'staged_input'` so the encoding can never be mistaken for a real
 * media type on a worker-authored row. A path column belongs with Unit E's workspace work,
 * where more than one consumer will want it.
 */
export function stagedPathMarker(path: string): string {
  return `application/vnd.aoa.staged-input; path=${path}`;
}

/** Recover the in-sandbox path from a staged-input row's marker, or `null` if it is not one. */
export function stagedPathFromMarker(marker: string | null | undefined): string | null {
  if (typeof marker !== "string") return null;
  const match = /^application\/vnd\.aoa\.staged-input; path=(.+)$/.exec(marker);
  return match?.[1] ?? null;
}

/**
 * The wire extension carrying this attempt's staged-input pointers.
 *
 * `critical: false` is load-bearing twice over. The frozen refiner fails EVERY unknown
 * `critical: true` extension closed, so a critical pointer would make every existing worker
 * reject the offer outright; and a worker that does not understand this namespace must
 * simply not stage, which is the "staging is optional" property Task 5 asserts.
 */
export function stagedInputExtension(pointers: readonly StagedInputPointer[]): {
  namespace: string;
  schemaVersion: number;
  critical: false;
  value: { files: Array<{ id: string; path: string; key: string; sha256: string; size: number }> };
} {
  return {
    namespace: STAGED_INPUT_EXTENSION_NAMESPACE,
    schemaVersion: STAGED_INPUT_EXTENSION_SCHEMA_VERSION,
    critical: false,
    value: {
      files: pointers.map((pointer) => ({
        id: pointer.artifactId,
        path: pointer.path,
        key: pointer.objectKey,
        sha256: pointer.sha256,
        size: pointer.sizeBytes,
      })),
    },
  };
}

/** A durable `job_artifacts` row, narrowed to what the pointer needs. */
export interface StagedInputArtifactRow {
  readonly identifier: string;
  readonly attempt: number | null;
  readonly objectKey: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly kind: string | null;
  readonly status: string | null;
}

/**
 * Rebuild this attempt's staged-input pointers from the durable rows.
 *
 * The lease path reads the ROWS, never the staging call's return value: the offer is built
 * in a different transaction, minutes later, possibly in a different process. A pointer that
 * could only be produced by the process that staged it would be no pointer at all.
 *
 * Sorted by in-sandbox path so an offer for the same attempt is byte-identical across
 * replays — the envelope is hashed downstream.
 */
export function stagedInputPointersFromRows(
  rows: readonly StagedInputArtifactRow[],
  attempt: number,
): StagedInputPointer[] {
  const pointers: StagedInputPointer[] = [];
  for (const row of rows) {
    if (row.status !== "committed") continue;
    if (row.kind !== STAGED_INPUT_ARTIFACT_KIND) continue;
    if (row.attempt !== attempt) continue;
    const path = stagedPathFromMarker(row.contentType);
    if (!path || !row.objectKey || !row.sha256 || typeof row.sizeBytes !== "number") continue;
    pointers.push({
      artifactId: row.identifier,
      path,
      objectKey: row.objectKey,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
    });
  }
  return pointers.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
