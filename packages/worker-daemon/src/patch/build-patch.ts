/**
 * The workspace-PATCH producer (DAT-003).
 *
 * A deterministic, pure in-memory set-diff of two frozen DAT-001
 * `WorkspaceManifestV1` entry lists (base → result) → a frozen
 * `WorkspacePatchManifestV1`, self-validating FAIL-CLOSED with the frozen
 * `workspacePatchManifestV1Schema.parse()` (DAT-003-D1) as the final gate.
 *
 * NO git, NO DB, NO storage — the diff is over manifests only (git is DAT-001's
 * capture concern). Everything determinism-critical is injected: the `sha256`
 * provider is threaded through only to (re)compute the two manifest digests via
 * the shared `computeManifestHash`, exactly as DAT-001 does.
 *
 * Diff semantics (keyed by file `path`; directory entries are IGNORED — a
 * directory-only change surfaces via its files):
 *   - result-only file            → `create`
 *   - both present, sha256 differs → `modify`
 *   - base-only file              → `delete` candidate
 *   - a `delete` candidate whose sha256 equals a `create` candidate's sha256,
 *     1:1 (exactly one delete + one create share that sha), folds into one
 *     `rename{fromPath, path, resultSha256, sizeBytes}`. Ambiguous many-way
 *     content identity does NOT fold (deterministic separate delete + create).
 *
 * Op order is the pinned UTF-8 byte order over the (schema-unique) destination
 * `path` — the SOLE ordering authority, reusing `compareUtf8` from the snapshot
 * hashing module. The frozen schema re-enforces destination-path uniqueness and
 * `baseManifestHash !== resultManifestHash` (a no-op diff has zero ops → the
 * schema's `min(1)` rejects it; we fail closed before that too).
 *
 * Boundary-legal (worker-protocol + `node:*` only; no new dependency).
 */

import { workspacePatchManifestV1Schema, type WorkspaceManifestV1, type WorkspacePatchManifestV1 } from "@armyofagents/worker-protocol";

import { compareUtf8, computeManifestHash, type Sha256Fn } from "../snapshot/hashing.js";
import { WorkspacePatchError } from "./errors.js";

/**
 * A structurally-plain patch operation (unbranded strings). The frozen schema's
 * `.parse()` brands it into a `PatchOperation` at the final gate — building the
 * branded type directly would require casting every content-addressed hash.
 */
type RawPatchOperation =
  | { op: "create"; path: string; resultSha256: string; sizeBytes: number }
  | { op: "modify"; path: string; resultSha256: string; sizeBytes: number }
  | { op: "delete"; path: string }
  | { op: "rename"; fromPath: string; path: string; resultSha256: string; sizeBytes: number };

export interface BuildWorkspacePatchInput {
  /** The base (prior) captured manifest. */
  readonly base: WorkspaceManifestV1;
  /** The result (current) captured manifest. */
  readonly result: WorkspaceManifestV1;
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly artifactId: string;
  /** Injected sha256 provider (lowercase hex) — the SAME seam DAT-001 uses. */
  readonly sha256: Sha256Fn;
}

export interface BuildWorkspacePatchResult {
  readonly patch: WorkspacePatchManifestV1;
  readonly baseManifestHash: string;
  readonly resultManifestHash: string;
}

/** A file entry (kind === "file") reduced to the fields the diff keys on. */
interface FileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Index the FILE entries of a manifest by path (directories are ignored). */
function fileEntries(manifest: WorkspaceManifestV1): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    if (entry.sha256 === null) {
      // The frozen schema guarantees file entries carry a hash; a null here is a
      // corrupt/unvalidated input — fail closed rather than diff against nothing.
      throw new WorkspacePatchError(`file entry missing content hash: ${entry.path}`);
    }
    map.set(entry.path, { path: entry.path, sha256: entry.sha256, sizeBytes: entry.sizeBytes });
  }
  return map;
}

/**
 * Diff two file-entry maps into raw operations. `create`/`modify` are decided
 * directly; base-only paths are held as delete candidates until rename detection
 * folds the 1:1 content-identical create↔delete pairs.
 */
