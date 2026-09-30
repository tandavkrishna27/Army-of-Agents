import { z } from "zod";
import {
  artifactIdSchema,
  attemptNumberSchema,
  companyIdSchema,
  fenceTokenSchema,
  jobIdSchema,
  leaseIdSchema,
  organizationIdSchema,
  targetIdSchema,
  sha256DigestSchema,
  workerIdSchema,
} from "./ids.js";
import { artifactRetentionClassSchema } from "./policy.js";
import { timestampV1Schema } from "./job.js";
import { addForbiddenWireKeyIssues, normalizeWireKey, FORBIDDEN_WIRE_KEYS } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// V1 workspace / artifact / transfer-grant / commit / quarantine contracts.
//
// Security posture (fail-closed):
//   * Workspace paths and object keys are relative POSIX with no empty, `.`,
//     `..`, backslash, absolute, drive/colon, or NUL/control segment; symlink
//     entries are rejected in v1; duplicate/case-colliding paths fail.
//   * Object keys are pinned to `organizations/<org>/jobs/<job>/attempts/<n>/…`;
//     a wrong org/job/attempt prefix fails at commit.
//   * EVERY artifact kind, including `other`, requires `sensitivity:"restricted"`
//     — relabeling customer/browser/secret-bearing bytes cannot obtain a weaker
//     policy. A future normal/public kind needs a named schema + policy change.
//   * Ordinary commit requires the complete active fence, but the SCHEMA never
//     decides whether that fence is current — staleness is authoritative receiver
//     state owned by PRT-007/JOB-004.
//   * Quarantine is a DISTINCT prefix + device-auth (targetId + deviceGeneration,
//     not a live lease) with a ≤5-minute upload grant; it preserves observed
//     identity/hash/size/sensitivity/provenance and has NO apply / promote /
//     select-checkpoint / attempt-mutation operation.
//
// Runtime source imports only `zod` + relative modules and touches no Node API.
// -----------------------------------------------------------------------------

// =============================================================================
// Path + object-key safety primitives.
// =============================================================================

/**
 * True iff `path` is a safe RELATIVE POSIX workspace path: non-empty, ≤4096
 * chars, no absolute/`/`-prefixed form, no backslash, no `:` (drive/ADS/scheme),
 * no NUL/control byte, and no empty / `.` / `..` / over-long segment.
 */
export function isSafeWorkspacePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/")) return false; // absolute POSIX
  if (path.includes("\\")) return false; // Windows / UNC separator
  if (path.includes(":")) return false; // drive letter / ADS / scheme
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // control / NUL / DEL
  }
  for (const seg of path.split("/")) {
    if (seg.length === 0) return false; // "//" or leading/trailing "/"
    if (seg === "." || seg === "..") return false;
    if (seg.length > 255) return false;
  }
  return true;
}

/** A workspace-relative path field. */
export const workspacePathSchema = z.string().superRefine((value, ctx) => {
  if (!isSafeWorkspacePath(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unsafe workspace path" });
  }
});

/** The ordinary attempt object-key prefix (ends with `/`). */
export function expectedAttemptObjectPrefix(input: { organizationId: string; jobId: string; attempt: number }): string {
  return `organizations/${input.organizationId}/jobs/${input.jobId}/attempts/${input.attempt}/`;
}

/** The DISTINCT quarantine object-key prefix (a separate `quarantine/` root). */
export function expectedQuarantineObjectPrefix(input: { organizationId: string; jobId: string; attempt: number }): string {
  return `quarantine/organizations/${input.organizationId}/jobs/${input.jobId}/attempts/${input.attempt}/`;
}

/** True iff `key` is a safe object key (safe relative POSIX path) with the exact
 * `prefix`, and a non-empty suffix after it. `isSafeWorkspacePath` rejects a
 * trailing `/`, so a key equal to the bare prefix has no suffix and fails. */
function objectKeyHasPrefix(key: string, prefix: string): boolean {
  return isSafeWorkspacePath(key) && key.startsWith(prefix) && key.length > prefix.length;
}

// =============================================================================
// Workspace base, entry, and manifest.
// =============================================================================

const ignorePolicySchema = z
  .object({ kind: z.enum(["gitignore_plus_aoa", "explicit"]), digest: sha256DigestSchema })
  .strict();

const inclusionSchema = z
  .object({ tracked: z.literal(true), untracked: z.enum(["include", "exclude"]), ignored: z.literal(false) })
  .strict();

/** The strict V1 workspace base: how the snapshot/patch base was captured. */
export const workspaceBaseV1Schema = z
  .object({
    kind: z.enum(["git_commit", "content_manifest"]),
    algorithm: z.enum(["git_sha1", "git_sha256", "sha256"]),
    revision: z.string(),
    dirty: z.boolean(),
    caseMode: z.enum(["sensitive", "insensitive_preserving"]),
    ignorePolicy: ignorePolicySchema,
    inclusion: inclusionSchema,
  })
  .strict()
  .superRefine((base, ctx) => {
    const expected = base.algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (!expected.test(base.revision)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: `revision must match ${base.algorithm}` });
    }
  });
