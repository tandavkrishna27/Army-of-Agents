import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { assets } from "@armyofagents/db";
import type { DetectedOutput } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import { getContentType } from "../mime-types.js";
import { assertLocalWorkspaceCommandAllowed } from "./local-workspace-command-guard.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max files to detect per run (prevents runaway storage consumption).
 * Exported: `collectSandboxDiff` (U6.3, sandbox-file-movement.ts) reuses the
 * same cap when pulling files out of an in-VM `git diff` so the sandboxed
 * source is capped identically to the host path before it ever reaches this
 * module's own `merged.slice(0, MAX_FILES_PER_RUN)` below.
 */
export const MAX_FILES_PER_RUN = 20;

/** Max file size to capture for detected outputs. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Timeout for git commands */
const GIT_TIMEOUT_MS = 10_000;

/** Directory patterns to exclude from detection */
const NOISE_DIR_PATTERNS = [
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".tox",
  "target", // Rust/Java
  "vendor", // Go/PHP
];

/** File extension patterns to exclude */
const NOISE_FILE_EXTENSIONS = new Set([
  ".log",
  ".lock",
  ".tmp",
  ".swp",
  ".swo",
  ".pyc",
  ".pyo",
  ".class",
  ".o",
  ".obj",
  ".dll",
  ".so",
  ".dylib",
]);

/** Exact filenames to exclude */
const NOISE_FILENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitkeep",
  ".npmrc",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputDetectionInput {
  runId: string;
  companyId: string;
  agentId: string;
  cwd: string;
  startedAt: Date;
  // Retained for caller compatibility (heartbeat.ts populates it). No longer
  // dispatched on since Sprint 2A removed the API adapters; every remaining
  // adapter has a workspace. Safe to drop in a future cleanup pass once all
  // call sites are audited.
  adapterType: string | null;
  adapterHints?: Array<{ path: string; label?: string; artifactType?: string }>;
  issueId: string | null;
  /**
   * U6.3 (S5) — when present, changed files are sourced from an in-VM `git
   * diff` (`collectSandboxDiff`, sandbox-file-movement.ts) instead of the
   * host `isGitRepo`/`detectChangedFilesGit`/mtime scan below. Sandboxed
   * runs pass a `cwd` that is the VM's `remoteCwd` (e.g.
   * "/home/user/aoa-workspace"), which never exists on the host running
   * this service — so when this is set, the initial host cwd-exists guard
   * and the per-candidate `fs.readFile`/`fs.stat` reads are ALSO bypassed
   * (bytes come from this source instead). `storage.putFile` + the `assets`
   * insert + `DetectedOutput` shaping stay byte-identical either way —
   * outputs remain `status:"pending"` / `confirmedArtifactId:null`
   * (Decision #67, founder review-gated).
   */
  changedFileSource?: () => Promise<Array<{ path: string; content: Buffer }>>;
}

interface AdapterHint {
  path: string;
  label?: string;
  artifactType?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exported: reused by `collectSandboxDiff` (U6.3, sandbox-file-movement.ts)
 * so the in-VM diff filters noise identically to the host path, without
 * duplicating the pattern lists here and there.
 */
export function isNoisePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);

  // Check directory patterns
  for (const part of parts.slice(0, -1)) {
    if (NOISE_DIR_PATTERNS.includes(part)) return true;
    if (part.startsWith(".") && part !== ".") return true; // hidden dirs (except ".")
  }

  // Check filename
  const filename = parts[parts.length - 1];
  if (!filename) return true;
  if (NOISE_FILENAMES.has(filename)) return true;

  const ext = path.extname(filename).toLowerCase();
  if (NOISE_FILE_EXTENSIONS.has(ext)) return true;

  return false;
}

/** Guard against path traversal — resolved path must stay within cwd */
function isInsideWorkspace(cwd: string, absPath: string): boolean {
  const resolvedCwd = path.resolve(cwd);
  return absPath === resolvedCwd || absPath.startsWith(resolvedCwd + path.sep);
}

function execGitCommand(cwd: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(lines);
      },
    );
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(cwd, ".git"));
    return stat.isDirectory() || stat.isFile(); // .git can be a file in worktrees
  } catch {
    return false;
  }
}