function diffOperations(base: Map<string, FileEntry>, result: Map<string, FileEntry>): RawPatchOperation[] {
  const modifies: RawPatchOperation[] = [];
  const createCandidates: FileEntry[] = [];
  const deleteCandidates: FileEntry[] = [];

  for (const entry of result.values()) {
    const prior = base.get(entry.path);
    if (!prior) {
      createCandidates.push(entry);
    } else if (prior.sha256 !== entry.sha256) {
      modifies.push({ op: "modify", path: entry.path, resultSha256: entry.sha256, sizeBytes: entry.sizeBytes });
    }
    // prior && same sha → unchanged (no op).
  }
  for (const entry of base.values()) {
    if (!result.has(entry.path)) deleteCandidates.push(entry);
  }

  // Rename detection: a sha256 with EXACTLY one delete candidate AND exactly one
  // create candidate is a 1:1 content-identical move → one rename. Anything else
  // stays a separate delete + create (deterministic; no ambiguous fold).
  const createsBySha = groupBySha(createCandidates);
  const deletesBySha = groupBySha(deleteCandidates);
  const renamedCreates = new Set<string>();
  const renamedDeletes = new Set<string>();
  const renames: RawPatchOperation[] = [];
  for (const [sha, dels] of deletesBySha) {
    const crs = createsBySha.get(sha);
    if (dels.length === 1 && crs && crs.length === 1) {
      const from = dels[0]!;
      const to = crs[0]!;
      renames.push({ op: "rename", fromPath: from.path, path: to.path, resultSha256: to.sha256, sizeBytes: to.sizeBytes });
      renamedDeletes.add(from.path);
      renamedCreates.add(to.path);
    }
  }

  const creates: RawPatchOperation[] = createCandidates
    .filter((c) => !renamedCreates.has(c.path))
    .map((c) => ({ op: "create", path: c.path, resultSha256: c.sha256, sizeBytes: c.sizeBytes }));
  const deletes: RawPatchOperation[] = deleteCandidates
    .filter((d) => !renamedDeletes.has(d.path))
    .map((d) => ({ op: "delete", path: d.path }));

  return [...modifies, ...creates, ...deletes, ...renames];
}

function groupBySha(entries: readonly FileEntry[]): Map<string, FileEntry[]> {
  const map = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.sha256);
    if (list) list.push(entry);
    else map.set(entry.sha256, [entry]);
  }
  return map;
}

/** Deterministic op order: ascending UTF-8 byte order of the destination path
 * (unique across all ops by the frozen schema — rename's `fromPath` is excluded). */
function sortOperations(operations: readonly RawPatchOperation[]): RawPatchOperation[] {
  return [...operations].sort((a, b) => compareUtf8(a.path, b.path));
}

export function buildWorkspacePatch(input: BuildWorkspacePatchInput): BuildWorkspacePatchResult {
  const baseFiles = fileEntries(input.base);
  const resultFiles = fileEntries(input.result);

  const baseManifestHash = computeManifestHash(input.base, input.sha256);
  const resultManifestHash = computeManifestHash(input.result, input.sha256);

  const operations = sortOperations(diffOperations(baseFiles, resultFiles));
  if (operations.length === 0) {
    // Zero file operations. The frozen schema forbids an empty patch (min 1 op +
    // distinct hashes), so fail closed before `.parse()` — but distinguish a genuine
    // no-change from a change the FROZEN patch format cannot carry (executable bit,
    // provenance, directory-only, capture metadata all feed manifestHash but have no
    // patch operation), so the diagnostic is accurate rather than a bare "no differences".
    if (baseManifestHash !== resultManifestHash) {
      throw new WorkspacePatchError(
        "workspace differs only in metadata not representable as file operations (e.g. executable bit); no patch emitted",
      );
    }
    throw new WorkspacePatchError("no differences between base and result manifests");
  }

  const candidate = {
    protocolVersion: 1 as const,
    organizationId: input.organizationId,
    companyId: input.companyId,
    jobId: input.jobId,
    attempt: input.attempt,
    artifactId: input.artifactId,
    base: input.base.base,
    baseManifestHash,
    resultManifestHash,
    operations,
  };

  let patch: WorkspacePatchManifestV1;
  try {
    patch = workspacePatchManifestV1Schema.parse(candidate);
  } catch (error) {
    throw new WorkspacePatchError(`self-validation failed: ${(error as Error).message}`);
  }
  return { patch, baseManifestHash, resultManifestHash };
}