export type WorkspaceBaseV1 = z.infer<typeof workspaceBaseV1Schema>;

/** The V1 workspace entry kinds — symlinks are NOT representable in v1. */
export const WORKSPACE_ENTRY_KINDS = ["file", "directory"] as const;
export const workspaceEntryKindSchema = z.enum(WORKSPACE_ENTRY_KINDS);
export type WorkspaceEntryKind = (typeof WORKSPACE_ENTRY_KINDS)[number];

/** The workspace-entry / artifact provenance vocabulary (single source). */
export const WORKSPACE_PROVENANCE = ["tracked", "untracked", "generated"] as const;
export const workspaceProvenanceSchema = z.enum(WORKSPACE_PROVENANCE);
export type WorkspaceProvenance = (typeof WORKSPACE_PROVENANCE)[number];

const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A single captured workspace entry. Files carry a content hash; directories do
 * not (and are not executable). Symlinks are rejected via the kind enum. */
export const workspaceEntrySchema = z
  .object({
    path: workspacePathSchema,
    kind: workspaceEntryKindSchema,
    provenance: workspaceProvenanceSchema,
    sizeBytes: nonNegativeIntSchema,
    sha256: sha256DigestSchema.nullable(),
    executable: z.boolean(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.kind === "file" && entry.sha256 === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "file entries require a content hash" });
    }
    if (entry.kind === "directory") {
      if (entry.sha256 !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "directory entries have no content hash" });
      }
      if (entry.sizeBytes !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sizeBytes"], message: "directory entries have zero size" });
      }
      if (entry.executable !== false) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executable"], message: "directory entries are not executable" });
      }
    }
  });
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

const snapshotProvenanceSchema = z
  .object({
    capturedAt: timestampV1Schema,
    sourceTargetId: targetIdSchema,
    folderGrantId: z.string().uuid().nullable(),
    captureToolVersion: z.string().min(1).max(200),
  })
  .strict();

/** Report distinct + case-colliding path issues over a list of workspace paths. */
function addPathCollisionIssues(paths: readonly string[], ctx: z.RefinementCtx, base: Array<string | number>): void {
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  paths.forEach((path, index) => {
    if (seen.has(path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...base, index, "path"], message: "duplicate workspace path" });
    }
    const lower = path.toLowerCase();
    if (!seen.has(path) && seenLower.has(lower)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...base, index, "path"], message: "case-colliding workspace path" });
    }
    seen.add(path);
    seenLower.add(lower);
  });
}

/** The strict V1 full-workspace snapshot manifest. */
export const workspaceManifestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    organizationId: organizationIdSchema,
    companyId: companyIdSchema,
    artifactId: artifactIdSchema,
    base: workspaceBaseV1Schema,
    snapshotProvenance: snapshotProvenanceSchema,
    entries: z.array(workspaceEntrySchema).max(1_000_000),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    addForbiddenWireKeyIssues(manifest, ctx);
    addPathCollisionIssues(manifest.entries.map((entry) => entry.path), ctx, ["entries"]);
  });
export type WorkspaceManifestV1 = z.infer<typeof workspaceManifestV1Schema>;

