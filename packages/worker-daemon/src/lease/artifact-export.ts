/**
 * DAT-009 slice 3 — the worker-side ARTIFACT EXPORT consumer: digest → grant → export → commit.
 *
 * The UPLOAD mirror of `lease/staged-input.ts`, and the first production consumer of the
 * DAT-002 grant pipeline. Design:
 * `docs/replatform/epics/E5-workspaces-secrets/tickets/DAT-009-slice-3-design.md`.
 *
 * ★ GRANTS OUT, NEVER BYTES — in this direction too. This module asks the provider to describe
 * a file (metadata only), mints a short-lived PUT grant for it, hands the provider that grant,
 * and commits the reference. The bytes go sandbox → provider → object storage and never touch
 * the daemon, which is dependency-pinned (E4-D01) precisely so it does not handle them.
 *
 * ★ FOUR STEPS, BECAUSE THE FROZEN SCHEMA LEAVES NO CHOICE.
 * `artifactTransferGrantRequestV1Schema` requires BOTH `expectedSha256` and `maxBytes` as
 * non-optional, so the worker must know the digest and size BEFORE it can ask for a grant —
 * and only the provider can see inside the sandbox. Digest first is not a preference.
 *
 * ★★ DIGEST BEFORE MINT IS ALSO AN ORPHAN PROPERTY, NOT ONLY A SCHEMA ONE. Since DAT-009
 * slice 2, minting writes a durable `granted` `job_artifacts` row inside the mint transaction
 * (`server/src/services/artifact-transfer-grant.ts:168-175`). So a grant minted and never
 * redeemed is a row that lives until the sweeper collects it. Returning BEFORE the mint when
 * there is nothing to export is what keeps an empty run from leaving litter behind.
 *
 * ★★★ HTTP 200 IS NOT SUCCESS. Both ops answer 200 for `rejected` as well as for the granted /
 * committed outcomes — the fail-open trap `secret-redemption.ts` and `staged-input.ts` both
 * document. Every branch here keys on the BODY's `outcome`, and the server's REFUSAL REASON is
 * carried into the thrown error rather than discarded (see `E7-F017`: the download mirror
 * reports every refusal as "malformed grant", because
 * `isTransferGrantResponsePairedV1` returns TRUE for `"rejected"` and its guarded branch is
 * therefore unreachable for one). On the upload side the reason is more load-bearing still:
 * `attempt_terminal` is precisely the lifecycle-window mistake this module can make.
 *
 * ★ THE GRANT IS A BEARER CAPABILITY. Anyone holding it can write that object key until it
 * expires. `InspectResult` already classifies this class of value as sensitive and
 * `RedactedResourceProjection` excludes it. Honoured here: no thrown message, no return value
 * and no log field in this module carries `grant.url`.
 *
 * Runtime imports: `@armyofagents/worker-protocol` + relative modules — the E4-D01 boundary.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  artifactUploadGrantV1Schema,
  expectedAttemptObjectPrefix,
  type ArtifactUploadGrantV1,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { LeaseHandoff } from "../poll/poll-loop.js";
import type { RunFenceContext } from "./secret-redemption.js";

/** The stage of the four-step sequence a failure happened at. */
export type ArtifactExportStage = "digest" | "grant" | "export" | "commit";

/**
 * ONE file this run wants returned to the control plane.
 *
 * `kind`, `contentType` and `retention` are the CALLER's declaration and this module never
 * substitutes a default for them:
 *
 *   * `kind` is honoured by the control plane AND is what the E7-1 capability counter filters
 *     on — `countProducedOutputs` arm 1 in `server/src/services/e7-distributed-run-verifier-store.ts`
 *     matches `workspace_patch` only — so a default picked here would silently decide someone
 *     else's gate. (W21D: this cited `:207`, which W21B/W21C moved. Anchor on the SYMBOL, not a
 *     line: `:207` in that file is now an unrelated `getAttemptTerminalReceipt` parameter, and a
 *     reader following the old pin would have landed on the wrong function entirely. That
 *     `kind` conjunct is also the ONLY thing arm 1's precision rests on — `stageJobInputFiles`
 *     commits FENCELESS `job_artifacts` rows on the same job and attempt, so "committed implies
 *     fenced" is false for this table.)
 *   * `retention` is CONTROL-PLANE-OWNED and the declaration is IGNORED, derived from `kind`
 *     instead (`artifact-commit.ts:166-182`, DAT-010). It is still sent honestly rather than
 *     hard-coded, so a disagreement shows up as the server's own warning.
 */
