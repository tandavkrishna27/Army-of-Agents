import { describe, expect, it } from "vitest";
import { createSeededRng } from "./wire-safety.js";
import {
  ARTIFACT_KINDS,
  QUARANTINE_REASONS,
  RESTRICTED_ARTIFACT_KINDS,
  WORKSPACE_ENTRY_KINDS,
  artifactCommitPayloadV1Schema,
  artifactDownloadGrantV1Schema,
  artifactManifestV1Schema,
  artifactSensitivitySchema,
  artifactTransferGrantRequestV1Schema,
  artifactUploadGrantV1Schema,
  expectedAttemptObjectPrefix,
  expectedQuarantineObjectPrefix,
  isSafeWorkspacePath,
  quarantineFinalizePayloadV1Schema,
  quarantineGrantPayloadV1Schema,
  quarantineUploadGrantV1Schema,
  quarantineUploadReceiptV1Schema,
  workspaceBaseV1Schema,
  workspaceEntrySchema,
  workspaceManifestV1Schema,
  workspacePatchManifestV1Schema,
} from "./artifacts.js";

// ---- shared fixture identity ------------------------------------------------
const ORG = "00000000-0000-4000-8000-000000000011";
const COMPANY = "00000000-0000-4000-8000-000000000012";
const JOB = "00000000-0000-4000-8000-000000000010";
const ARTIFACT = "00000000-0000-4000-8000-000000000015";
const TARGET = "00000000-0000-4000-8000-000000000020";
const WORKER = "00000000-0000-4000-8000-000000000021";
const LEASE = "00000000-0000-4000-8000-000000000022";
const FENCE = "abcdefghijklmnopqrstuvwxyz012345";
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const ATTEMPT = 1;

const attemptPrefix = expectedAttemptObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: ATTEMPT });
const quarantinePrefix = expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: ATTEMPT });
const OBJECT_KEY = `${attemptPrefix}artifacts/log.txt`;
const QUARANTINE_KEY = `${quarantinePrefix}artifacts/log.txt`;

const validBase = {
  kind: "git_commit",
  algorithm: "git_sha1",
  revision: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  caseMode: "sensitive",
  ignorePolicy: { kind: "gitignore_plus_aoa", digest: HASH },
  inclusion: { tracked: true, untracked: "include", ignored: false },
};

const fileEntry = { path: "src/index.ts", kind: "file", provenance: "tracked", sizeBytes: 128, sha256: HASH, executable: false };
const dirEntry = { path: "src", kind: "directory", provenance: "tracked", sizeBytes: 0, sha256: null, executable: false };

const validWorkspaceManifest = {
  protocolVersion: 1,
  organizationId: ORG,
  companyId: COMPANY,
  artifactId: ARTIFACT,
  base: validBase,
  snapshotProvenance: {
    capturedAt: "2026-08-09T00:00:00.000Z",
    sourceTargetId: TARGET,
    folderGrantId: null,
    captureToolVersion: "aoa-capture/1.0.0",
  },
  entries: [dirEntry, fileEntry],
};