// =============================================================================
// Workspace patch manifest.
// =============================================================================

/** The locked patch-operation vocabulary. */
export const PATCH_OPERATION_KINDS = ["create", "modify", "delete", "rename"] as const;

const mutatingOpFields = { path: workspacePathSchema, resultSha256: sha256DigestSchema, sizeBytes: nonNegativeIntSchema };

/** A single patch operation. `create`/`modify`/`rename` carry a result hash +
 * size; `delete` carries only a path; `rename` additionally carries `fromPath`. */
export const patchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), ...mutatingOpFields }).strict(),
  z.object({ op: z.literal("modify"), ...mutatingOpFields }).strict(),
  z.object({ op: z.literal("delete"), path: workspacePathSchema }).strict(),
  z.object({ op: z.literal("rename"), fromPath: workspacePathSchema, ...mutatingOpFields }).strict(),
]);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

/** The strict V1 workspace patch manifest (base → result). */
export const workspacePatchManifestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    organizationId: organizationIdSchema,
    companyId: companyIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    artifactId: artifactIdSchema,
    base: workspaceBaseV1Schema,
    baseManifestHash: sha256DigestSchema,
    resultManifestHash: sha256DigestSchema,
    operations: z.array(patchOperationSchema).min(1).max(1_000_000),
  })
  .strict()
  .superRefine((patch, ctx) => {
    addForbiddenWireKeyIssues(patch, ctx);
    if (patch.baseManifestHash === patch.resultManifestHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resultManifestHash"], message: "a patch must change the manifest hash" });
    }
    const paths = patch.operations.map((op) => op.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operations"], message: "duplicate operation path" });
    }
  });
export type WorkspacePatchManifestV1 = z.infer<typeof workspacePatchManifestV1Schema>;

// =============================================================================
// Artifact manifest + sensitivity.
// =============================================================================

/** The locked artifact-kind vocabulary (including the catch-all `other`). */
export const ARTIFACT_KINDS = [
  "workspace_snapshot",
  "workspace_patch",
  "log",
  "screenshot",
  "dom_snapshot",
  "browser_cookie_state",
  "browser_storage_state",
  "playwright_trace",
  "browser_video",
  "download",
  "service_checkpoint",
  "other",
] as const;
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** EVERY V1 artifact kind is restricted — there is no weaker class in v1. */
export const RESTRICTED_ARTIFACT_KINDS = ARTIFACT_KINDS;

/** The only V1 artifact sensitivity: `restricted`. A future normal/public kind
 * requires a named schema addition and a policy decision. */
export const artifactSensitivitySchema = z.literal("restricted");
export type ArtifactSensitivity = z.infer<typeof artifactSensitivitySchema>;

/** A MIME content type (loose `type/subtype` token grammar). */
const contentTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);

/** The strict V1 artifact manifest. Size, hash, kind, and retention are required;
 * every kind is `restricted`; the object key is pinned to its org/job/attempt. */
export const artifactManifestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    organizationId: organizationIdSchema,
    companyId: companyIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    artifactId: artifactIdSchema,
    kind: artifactKindSchema,
    sensitivity: artifactSensitivitySchema,
    retention: artifactRetentionClassSchema,
    objectKey: z.string().min(1).max(1024),
    sizeBytes: nonNegativeIntSchema,
    sha256: sha256DigestSchema,
    contentType: contentTypeSchema,
    createdAt: timestampV1Schema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    addForbiddenWireKeyIssues(manifest, ctx);
    const prefix = expectedAttemptObjectPrefix(manifest);
    if (!objectKeyHasPrefix(manifest.objectKey, prefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectKey"],
        message: "objectKey must be a safe key under organizations/<org>/jobs/<job>/attempts/<attempt>/",
      });
    }
  });
export type ArtifactManifestV1 = z.infer<typeof artifactManifestV1Schema>;

// =============================================================================
// Transfer grant request + upload/download grants.
// =============================================================================

/** An https URL (scheme pinned; no whitespace). */
const httpsUrlSchema = z.string().min(9).max(8192).regex(/^https:\/\/\S+$/, "url must be https");