export interface ArtifactExportRequest {
  /** The ABSOLUTE in-sandbox path to export. */
  readonly path: string;
  /** A frozen `ARTIFACT_KINDS` member. */
  readonly kind: string;
  /** A `type/subtype` MIME token — the frozen manifest requires one. */
  readonly contentType: string;
  /** A frozen `ARTIFACT_RETENTION_CLASSES` member. */
  readonly retention: string;
}

/** What a successful export committed. A REFERENCE — never bytes, and never the grant. */
export interface ExportedArtifactRef {
  readonly path: string;
  readonly artifactId: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly versionNumber: number;
}

/**
 * The provider half, injected.
 *
 * ★ DELIBERATELY NOT A `SandboxProvider`. Two reasons, both structural. It keeps this module
 * provable with no sandbox and no provider package (the same shape `createStagedInputResolver`
 * has). And it puts the FENCE GATE at the boundary: the supervisor satisfies this from
 * `run.effect` (`EffectAuthority`), so this module cannot become a second, quieter door onto a
 * gated action — the failure shape DAT-009 slice 2 §4 names. `path` and `grant` are the only
 * things that cross.
 */
export interface SandboxArtifactExporter {
  /** Describe the file. METADATA ONLY — an implementation that returned content would reverse
   * the decision this whole pipeline implements. */
  digest(path: string): Promise<{ sha256: string; sizeBytes: number }>;
  /** Upload it under `grant`, returning a reference. */
  export(path: string, grant: ArtifactUploadGrantV1): Promise<{ objectKey: string }>;
}

/**
 * ★★★ THE HEADERS THE SIGNED PUT DEMANDS, AND WHICH THE GRANT DOES NOT CARRY.
 *
 * `s3-provider.ts`'s `presign()` binds `ChecksumAlgorithm: "SHA256"` into the signed
 * `PutObjectCommand` and then returns `headers: {}` (`server/src/storage/s3-provider.ts:114-142`,
 * the return at `:142`), and `artifact-transfer-grant.ts:153` copies that empty object straight
 * onto the frozen grant. So the grant tells the redeemer NOTHING about the headers its own
 * signed URL requires — while the signed query requires them, and the store rejects the PUT
 * without them.
 *
 * The only code in this repository that has ever redeemed one of these URLs is the D1 harness
 * step-script (`tests/d1/lib/e6f-harness.mjs:1503-1521`). This function is that knowledge,
 * lifted out of a test harness and put beside the grant it derives from — because two providers
 * re-deriving it independently is how the second one gets it wrong silently.
 *
 * ★★ THE ENCODING CHANGES. `expectedSha256` is lowercase HEX on the grant
 * (`sha256DigestSchema`, `/^[a-f0-9]{64}$/`); `x-amz-checksum-sha256` is BASE64 of the same 32
 * raw bytes. Nothing in the type system distinguishes them, and forwarding the hex produces a
 * PUT the store refuses.
 *
 * ★ WHAT THIS DOES **NOT** BUY, stated so it is not over-read. The signer binds the checksum
 * ALGORITHM, never the expected VALUE (`DAT-009-terrain.md` §9), so the store verifies these
 * bytes against THIS header and never against the grant's `expectedSha256`. A provider that
 * hashed what it actually uploaded would produce a PUT the store accepts and a commit the
 * control plane refuses `hash_mismatch`. That is correct and fail-closed — but it means the
 * store is not the guard, and "the PUT succeeded" proves nothing on its own.
 *
 * Grant-supplied headers are spread LAST, so a future server that does supply them wins.
 */