const validArtifactManifest = {
  protocolVersion: 1,
  organizationId: ORG,
  companyId: COMPANY,
  jobId: JOB,
  attempt: ATTEMPT,
  artifactId: ARTIFACT,
  kind: "log",
  sensitivity: "restricted",
  retention: "run",
  objectKey: OBJECT_KEY,
  sizeBytes: 42,
  sha256: HASH,
  contentType: "text/plain",
  createdAt: "2026-08-09T00:00:00.000Z",
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// =============================================================================
// Workspace path safety — the security crux.
// =============================================================================

describe("workspace path safety", () => {
  it("accepts relative POSIX paths (dots inside segments allowed)", () => {
    for (const p of ["a", "a/b/c.txt", "src/index.ts", "deep/nested/dir/file.log", ".hidden/keep", "a-b_c/d.e.f"]) {
      expect(isSafeWorkspacePath(p)).toBe(true);
    }
  });

  it("rejects empty, current-dir, and parent-dir segments", () => {
    for (const p of ["", ".", "..", "a/.", "a/..", "../a", "a/../b", "./a", "a/./b"]) {
      expect(isSafeWorkspacePath(p)).toBe(false);
    }
  });

  it("rejects absolute, backslash, drive, UNC, and NUL/control paths", () => {
    for (const p of ["/etc/passwd", "a\\b", "C:/Windows", "C:\\Windows", "\\\\server\\share\\x", "a/b\u0000c", "a\u0001b", "a:b"]) {
      expect(isSafeWorkspacePath(p)).toBe(false);
    }
  });

  it("rejects empty segments from // and trailing slash", () => {
    for (const p of ["a//b", "a/", "/a", "a/b//c"]) {
      expect(isSafeWorkspacePath(p)).toBe(false);
    }
  });

  // ---- Seeded ≥10,000-case corpus: ZERO escape acceptance -------------------
  const CORPUS_SEED = 20260809;
  const CORPUS_COUNT = 10_000;
  const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const LETTERS = "abcdefghijklmnopqrstuvwxyz";

  function safeSegment(rng: () => number): string {
    // First char a letter (never "." / ".."), remaining from a dot-free safe set.
    let seg = LETTERS[Math.floor(rng() * LETTERS.length)] as string;
    const extra = Math.floor(rng() * 10);
    for (let i = 0; i < extra; i += 1) seg += SAFE_CHARS[Math.floor(rng() * SAFE_CHARS.length)];
    return seg;
  }

  function buildCandidate(rng: () => number): { path: string; safe: boolean } {
    const depth = 2 + Math.floor(rng() * 5); // 2..6 safe base segments
    const segs = Array.from({ length: depth }, () => safeSegment(rng));
    const category = Math.floor(rng() * 10);
    switch (category) {
      case 0:
        return { path: segs.join("/"), safe: true }; // POSIX safe
      case 1: {
        const i = Math.floor(rng() * (segs.length + 1));
        segs.splice(i, 0, ".."); // traversal
        return { path: segs.join("/"), safe: false };
      }
      case 2: {
        const i = Math.floor(rng() * (segs.length + 1));
        segs.splice(i, 0, "."); // current-dir
        return { path: segs.join("/"), safe: false };
      }
      case 3:
        return { path: `/${segs.join("/")}`, safe: false }; // absolute POSIX
      case 4:
        return { path: segs.join("\\"), safe: false }; // Windows backslash sep
      case 5:
        return { path: `${segs[0]}:/${segs.slice(1).join("/")}`, safe: false }; // drive/colon
      case 6:
        return { path: `\\\\server\\${segs.join("\\")}`, safe: false }; // UNC
      case 7:
        return { path: `${segs.join("/")}\u0000${safeSegment(rng)}`, safe: false }; // NUL
      case 8:
        return { path: `${segs[0]}//${segs.slice(1).join("/")}`, safe: false }; // empty segment
      default:
        return { path: `${segs.join("/")}/`, safe: false }; // trailing slash
    }
  }

  it(`accepts zero escapes across the seeded corpus (seed=${CORPUS_SEED}, count=${CORPUS_COUNT})`, () => {
    const rng = createSeededRng(CORPUS_SEED);
    let escapesAccepted = 0;
    let safeRejected = 0;
    let total = 0;
    let unsafeSeen = 0;
    let safeSeen = 0;
    for (let i = 0; i < CORPUS_COUNT; i += 1) {
      const { path, safe } = buildCandidate(rng);
      total += 1;
      const accepted = isSafeWorkspacePath(path);
      if (safe) {
        safeSeen += 1;
        if (!accepted) safeRejected += 1;
      } else {
        unsafeSeen += 1;
        if (accepted) escapesAccepted += 1;
      }
    }
    expect(total).toBe(CORPUS_COUNT);
    expect(escapesAccepted).toBe(0); // ZERO escape acceptance
    expect(safeRejected).toBe(0); // and no vacuous "reject-everything"
    expect(unsafeSeen).toBeGreaterThan(1000);
    expect(safeSeen).toBeGreaterThan(500);
  });

  it("agrees between isSafeWorkspacePath and the workspace-entry path field", () => {
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, path: "a/b.txt" }).success).toBe(true);
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, path: "../escape" }).success).toBe(false);
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, path: "/abs" }).success).toBe(false);
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, path: "a\\b" }).success).toBe(false);
  });
});

// =============================================================================
// Workspace base + entry + manifest.
// =============================================================================