/** Header names that must never appear on a signed grant (credential channels).
 * Recursive wire-safety already catches `authorization`/`cookie`/`token`; this
 * set adds the header spellings wire-safety's normalized set does not cover. */
const FORBIDDEN_HEADER_NORMALIZED: ReadonlySet<string> = new Set<string>([
  ...FORBIDDEN_WIRE_KEYS,
  "xapikey",
  "xamzsecuritytoken",
  "xamzcredential",
  "proxyauthorization",
  "wwwauthenticate",
  "setcookie",
  "authentication",
]);

const grantHeadersSchema = z.record(
  z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "invalid header name"),
  z.string().max(8192),
);

function addGrantHeaderIssues(headers: Record<string, string>, ctx: z.RefinementCtx): void {
  const keys = Object.keys(headers);
  if (keys.length > 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "at most 32 headers" });
  }
  for (const key of keys) {
    if (FORBIDDEN_HEADER_NORMALIZED.has(normalizeWireKey(key))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers", key], message: "credential-bearing header is forbidden on a grant" });
    }
  }
}

/** A worker's request for an ordinary (fenced) upload/download grant. */
export const artifactTransferGrantRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    operation: z.enum(["upload", "download"]),
    workerId: workerIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    artifactId: artifactIdSchema,
    expectedObjectKey: z.string().min(1).max(1024),
    expectedSha256: sha256DigestSchema,
    maxBytes: nonNegativeIntSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    addForbiddenWireKeyIssues(request, ctx);
    const key = request.expectedObjectKey;
    const bindsJobAttempt =
      isSafeWorkspacePath(key) && key.startsWith("organizations/") && key.includes(`/jobs/${request.jobId}/attempts/${request.attempt}/`);
    if (!bindsJobAttempt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedObjectKey"],
        message: "expectedObjectKey must be a safe key binding this job and attempt",
      });
    }
  });
export type ArtifactTransferGrantRequestV1 = z.infer<typeof artifactTransferGrantRequestV1Schema>;

/** Shared refinement for the ordinary signed transfer grants. */
function addOrdinaryGrantIssues(
  grant: { url: string; headers: Record<string, string>; issuedAt: string; expiresAt: string; objectKey: string },
  ctx: z.RefinementCtx,
): void {
  addForbiddenWireKeyIssues(grant, ctx);
  addGrantHeaderIssues(grant.headers, ctx);
  if (!(Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
  }
  if (!(isSafeWorkspacePath(grant.objectKey) && grant.objectKey.startsWith("organizations/"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectKey"], message: "objectKey must be a safe ordinary attempt object key" });
  }
}

/** A scoped PUT grant for an ordinary artifact upload. */
export const artifactUploadGrantV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    operation: z.literal("upload"),
    artifactId: artifactIdSchema,
    method: z.literal("PUT"),
    url: httpsUrlSchema,
    headers: grantHeadersSchema,
    issuedAt: timestampV1Schema,
    expiresAt: timestampV1Schema,
    maxBytes: nonNegativeIntSchema,
    expectedSha256: sha256DigestSchema,
    objectKey: z.string().min(1).max(1024),
    redaction: z.literal("secret"),
  })
  .strict()
  .superRefine((grant, ctx) => addOrdinaryGrantIssues(grant, ctx));
export type ArtifactUploadGrantV1 = z.infer<typeof artifactUploadGrantV1Schema>;

/** A scoped GET grant for an ordinary artifact download. */
export const artifactDownloadGrantV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    operation: z.literal("download"),
    artifactId: artifactIdSchema,
    method: z.literal("GET"),
    url: httpsUrlSchema,
    headers: grantHeadersSchema,
    issuedAt: timestampV1Schema,
    expiresAt: timestampV1Schema,
    maxBytes: nonNegativeIntSchema,
    expectedSha256: sha256DigestSchema,
    objectKey: z.string().min(1).max(1024),
    redaction: z.literal("secret"),
  })
  .strict()
  .superRefine((grant, ctx) => addOrdinaryGrantIssues(grant, ctx));
export type ArtifactDownloadGrantV1 = z.infer<typeof artifactDownloadGrantV1Schema>;

// =============================================================================
// Ordinary fenced commit.
// =============================================================================