export function grantPutHeaders(grant: ArtifactUploadGrantV1): Record<string, string> {
  return {
    "x-amz-checksum-sha256": Buffer.from(grant.expectedSha256, "hex").toString("base64"),
    "x-amz-sdk-checksum-algorithm": "SHA256",
    ...grant.headers,
  };
}

/** An export that did not complete. Names the STAGE and the server's own reason; carries no url. */
export class ArtifactExportFailedError extends Error {
  readonly stage: ArtifactExportStage;
  readonly path: string;
  readonly artifactId: string;
  constructor(stage: ArtifactExportStage, path: string, artifactId: string, detail: string) {
    super(`artifact export failed at ${stage} for ${path}: ${detail}`);
    this.name = "ArtifactExportFailedError";
    this.stage = stage;
    this.path = path;
    this.artifactId = artifactId;
  }
}

export interface CreateArtifactExportSequencerDeps {
  readonly client: Pick<
    ControlPlaneClient,
    "artifactTransferGrant" | "artifactTransferGrantPath" | "artifactCommit" | "artifactCommitPath"
  >;
  readonly key: DeviceKey;
  /** Resolves the live session at call time, so a renewed token is picked up. */
  readonly session: () => Promise<WorkerSession>;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A DETERMINISTIC RFC-4122-shaped uuid from a seed — the same device `staged-input.ts:137-143`
 * uses, and for the same reason: the frozen `idempotencyKeySchema` is `z.string().uuid()`, but
 * a RANDOM key would defeat the point, since a retry must present the SAME key or the control
 * plane cannot recognise the replay.
 */
function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * The artifact identity for (this attempt, this path).
 *
 * ★ DERIVED, NOT RANDOM. A retried export of the same file must present the SAME artifactId, or
 * the control plane sees a second artifact rather than a replay — and the mint's
 * already-committed guard (`artifact-transfer-grant.ts:135-139`) could not refuse a duplicate
 * upload of something already committed. Seeded on the attempt identity plus the path, which is
 * exactly what is being retried.
 */
export function exportArtifactId(input: { jobId: string; attempt: number; path: string }): string {
  return deterministicUuid(`artifact-export:${input.jobId}:${input.attempt}:${input.path}`);
}

/** Sign one operation request body for `path`, against `path` on the control plane. */
function signed(
  deps: CreateArtifactExportSequencerDeps,
  session: WorkerSession,
  httpPath: string,
  build: (correlationId: string, issuedAt: string) => unknown,
): { bytes: Buffer; sessionToken: string; proofHeaders: Readonly<Record<string, string>> } {
  const now = deps.now ?? (() => Date.now());
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const issuedAt = new Date(now()).toISOString();
  const bytes = Buffer.from(JSON.stringify(build(correlationId, issuedAt)), "utf8");
  const proof = signDeviceProof({
    method: "POST",
    path: httpPath,
    rawBody: bytes,
    correlationId,
    issuedAt,
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });
  return { bytes, sessionToken: session.token, proofHeaders: proof.headers };
}

/** Read `{outcome, reason?}` off a 200 body, or say why it could not be read. */
function readOutcome(body: unknown): { outcome: string; reason: string | null } | null {
  if (!isRecord(body) || typeof body.outcome !== "string") return null;
  return { outcome: body.outcome, reason: typeof body.reason === "string" ? body.reason : null };
}

/**
 * The four-step sequencer.
 *
 * ★★★ THE LIFECYCLE WINDOW IS THE CALLER'S RESPONSIBILITY, AND IT IS BOUNDED ON BOTH SIDES.
 * An upload grant requires a LIVE fence (`artifact-transfer-grant.ts:99` runs `lockActiveFence`),
 * and `classifyFence` returns `attempt_terminal` the moment the attempt is terminal
 * (`packages/db/src/repositories/tenant/job-fence.ts:482-488`). The commit half resolves the
 * same fence. So this must run AFTER `execute` (there is no file before the tenant command made
 * one) and BEFORE the terminal event reaches the control plane.
 *
 * ★★ "Before the terminal event" is not "before `events.terminal()` returns": the durable sink
 * fsyncs to a LOCAL outbox and the drain uploads later, so running after the local emit is a
 * RACE against the drain, decided by drain timing — green against every in-process double and
 * non-deterministic in production. Recorded here as well as in the design because this module
 * is where someone will look.
 *
 * Fails per-file and does NOT continue: a caller cannot tell which of a partial set is missing,
 * which is the same reasoning that makes staging all-or-nothing.
 */
export function createArtifactExportSequencer(
  deps: CreateArtifactExportSequencerDeps,
): (input: {
  handoff: LeaseHandoff;
  exporter: SandboxArtifactExporter;
  requests: readonly ArtifactExportRequest[];
}) => Promise<readonly ExportedArtifactRef[]> {
  return async ({ handoff, exporter, requests }) => {
    // ★ Nothing to export ⇒ NO session fetch, NO mint, NO row. §3.3 of the design: since slice 2
    // a mint is a durable record, so a speculative one is litter with a five-minute life.
    if (requests.length === 0) return [];

    const job = handoff.offer.job;
    const organizationId = String(job.organizationId);
    const companyId = String(job.companyId);
    const jobId = String(job.jobId);
    const attempt = job.attempt;
    const fence: RunFenceContext = {
      workerId: String(handoff.offer.workerId),
      jobId,
      attempt,
      leaseId: handoff.leaseId,
      fenceToken: String(handoff.fenceToken),
    };
    const prefix = expectedAttemptObjectPrefix({ organizationId, jobId, attempt });
    const session = await deps.session();
    const now = deps.now ?? (() => Date.now());

    const exported: ExportedArtifactRef[] = [];
    for (const request of requests) {
      const artifactId = exportArtifactId({ jobId, attempt, path: request.path });
      // The control plane's own convention for an attempt-scoped object
      // (`job-input-staging.ts:350` builds `${prefix}${artifactId}`), matched deliberately.
      const objectKey = `${prefix}${artifactId}`;
      // Explicitly typed so TypeScript treats it as a NEVER-RETURNING call and narrows after
      // it. Without the annotation on the VARIABLE the narrowing does not apply and every
      // branch below would need a non-null assertion — assertions that would then survive a
      // later edit that made one of these paths fall through.
      const fail: (stage: ArtifactExportStage, detail: string) => never = (stage, detail) => {
        throw new ArtifactExportFailedError(stage, request.path, artifactId, detail);
      };

      // --- 1. DIGEST (metadata only; no bytes cross this call) -----------------------------
      let described: { sha256: string; sizeBytes: number };
      try {
        described = await exporter.digest(request.path);
      } catch (error) {
        // An absent path, or a provider whose `artifactExportMode` is "none", lands here — and
        // lands here BEFORE anything durable was minted. A fabricated digest would be the
        // WRK-009 defect: byte-identical to a real one on every downstream gate, and it would
        // mint a grant against bytes that never existed.
        fail("digest", error instanceof Error ? error.message : "digest failed");
      }

      // --- 2. MINT the upload grant --------------------------------------------------------
      const grantResponse = await deps.client.artifactTransferGrant(
        signed(deps, session, deps.client.artifactTransferGrantPath, (correlationId, issuedAt) => ({
          protocolVersion: 1 as const,
          correlationId,
          issuedAt,
          nonce: randomUUID(),
          audience: "worker_run" as const,
          idempotencyKey: deterministicUuid(`artifact-export-grant:${fence.leaseId}:${artifactId}`),
          body: {
            protocolVersion: 1 as const,
            operation: "upload" as const,
            workerId: fence.workerId,
            jobId: fence.jobId,
            attempt: fence.attempt,
            leaseId: fence.leaseId,
            fenceToken: fence.fenceToken,
            artifactId,
            expectedObjectKey: objectKey,
            expectedSha256: described.sha256,
            // ★ `maxBytes` is the EXACT size, not a ceiling. Step 1 always knows it, and the
            // server refuses a declared size over its own ceiling before a byte moves
            // (`artifact-transfer-grant.ts:124`) — so declaring more than the file is only a
            // wider orphan bound with nothing to gain.
            maxBytes: described.sizeBytes,
          },
        })),
      );
      if (grantResponse.status !== 200) fail("grant", `status ${grantResponse.status}`);
      const grantOutcome = readOutcome(grantResponse.body);
      if (!grantOutcome) fail("grant", "unreadable response");
      // ★ THE REFUSAL REASON SURVIVES. `rejected` is checked FIRST and by name, so
      // `attempt_terminal` / `stale_fence` / `target_revoked` reach the operator as themselves.
      // The download mirror does not do this (E7-F017) and reports every refusal as a malformed
      // grant, which sends someone hunting a protocol bug when the real answer is "this ran
      // outside the lifecycle window".
      if (grantOutcome.outcome === "rejected") {
        fail("grant", `rejected: ${grantOutcome.reason ?? "unknown"}`);
      }
      if (grantOutcome.outcome !== "upload_granted") {
        // A cross-paired `download_granted` lands here rather than being parsed as an upload.
        fail("grant", `outcome ${grantOutcome.outcome}`);
      }
      const parsedGrant = artifactUploadGrantV1Schema.safeParse(
        (grantResponse.body as Record<string, unknown>).grant,
      );
      if (!parsedGrant.success) fail("grant", "malformed grant");
      const grant = parsedGrant.data;
      // The server echoes the key it authorised. A mismatch means the two sides disagree about
      // what is being written, and the safe reading is "do not upload".
      if (grant.objectKey !== objectKey) fail("grant", "granted a different object key");

      // --- 3. EXPORT — the only hop that moves bytes, and it is provider → S3 --------------
      let reference: { objectKey: string };
      try {
        reference = await exporter.export(request.path, grant);
      } catch (error) {
        // Deliberately NOT interpolating the error into anything that could carry the grant:
        // the message is the implementation's, and an implementation that put the signed url in
        // its own error would leak it here. Only the stage and the path are reported.
        fail("export", error instanceof Error ? error.name : "export failed");
      }
      if (reference.objectKey !== objectKey) fail("export", "exported a different object key");

      // --- 4. COMMIT the reference ---------------------------------------------------------
      const commitResponse = await deps.client.artifactCommit(
        signed(deps, session, deps.client.artifactCommitPath, (correlationId, issuedAt) => ({
          protocolVersion: 1 as const,
          correlationId,
          issuedAt,
          nonce: randomUUID(),
          audience: "worker_run" as const,
          idempotencyKey: deterministicUuid(`artifact-export-commit:${fence.leaseId}:${artifactId}`),
          body: {
            protocolVersion: 1 as const,
            workerId: fence.workerId,
            jobId: fence.jobId,
            attempt: fence.attempt,
            leaseId: fence.leaseId,
            fenceToken: fence.fenceToken,
            manifest: {
              protocolVersion: 1 as const,
              organizationId,
              companyId,
              jobId: fence.jobId,
              attempt: fence.attempt,
              artifactId,
              kind: request.kind,
              sensitivity: "restricted" as const,
              retention: request.retention,
              objectKey,
              sizeBytes: described.sizeBytes,
              sha256: described.sha256,
              contentType: request.contentType,
              createdAt: new Date(now()).toISOString(),
            },
          },
        })),
      );
      if (commitResponse.status !== 200) fail("commit", `status ${commitResponse.status}`);
      const commitOutcome = readOutcome(commitResponse.body);
      if (!commitOutcome) fail("commit", "unreadable response");
      if (commitOutcome.outcome === "rejected") {
        // `event_hash_mismatch` here means the store's OBSERVED digest disagreed with the one
        // step 1 described — the TOCTOU the two-step shape is designed to fail closed on.
        fail("commit", `rejected: ${commitOutcome.reason ?? "unknown"}`);
      }
      if (commitOutcome.outcome !== "committed") fail("commit", `outcome ${commitOutcome.outcome}`);
      const body = commitResponse.body as Record<string, unknown>;
      if (typeof body.versionNumber !== "number") fail("commit", "committed without a version");

      exported.push({
        path: request.path,
        artifactId,
        objectKey,
        sha256: described.sha256,
        sizeBytes: described.sizeBytes,
        versionNumber: body.versionNumber,
      });
    }
    return exported;
  };
}