describe("workspaceBaseV1Schema", () => {
  it("accepts a git_commit base and a content_manifest base", () => {
    expect(workspaceBaseV1Schema.safeParse(validBase).success).toBe(true);
    expect(
      workspaceBaseV1Schema.safeParse({ ...validBase, kind: "content_manifest", algorithm: "sha256", revision: HASH }).success,
    ).toBe(true);
  });

  it("keys the revision format to the algorithm", () => {
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, algorithm: "git_sha256", revision: HASH }).success).toBe(true);
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, algorithm: "git_sha1", revision: HASH }).success).toBe(false); // 64 hex for a sha1 slot
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, revision: "zz" }).success).toBe(false);
  });

  it("requires tracked:true and ignored:false and a valid caseMode", () => {
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, inclusion: { tracked: false, untracked: "include", ignored: false } }).success).toBe(false);
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, inclusion: { tracked: true, untracked: "include", ignored: true } }).success).toBe(false);
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, caseMode: "insensitive_preserving" }).success).toBe(true);
    expect(workspaceBaseV1Schema.safeParse({ ...validBase, caseMode: "whatever" }).success).toBe(false);
  });
});

describe("workspaceEntrySchema", () => {
  it("accepts a file entry (with hash) and a directory entry (null hash)", () => {
    expect(workspaceEntrySchema.safeParse(fileEntry).success).toBe(true);
    expect(workspaceEntrySchema.safeParse(dirEntry).success).toBe(true);
  });

  it("rejects symlink entries in v1", () => {
    expect(WORKSPACE_ENTRY_KINDS).toEqual(["file", "directory"]);
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, kind: "symlink" }).success).toBe(false);
  });

  it("requires a content hash for files and forbids one for directories", () => {
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, sha256: null }).success).toBe(false);
    expect(workspaceEntrySchema.safeParse({ ...dirEntry, sha256: HASH }).success).toBe(false);
  });

  it("rejects an unknown provenance and unknown keys", () => {
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, provenance: "external" }).success).toBe(false);
    expect(workspaceEntrySchema.safeParse({ ...fileEntry, extra: 1 }).success).toBe(false);
  });
});

describe("workspaceManifestV1Schema", () => {
  it("accepts a well-formed manifest", () => {
    expect(workspaceManifestV1Schema.safeParse(validWorkspaceManifest).success).toBe(true);
  });

  it("fails on duplicate paths", () => {
    const m = clone(validWorkspaceManifest);
    m.entries = [fileEntry, clone(fileEntry)];
    expect(workspaceManifestV1Schema.safeParse(m).success).toBe(false);
  });

  it("fails on case-colliding paths", () => {
    const m = clone(validWorkspaceManifest);
    m.entries = [
      { ...fileEntry, path: "src/Index.ts" },
      { ...fileEntry, path: "src/index.ts" },
    ];
    expect(workspaceManifestV1Schema.safeParse(m).success).toBe(false);
  });

  it("rejects an entry whose path escapes the workspace", () => {
    const m = clone(validWorkspaceManifest);
    m.entries = [{ ...fileEntry, path: "../../etc/passwd" }];
    expect(workspaceManifestV1Schema.safeParse(m).success).toBe(false);
  });
});

// =============================================================================
// Patch manifest.
// =============================================================================

describe("workspacePatchManifestV1Schema", () => {
  const validPatch = {
    protocolVersion: 1,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attempt: ATTEMPT,
    artifactId: ARTIFACT,
    base: validBase,
    baseManifestHash: HASH,
    resultManifestHash: HASH2,
    operations: [
      { op: "create", path: "new.txt", resultSha256: HASH, sizeBytes: 10 },
      { op: "modify", path: "changed.txt", resultSha256: HASH2, sizeBytes: 20 },
      { op: "delete", path: "gone.txt" },
      { op: "rename", path: "to.txt", fromPath: "from.txt", resultSha256: HASH, sizeBytes: 30 },
    ],
  };

  it("accepts create/modify/delete/rename operations", () => {
    expect(workspacePatchManifestV1Schema.safeParse(validPatch).success).toBe(true);
  });

  it("requires distinct base and result manifest hashes", () => {
    expect(workspacePatchManifestV1Schema.safeParse({ ...validPatch, resultManifestHash: HASH }).success).toBe(false);
  });

  it("requires create/modify/rename to carry resultSha256 and sizeBytes", () => {
    expect(
      workspacePatchManifestV1Schema.safeParse({ ...validPatch, operations: [{ op: "create", path: "x.txt" }] }).success,
    ).toBe(false);
    expect(
      workspacePatchManifestV1Schema.safeParse({ ...validPatch, operations: [{ op: "rename", path: "b.txt", resultSha256: HASH, sizeBytes: 1 }] }).success,
    ).toBe(false); // rename missing fromPath
  });

  it("rejects an operation path that escapes the workspace", () => {
    expect(
      workspacePatchManifestV1Schema.safeParse({ ...validPatch, operations: [{ op: "delete", path: "../outside" }] }).success,
    ).toBe(false);
  });
});