/**
 * The ordinary artifact-commit payload. It carries the COMPLETE active fence
 * (workerId/jobId/attempt/leaseId/fenceToken) plus the artifact manifest. The
 * schema deliberately does NOT decide whether that fence is current — staleness
 * is authoritative receiver state (PRT-007/JOB-004). It binds the commit's
 * job/attempt to the manifest so a wrong prefix fails at commit.
 */
export const artifactCommitPayloadV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    manifest: artifactManifestV1Schema,
  })
  .strict()
  .superRefine((commit, ctx) => {
    addForbiddenWireKeyIssues(commit, ctx);
    if (String(commit.jobId) !== String(commit.manifest.jobId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "jobId"], message: "commit jobId must match the manifest" });
    }
    if (commit.attempt !== commit.manifest.attempt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "attempt"], message: "commit attempt must match the manifest" });
    }
  });
export type ArtifactCommitPayloadV1 = z.infer<typeof artifactCommitPayloadV1Schema>;

// =============================================================================
// Device-authenticated quarantine (CAV-004): distinct prefix, non-promotion.
// =============================================================================

/** The locked quarantine-reason vocabulary. */
export const QUARANTINE_REASONS = [
  "stale_fence",
  "late_output",
  "hash_mismatch",
  "wrong_prefix",
  "size_mismatch",
  "unknown_artifact",
  "corrupt_checkpoint",
] as const;
export const quarantineReasonSchema = z.enum(QUARANTINE_REASONS);
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

const deviceGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * A device-authenticated request for a quarantine PUT grant. The authenticator is
 * `targetId` + `deviceGeneration`, NOT a live lease; `observedLeaseId` /
 * `observedFenceToken` are recorded as observed (non-authoritative) identity. The
 * object key is bound to the DISTINCT quarantine prefix and the exact
 * org/job/attempt/hash/size. There is no apply/promote/checkpoint-selection field.
 */
export const quarantineGrantPayloadV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: deviceGenerationSchema,
    organizationId: organizationIdSchema,
    companyId: companyIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    observedLeaseId: leaseIdSchema,
    observedFenceToken: fenceTokenSchema,
    reason: quarantineReasonSchema,
    artifactId: artifactIdSchema,
    expectedObjectKey: z.string().min(1).max(1024),
    expectedSha256: sha256DigestSchema,
    sizeBytes: nonNegativeIntSchema,
  })
  .strict()
  .superRefine((grant, ctx) => {
    addForbiddenWireKeyIssues(grant, ctx);
    if (!objectKeyHasPrefix(grant.expectedObjectKey, expectedQuarantineObjectPrefix(grant))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedObjectKey"],
        message: "expectedObjectKey must be under the distinct quarantine prefix for this org/job/attempt",
      });
    }
  });
export type QuarantineGrantPayloadV1 = z.infer<typeof quarantineGrantPayloadV1Schema>;

/** Five minutes, in milliseconds — the quarantine upload-grant expiry ceiling. */
const QUARANTINE_MAX_TTL_MS = 5 * 60 * 1000;

/** The issued quarantine PUT grant: ≤5-minute expiry, quarantine-prefixed key. */
export const quarantineUploadGrantV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    operation: z.literal("quarantine_upload"),
    artifactId: artifactIdSchema,
    method: z.literal("PUT"),
    url: httpsUrlSchema,
    headers: grantHeadersSchema,
    issuedAt: timestampV1Schema,
    expiresAt: timestampV1Schema,
    maxBytes: nonNegativeIntSchema,
    expectedSha256: sha256DigestSchema,
    quarantineObjectKey: z.string().min(1).max(1024),
    redaction: z.literal("secret"),
  })
  .strict()
  .superRefine((grant, ctx) => {
    addForbiddenWireKeyIssues(grant, ctx);
    addGrantHeaderIssues(grant.headers, ctx);
    const issued = Date.parse(grant.issuedAt);
    const expires = Date.parse(grant.expiresAt);
    if (!(expires > issued)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
    } else if (expires - issued > QUARANTINE_MAX_TTL_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "quarantine upload grant expiry must be at most five minutes" });
    }
    if (!(isSafeWorkspacePath(grant.quarantineObjectKey) && grant.quarantineObjectKey.startsWith("quarantine/"))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quarantineObjectKey"], message: "quarantineObjectKey must be a safe key under the quarantine prefix" });
    }
  });