async function detectChangedFilesGit(cwd: string): Promise<string[]> {
  // Modified tracked files (staged + unstaged)
  const modified = await execGitCommand(cwd, [
    "diff",
    "--name-only",
    "HEAD",
  ]).catch(() => [] as string[]);

  // New untracked files
  const untracked = await execGitCommand(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).catch(() => [] as string[]);

  // Deduplicate
  const unique = new Set([...modified, ...untracked]);
  return Array.from(unique);
}

async function filterPathsChangedSince(
  cwd: string,
  paths: string[],
  startedAt: Date,
): Promise<string[]> {
  const startMs = startedAt.getTime();
  const result: string[] = [];

  for (const relativePath of paths) {
    const absPath = path.resolve(cwd, relativePath);
    if (!isInsideWorkspace(cwd, absPath)) continue;
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs >= startMs) result.push(relativePath);
    } catch {
      // Deleted git changes are not capturable outputs.
    }
  }

  return result;
}

async function detectChangedFilesMtime(cwd: string, startedAt: Date): Promise<string[]> {
  const result: string[] = [];
  const startMs = startedAt.getTime();

  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!NOISE_DIR_PATTERNS.includes(entry.name) && !entry.name.startsWith(".")) {
          await walk(path.join(dir, entry.name), relativePath);
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          if (stat.mtimeMs >= startMs) {
            result.push(relativePath);
          }
        } catch {
          // Skip files we can't stat
        }
      }

      // Cap early to avoid scanning massive directories
      if (result.length > MAX_FILES_PER_RUN * 2) break;
    }
  }

  await walk(cwd, "");
  return result;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function outputDetectionService(db: Db) {
  return {
    /**
     * Detect new/modified files in an agent's workspace after a heartbeat run,
     * copy them to asset storage, and return detection records.
     *
     * This function MUST never throw — all errors are caught and logged.
     * A failure in output detection should never break the heartbeat flow.
     */
    async detectAndCapture(input: OutputDetectionInput): Promise<DetectedOutput[]> {
      try {
        return await detectAndCaptureImpl(db, input);
      } catch (err) {
        logger.warn(
          { err, runId: input.runId, cwd: input.cwd },
          "output detection failed (non-fatal)",
        );
        return [];
      }
    },
  };
}