// =============================================================================
// Artifact manifest: sensitivity=restricted + object-key prefix binding.
// =============================================================================

describe("artifactManifestV1Schema", () => {
  it("accepts a well-formed restricted manifest", () => {
    expect(artifactManifestV1Schema.safeParse(validArtifactManifest).success).toBe(true);
  });

  it("requires sensitivity restricted for EVERY artifact kind including 'other'", () => {
    expect(artifactSensitivitySchema.safeParse("restricted").success).toBe(true);
    expect(artifactSensitivitySchema.safeParse("normal").success).toBe(false);
    expect(artifactSensitivitySchema.safeParse("public").success).toBe(false);
    expect(RESTRICTED_ARTIFACT_KINDS).toEqual(ARTIFACT_KINDS);
    expect(ARTIFACT_KINDS).toContain("other");
    for (const kind of ARTIFACT_KINDS) {
      // A weaker sensitivity is unrepresentable for every kind — relabeling cannot escape the policy.
      expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, kind, sensitivity: "normal" }).success).toBe(false);
      expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, kind, sensitivity: "restricted" }).success).toBe(true);
    }
  });

  it("requires size, hash, kind, and retention", () => {
    for (const field of ["sizeBytes", "sha256", "kind", "retention"] as const) {
      const m = clone(validArtifactManifest) as Record<string, unknown>;
      delete m[field];
      expect(artifactManifestV1Schema.safeParse(m).success).toBe(false);
    }
  });

  it("requires objectKey under the org/job/attempt prefix and rejects a wrong prefix", () => {
    expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, objectKey: `${attemptPrefix}artifacts/a.txt` }).success).toBe(true);
    // Wrong organization/job/attempt in the key.
    const wrongOrg = expectedAttemptObjectPrefix({ organizationId: "00000000-0000-4000-8000-0000000000ff", jobId: JOB, attempt: ATTEMPT });
    expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, objectKey: `${wrongOrg}artifacts/a.txt` }).success).toBe(false);
    const wrongAttempt = expectedAttemptObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: 2 });
    expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, objectKey: `${wrongAttempt}artifacts/a.txt` }).success).toBe(false);
    // A quarantine-prefixed key is not an ordinary object key.
    expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, objectKey: QUARANTINE_KEY }).success).toBe(false);
    // Traversal in the key suffix.
    expect(artifactManifestV1Schema.safeParse({ ...validArtifactManifest, objectKey: `${attemptPrefix}../escape` }).success).toBe(false);
  });
});

// =============================================================================
// Transfer grant request + upload/download grants.
// =============================================================================