export type QuarantineUploadGrantV1 = z.infer<typeof quarantineUploadGrantV1Schema>;

/**
 * The device-authenticated finalize: after the object is uploaded, verify + record
 * it. Binds the manifest identity (artifact/hash/size/org/job/attempt) to the
 * observed quarantine object. No apply/promote/checkpoint-selection field exists.
 */
export const quarantineFinalizePayloadV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: deviceGenerationSchema,
    organizationId: organizationIdSchema,
    companyId: companyIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    observedLeaseId: leaseIdSchema,
    observedFenceToken: fenceTokenSchema,
    reason: quarantineReasonSchema,
    artifactId: artifactIdSchema,
    quarantineObjectKey: z.string().min(1).max(1024),
    expectedSha256: sha256DigestSchema,
    sizeBytes: nonNegativeIntSchema,
    manifest: artifactManifestV1Schema,
  })
  .strict()
  .superRefine((finalize, ctx) => {
    addForbiddenWireKeyIssues(finalize, ctx);
    if (!objectKeyHasPrefix(finalize.quarantineObjectKey, expectedQuarantineObjectPrefix(finalize))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quarantineObjectKey"],
        message: "quarantineObjectKey must be under the distinct quarantine prefix for this org/job/attempt",
      });
    }
    const m = finalize.manifest;
    if (String(m.organizationId) !== String(finalize.organizationId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "organizationId"], message: "manifest organization must match" });
    }
    if (String(m.jobId) !== String(finalize.jobId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "jobId"], message: "manifest jobId must match" });
    }
    if (m.attempt !== finalize.attempt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "attempt"], message: "manifest attempt must match" });
    }
    if (String(m.artifactId) !== String(finalize.artifactId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "artifactId"], message: "manifest artifactId must match" });
    }
    if (String(m.sha256) !== String(finalize.expectedSha256)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "sha256"], message: "manifest sha256 must match the observed hash" });
    }
    if (m.sizeBytes !== finalize.sizeBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "sizeBytes"], message: "manifest sizeBytes must match the observed size" });
    }
  });
export type QuarantineFinalizePayloadV1 = z.infer<typeof quarantineFinalizePayloadV1Schema>;

/** The orphan receipt returned after a successful quarantine finalize. Its only
 * disposition is `quarantined` — there is no apply/promote/select disposition. */
export const quarantineUploadReceiptV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    receiptId: z.string().uuid(),
    quarantineObjectKey: z.string().min(1).max(1024),
    observed: z
      .object({
        workerId: workerIdSchema,
        targetId: targetIdSchema,
        deviceGeneration: deviceGenerationSchema,
        jobId: jobIdSchema,
        attempt: attemptNumberSchema,
        leaseId: leaseIdSchema,
        fenceToken: fenceTokenSchema,
      })
      .strict(),
    artifact: z
      .object({
        artifactId: artifactIdSchema,
        sha256: sha256DigestSchema,
        sizeBytes: nonNegativeIntSchema,
        sensitivity: artifactSensitivitySchema,
        provenance: workspaceProvenanceSchema,
      })
      .strict(),
    reason: quarantineReasonSchema,
    receivedAt: timestampV1Schema,
    disposition: z.literal("quarantined"),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    addForbiddenWireKeyIssues(receipt, ctx);
    const key = receipt.quarantineObjectKey;
    const bindsJobAttempt =
      isSafeWorkspacePath(key) &&
      key.startsWith("quarantine/organizations/") &&
      key.includes(`/jobs/${receipt.observed.jobId}/attempts/${receipt.observed.attempt}/`);
    if (!bindsJobAttempt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quarantineObjectKey"],
        message: "quarantineObjectKey must be a safe key under the quarantine prefix binding the observed job/attempt",
      });
    }
  });
export type QuarantineUploadReceiptV1 = z.infer<typeof quarantineUploadReceiptV1Schema>;
