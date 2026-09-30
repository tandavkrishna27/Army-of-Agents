/**
 * Hardened git invocation seam (DAT-001-D7).
 *
 * Every git call goes through a `GitRunner`. The DEFAULT runner uses
 * `node:child_process` `execFile` — NEVER a shell — and prepends, on EVERY
 * invocation:
 *   - `-c core.hooksPath=`   → no committed hook executes (a SECURITY guarantee:
 *     a snapshotted repo may carry a malicious hook).
 *   - `-c core.quotepath=false` → raw UTF-8 paths, not octal-escaped.
 * Callers additionally pass `-z` (NUL-delimited output) on enumeration commands
 * so paths containing spaces/newlines parse safely. File CONTENT is read via
 * `node:fs` and hashed directly (never through git), so `core.autocrlf`/filters
 * cannot perturb content hashes.
 *
 * The runner is INJECTED into `buildWorkspaceManifest` so tests can drive git
 * behavior deterministically without a repo; the default is exported for real use
 * and for the git-base hermetic tests (which init a temp repo).
 */

import { execFile } from "node:child_process";

/** The raw stdout bytes of a git invocation (Buffer so `-z` NUL parsing is exact). */
export interface GitRunResult {
  readonly stdout: Buffer;
}

/** A git invocation seam: logical git args + a working directory. */
export type GitRunner = (args: readonly string[], options: { readonly cwd: string }) => Promise<GitRunResult>;

/** Thrown by the default runner when git exits non-zero or cannot be spawned. */
export class GitRunnerError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "GitRunnerError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The always-prepended hardening flags (DAT-001-D7). */
export const GIT_HARDENING_FLAGS: readonly string[] = ["-c", "core.hooksPath=", "-c", "core.quotepath=false"];

/** A generous stdout ceiling for enumeration of large trees (256 MiB). */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * The default `execFile`-based runner. It resolves raw Buffer stdout, rejects with
 * a {@link GitRunnerError} on a non-zero exit or spawn failure, and applies the
 * D7 hardening flags to every call.
 */
export function createGitRunner(): GitRunner {
  return (args, options) =>
    new Promise<GitRunResult>((resolve, reject) => {
      execFile(
        "git",
        [...GIT_HARDENING_FLAGS, ...args],
        { cwd: options.cwd, encoding: "buffer", maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
            const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
            reject(new GitRunnerError(`git ${args.join(" ")} failed: ${error.message}`, code, stderrText));
            return;
          }
          resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout) });
        },
      );
    });
}