describe("artifactTransferGrantRequestV1Schema", () => {
  const req = {
    protocolVersion: 1,
    operation: "upload",
    workerId: WORKER,
    jobId: JOB,
    attempt: ATTEMPT,
    leaseId: LEASE,
    fenceToken: FENCE,
    artifactId: ARTIFACT,
    expectedObjectKey: OBJECT_KEY,
    expectedSha256: HASH,
    maxBytes: 1024,
  };

  it("accepts upload and download requests bound to the fenced lease", () => {
    expect(artifactTransferGrantRequestV1Schema.safeParse(req).success).toBe(true);
    expect(artifactTransferGrantRequestV1Schema.safeParse({ ...req, operation: "download" }).success).toBe(true);
  });

  it("requires the object key to bind this job/attempt", () => {
    expect(artifactTransferGrantRequestV1Schema.safeParse({ ...req, expectedObjectKey: "organizations/o/jobs/OTHER/attempts/1/x" }).success).toBe(false);
    expect(artifactTransferGrantRequestV1Schema.safeParse({ ...req, expectedObjectKey: "elsewhere/x" }).success).toBe(false);
  });

  it("requires a complete fence and rejects unknown operations", () => {
    const noFence = clone(req) as Record<string, unknown>;
    delete noFence.fenceToken;
    expect(artifactTransferGrantRequestV1Schema.safeParse(noFence).success).toBe(false);
    expect(artifactTransferGrantRequestV1Schema.safeParse({ ...req, operation: "quarantine_upload" }).success).toBe(false);
  });
});

describe("artifact upload/download grants", () => {
  const upload = {
    protocolVersion: 1,
    operation: "upload",
    artifactId: ARTIFACT,
    method: "PUT",
    url: "https://storage.example.com/put?sig=abc",
    headers: { "content-type": "text/plain", "x-amz-meta-run": "1" },
    issuedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:10:00.000Z",
    maxBytes: 1024,
    expectedSha256: HASH,
    objectKey: OBJECT_KEY,
    redaction: "secret",
  };
  const download = { ...upload, operation: "download", method: "GET", url: "https://storage.example.com/get?sig=abc" };

  it("accepts a well-formed upload grant (PUT) and download grant (GET)", () => {
    expect(artifactUploadGrantV1Schema.safeParse(upload).success).toBe(true);
    expect(artifactDownloadGrantV1Schema.safeParse(download).success).toBe(true);
  });

  it("binds method to operation", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, method: "GET" }).success).toBe(false);
    expect(artifactDownloadGrantV1Schema.safeParse({ ...download, method: "PUT" }).success).toBe(false);
  });

  it("requires expiry strictly after issuance", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, expiresAt: upload.issuedAt }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, expiresAt: "2026-08-08T00:00:00.000Z" }).success).toBe(false);
  });

  it("requires an https url", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, url: "http://storage.example.com/put" }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, url: "ftp://storage.example.com/put" }).success).toBe(false);
  });

  it("marks grants secret for redaction", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, redaction: "public" }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, redaction: "none" }).success).toBe(false);
  });

  it("rejects credential-bearing headers", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, headers: { Authorization: "Bearer x" } }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, headers: { Cookie: "s=1" } }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, headers: { "x-api-key": "k" } }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, headers: { "proxy-authorization": "x" } }).success).toBe(false);
  });

  it("binds the object key to the ordinary attempt prefix (not quarantine)", () => {
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, objectKey: QUARANTINE_KEY }).success).toBe(false);
    expect(artifactUploadGrantV1Schema.safeParse({ ...upload, objectKey: "../escape" }).success).toBe(false);
  });
});

// =============================================================================
// Ordinary commit: complete active fence, but schema does not decide staleness.
// =============================================================================

describe("artifactCommitPayloadV1Schema", () => {
  const commit = {
    protocolVersion: 1,
    workerId: WORKER,
    jobId: JOB,
    attempt: ATTEMPT,
    leaseId: LEASE,
    fenceToken: FENCE,
    manifest: validArtifactManifest,
  };

  it("accepts a commit carrying the complete active fence", () => {
    expect(artifactCommitPayloadV1Schema.safeParse(commit).success).toBe(true);
  });

  it("requires every fence-identity field", () => {
    for (const field of ["workerId", "jobId", "attempt", "leaseId", "fenceToken", "manifest"] as const) {
      const c = clone(commit) as Record<string, unknown>;
      delete c[field];
      expect(artifactCommitPayloadV1Schema.safeParse(c).success).toBe(false);
    }
  });

  it("binds the commit job/attempt to the manifest", () => {
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, attempt: 2 }).success).toBe(false);
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, jobId: "00000000-0000-4000-8000-0000000000aa" }).success).toBe(false);
  });

  it("does NOT decide fence staleness — any structurally valid fence parses", () => {
    // Two different valid fence tokens both parse: currency is receiver state, not a schema claim.
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, fenceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).success).toBe(true);
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, fenceToken: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }).success).toBe(true);
  });

  it("has no quarantine/promote/apply field (ordinary commit is a distinct operation)", () => {
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, apply: true }).success).toBe(false);
    expect(artifactCommitPayloadV1Schema.safeParse({ ...commit, promote: true }).success).toBe(false);
  });
});

