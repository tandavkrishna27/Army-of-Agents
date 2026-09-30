/**
 * @armyofagents/worker-daemon — DAT-001 workspace-snapshot producer barrel.
 *
 * A deterministic, pure, self-validating snapshot producer (no DB / persistence —
 * that is DAT-002). Emits a frozen `WorkspaceManifestV1` + its two pinned digests.
 */

export {
  buildWorkspaceManifest,
  parseManifestFailClosed,
  assertRepresentable,
  assertNoCollisions,
  normalizeRelPath,
} from "./build-manifest.js";
export type {
  BuildWorkspaceManifestInput,
  BuildWorkspaceManifestResult,
  SnapshotBudget,
} from "./build-manifest.js";

export { WorkspaceSnapshotError } from "./errors.js";

export { DEFAULT_SNAPSHOT_LIMITS, SCHEMA_MAX_ENTRIES } from "./limits.js";
export type { SnapshotLimits } from "./limits.js";

export {
  compareUtf8,
  sortSnapshotEntries,
  computeContentRevision,
  computeManifestHash,
} from "./hashing.js";
export type { Sha256Fn, SnapshotEntry, IgnorePolicyRecord, InclusionRecord } from "./hashing.js";

export {
  AOA_BUILTIN_IGNORE_RULES,
  classifyExplicitRule,
  isIgnoredByExplicit,
  computeExplicitIgnoreDigest,
  resolveEffectiveExplicitRules,
  computeGitignoreDigest,
} from "./ignore.js";
export type { IgnorePolicyInput, GitignoreSource } from "./ignore.js";

export { createGitRunner, GitRunnerError, GIT_HARDENING_FLAGS } from "./git-runner.js";
export type { GitRunner, GitRunResult } from "./git-runner.js";

export { captureGitBase } from "./git-base.js";
export type { CaptureGitBaseInput, CapturedGitBase } from "./git-base.js";