async function detectAndCaptureImpl(
  db: Db,
  input: OutputDetectionInput,
): Promise<DetectedOutput[]> {
  const { runId, companyId, agentId, cwd, startedAt, adapterHints, changedFileSource } = input;

  // Guard: verify cwd exists. Only meaningful on the host-fs path — a
  // sandboxed run's `cwd` is the VM's remoteCwd (S5), which never exists on
  // the host running this service, so this guard is skipped when a
  // changedFileSource is supplied (U6.3).
  if (!changedFileSource) {
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }
  }

  // Detect changed files. On the sandboxed path (S5) a single
  // changedFileSource() call both discovers AND reads file bytes (in-VM
  // `git diff` + `readFiles`, collectSandboxDiff) — resolve it once here and
  // reuse the content map in the capture loop below instead of the host
  // fs.readFile/fs.stat pass. The host isGitRepo/detectChangedFilesGit/mtime
  // branch (and the assertLocalWorkspaceCommandAllowed guard inside it) is
  // untouched and only reached when no changedFileSource is supplied.
  let detectedPaths: string[];
  let sandboxContentByPath: Map<string, Buffer> | null = null;
  if (changedFileSource) {
    const sandboxFiles = await changedFileSource();
    sandboxContentByPath = new Map(
      sandboxFiles.map((f) => [f.path.replace(/\\/g, "/"), f.content]),
    );
    detectedPaths = sandboxFiles.map((f) => f.path);
  } else {
    const isGit = await isGitRepo(cwd);
    if (isGit) {
      try {
        assertLocalWorkspaceCommandAllowed("output-detection Git command");
        const gitPaths = await detectChangedFilesGit(cwd);
        detectedPaths = await filterPathsChangedSince(cwd, gitPaths, startedAt);
      } catch (err) {
        logger.warn({ err, cwd }, "git detection failed, falling back to mtime");
        detectedPaths = await detectChangedFilesMtime(cwd, startedAt);
      }
    } else {
      detectedPaths = await detectChangedFilesMtime(cwd, startedAt);
    }
  }

  // Build hint map
  const hintMap = new Map<string, AdapterHint>();
  if (adapterHints) {
    for (const hint of adapterHints) {
      // Normalize to forward slashes
      const normalized = hint.path.replace(/\\/g, "/");
      hintMap.set(normalized, hint);
    }
  }

  // Merge detected paths with adapter hints
  const normalizedDetected = new Set(detectedPaths.map((p) => p.replace(/\\/g, "/")));

  interface MergedFile {
    relativePath: string;
    source: "diff" | "hint" | "both";
    label?: string;
    artifactType?: string;
  }

  const merged: MergedFile[] = [];

  // Files detected by diff (possibly also hinted)
  for (const relPath of normalizedDetected) {
    if (isNoisePath(relPath)) continue;
    const hint = hintMap.get(relPath);
    merged.push({
      relativePath: relPath,
      source: hint ? "both" : "diff",
      label: hint?.label,
      artifactType: hint?.artifactType,
    });
  }

  // Hint-only files (not found in diff)
  for (const [hintPath, hint] of hintMap) {
    if (normalizedDetected.has(hintPath)) continue; // already merged

    // Check if file actually exists in workspace (with path traversal guard)
    const absPath = path.resolve(cwd, hintPath);
    if (!isInsideWorkspace(cwd, absPath)) {
      logger.warn({ cwd, hintPath }, "adapter hint path traversal blocked");
      continue;
    }
    try {
      await fs.stat(absPath);
      merged.push({
        relativePath: hintPath,
        source: "hint",
        label: hint.label,
        artifactType: hint.artifactType,
      });
    } catch {
      // Hinted file doesn't exist — skip
    }
  }

  if (merged.length === 0) return [];

  // Prioritize: hint files first, then diff files, sorted by path
  merged.sort((a, b) => {
    const aHint = a.source === "hint" || a.source === "both" ? 0 : 1;
    const bHint = b.source === "hint" || b.source === "both" ? 0 : 1;
    if (aHint !== bHint) return aHint - bHint;
    return a.relativePath.localeCompare(b.relativePath);
  });

  // Cap at MAX_FILES_PER_RUN
  const candidates = merged.slice(0, MAX_FILES_PER_RUN);

  // Copy files to asset storage
  const storage = getStorageService();
  const results: DetectedOutput[] = [];

  for (const candidate of candidates) {
    try {
      const absPath = path.resolve(cwd, candidate.relativePath);
      if (!isInsideWorkspace(cwd, absPath)) {
        logger.warn({ runId, file: candidate.relativePath }, "path traversal blocked");
        continue;
      }

      // U6.3 (S5): source bytes from the sandbox diff's already-fetched
      // content instead of the host fs.stat/fs.readFile pair. A candidate
      // with no matching sandbox content (e.g. a hint-only entry that isn't
      // part of the in-VM diff) is skipped — the sandbox source has no way
      // to read an arbitrary path we didn't already pull out via
      // collectSandboxDiff's readFiles call.
      let buffer: Buffer;
      let byteSize: number;
      if (sandboxContentByPath) {
        const content = sandboxContentByPath.get(candidate.relativePath.replace(/\\/g, "/"));
        if (content === undefined) continue;
        if (content.length === 0) continue;
        if (content.length > MAX_FILE_BYTES) continue;
        buffer = content;
        byteSize = content.length;
      } else {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        if (stat.size === 0) continue;
        buffer = await fs.readFile(absPath);
        byteSize = stat.size;
      }

      const filename = path.basename(candidate.relativePath);
      const contentType = getContentType(filename);

      // Compute sha256
      const sha256 = createHash("sha256").update(buffer).digest("hex");

      // Store in asset storage
      const stored = await storage.putFile({
        companyId,
        namespace: "agent-outputs",
        originalFilename: filename,
        contentType,
        body: buffer,
      });

      // Create asset record
      const [asset] = await db
        .insert(assets)
        .values({
          companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256 ?? sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: agentId,
          createdByUserId: null,
        })
        .returning();

      results.push({
        path: candidate.relativePath,
        filename,
        byteSize,
        contentType,
        assetId: asset.id,
        sha256: stored.sha256 ?? sha256,
        source: candidate.source,
        label: candidate.label ?? null,
        artifactType: candidate.artifactType ?? null,
        status: "pending",
        confirmedArtifactId: null,
        confirmedVersionId: null,
      });
    } catch (err) {
      logger.warn(
        { err, runId, file: candidate.relativePath },
        "failed to capture output file (skipping)",
      );
    }
  }

  return results;
}