// =============================================================================
// Quarantine: distinct prefix, device-auth, <=5min, non-promotion.
// =============================================================================

describe("quarantine grant / finalize / receipt", () => {
  const grant = {
    protocolVersion: 1,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 3,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attempt: ATTEMPT,
    observedLeaseId: LEASE,
    observedFenceToken: FENCE,
    reason: "stale_fence",
    artifactId: ARTIFACT,
    expectedObjectKey: QUARANTINE_KEY,
    expectedSha256: HASH,
    sizeBytes: 42,
  };

  const uploadGrant = {
    protocolVersion: 1,
    operation: "quarantine_upload",
    artifactId: ARTIFACT,
    method: "PUT",
    url: "https://quarantine.example.com/put?sig=abc",
    headers: { "content-type": "application/octet-stream" },
    issuedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:05:00.000Z",
    maxBytes: 42,
    expectedSha256: HASH,
    quarantineObjectKey: QUARANTINE_KEY,
    redaction: "secret",
  };

  const finalize = {
    protocolVersion: 1,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 3,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attempt: ATTEMPT,
    observedLeaseId: LEASE,
    observedFenceToken: FENCE,
    reason: "stale_fence",
    artifactId: ARTIFACT,
    quarantineObjectKey: QUARANTINE_KEY,
    expectedSha256: HASH,
    sizeBytes: 42,
    manifest: validArtifactManifest,
  };

  const receipt = {
    protocolVersion: 1,
    receiptId: "00000000-0000-4000-8000-000000000099",
    quarantineObjectKey: QUARANTINE_KEY,
    observed: { workerId: WORKER, targetId: TARGET, deviceGeneration: 3, jobId: JOB, attempt: ATTEMPT, leaseId: LEASE, fenceToken: FENCE },
    artifact: { artifactId: ARTIFACT, sha256: HASH, sizeBytes: 42, sensitivity: "restricted", provenance: "generated" },
    reason: "stale_fence",
    receivedAt: "2026-08-09T00:05:30.000Z",
    disposition: "quarantined",
  };

  it("locks the quarantine reason vocabulary", () => {
    expect(QUARANTINE_REASONS).toEqual([
      "stale_fence",
      "late_output",
      "hash_mismatch",
      "wrong_prefix",
      "size_mismatch",
      "unknown_artifact",
      "corrupt_checkpoint",
    ]);
  });

  it("accepts the device-authenticated grant / upload / finalize / receipt", () => {
    expect(quarantineGrantPayloadV1Schema.safeParse(grant).success).toBe(true);
    expect(quarantineUploadGrantV1Schema.safeParse(uploadGrant).success).toBe(true);
    expect(quarantineFinalizePayloadV1Schema.safeParse(finalize).success).toBe(true);
    expect(quarantineUploadReceiptV1Schema.safeParse(receipt).success).toBe(true);
  });

  it("uses the DISTINCT quarantine prefix, never the ordinary attempt prefix", () => {
    expect(quarantineGrantPayloadV1Schema.safeParse({ ...grant, expectedObjectKey: OBJECT_KEY }).success).toBe(false);
    expect(quarantineUploadGrantV1Schema.safeParse({ ...uploadGrant, quarantineObjectKey: OBJECT_KEY }).success).toBe(false);
    expect(quarantineFinalizePayloadV1Schema.safeParse({ ...finalize, quarantineObjectKey: OBJECT_KEY }).success).toBe(false);
    // ... and the prefixes are genuinely distinct.
    expect(quarantinePrefix.startsWith("quarantine/")).toBe(true);
    expect(attemptPrefix.startsWith("organizations/")).toBe(true);
    expect(quarantinePrefix.startsWith(attemptPrefix)).toBe(false);
    expect(attemptPrefix.startsWith(quarantinePrefix)).toBe(false);
  });

  it("authenticates target + device generation (not a live lease)", () => {
    for (const field of ["targetId", "deviceGeneration", "observedLeaseId", "observedFenceToken"] as const) {
      const g = clone(grant) as Record<string, unknown>;
      delete g[field];
      expect(quarantineGrantPayloadV1Schema.safeParse(g).success).toBe(false);
    }
    expect(quarantineGrantPayloadV1Schema.safeParse({ ...grant, deviceGeneration: 0 }).success).toBe(false);
  });

  it("binds exact org/job/attempt/hash/size on the grant", () => {
    const wrongPrefixKey = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: 2 })}artifacts/log.txt`;
    expect(quarantineGrantPayloadV1Schema.safeParse({ ...grant, expectedObjectKey: wrongPrefixKey }).success).toBe(false);
  });

  it("caps the upload grant expiry at five minutes", () => {
    expect(quarantineUploadGrantV1Schema.safeParse({ ...uploadGrant, expiresAt: "2026-08-09T00:05:00.000Z" }).success).toBe(true);
    expect(quarantineUploadGrantV1Schema.safeParse({ ...uploadGrant, expiresAt: "2026-08-09T00:05:00.001Z" }).success).toBe(false);
    expect(quarantineUploadGrantV1Schema.safeParse({ ...uploadGrant, expiresAt: "2026-08-09T00:10:00.000Z" }).success).toBe(false);
    expect(quarantineUploadGrantV1Schema.safeParse({ ...uploadGrant, expiresAt: uploadGrant.issuedAt }).success).toBe(false);
  });

  it("only accepts a declared quarantine reason on grant and finalize", () => {
    expect(quarantineGrantPayloadV1Schema.safeParse({ ...grant, reason: "because" }).success).toBe(false);
    expect(quarantineFinalizePayloadV1Schema.safeParse({ ...finalize, reason: "because" }).success).toBe(false);
    for (const reason of QUARANTINE_REASONS) {
      expect(quarantineGrantPayloadV1Schema.safeParse({ ...grant, reason }).success).toBe(true);
    }
  });

  it("finalize binds its manifest identity to the observed hash/size/artifact", () => {
    expect(quarantineFinalizePayloadV1Schema.safeParse({ ...finalize, sizeBytes: 43 }).success).toBe(false); // != manifest.sizeBytes
    expect(quarantineFinalizePayloadV1Schema.safeParse({ ...finalize, expectedSha256: HASH2 }).success).toBe(false); // != manifest.sha256
    const mismatchedManifest = { ...validArtifactManifest, artifactId: "00000000-0000-4000-8000-0000000000bb" };
    expect(quarantineFinalizePayloadV1Schema.safeParse({ ...finalize, manifest: mismatchedManifest }).success).toBe(false);
  });

  it("receipt disposition is only 'quarantined'", () => {
    expect(quarantineUploadReceiptV1Schema.safeParse({ ...receipt, disposition: "applied" }).success).toBe(false);
    expect(quarantineUploadReceiptV1Schema.safeParse({ ...receipt, disposition: "promoted" }).success).toBe(false);
    expect(quarantineUploadReceiptV1Schema.safeParse({ ...receipt, disposition: "quarantined" }).success).toBe(true);
  });

  it("NO quarantine schema exposes an apply/promote/select-checkpoint/attempt-mutation field", () => {
    for (const [schema, base] of [
      [quarantineGrantPayloadV1Schema, grant],
      [quarantineUploadGrantV1Schema, uploadGrant],
      [quarantineFinalizePayloadV1Schema, finalize],
      [quarantineUploadReceiptV1Schema, receipt],
    ] as const) {
      for (const field of ["apply", "promote", "selectCheckpoint", "checkpointSelection", "mutateAttempt", "applyToAttempt"]) {
        expect(schema.safeParse({ ...base, [field]: true }).success).toBe(false);
      }
    }
  });
});

// =============================================================================
// Object-key prefix helpers.
// =============================================================================

describe("object-key prefix helpers", () => {
  it("produces the exact ordinary and quarantine prefixes", () => {
    expect(expectedAttemptObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: ATTEMPT })).toBe(
      `organizations/${ORG}/jobs/${JOB}/attempts/1/`,
    );
    expect(expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: JOB, attempt: ATTEMPT })).toBe(
      `quarantine/organizations/${ORG}/jobs/${JOB}/attempts/1/`,
    );
  });
});
