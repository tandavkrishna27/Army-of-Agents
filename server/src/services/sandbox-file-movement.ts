/**
 * U6.2 — sandbox file-movement seam.
 *
 * Org stage-in: the host clones the company repo elsewhere (PAT host-side,
 * reusing existing worktree/`resolveGitHubAuth` infra — not this file's
 * concern), then this module uploads that host clone's working tree
 * (**including `.git`**, so `git diff HEAD` works inside the VM) into the
 * sandbox's `remoteCwd` via the provider file-write seam added in this wave
 * (`SandboxRuntimeProvider.writeFiles`, `sandbox-provider-runtime.ts`).
 *
 * All host-side archiving of the clone runs through the U6.1
 * `assertHostOrchestrationGitAllowed` guard — this is AoA's own code
 * operating on a host clone, never a tenant CLI shell, so it is permitted on
 * cloud_auth (spec §9 blast-radius reframe) while the tenant-command guard
 * stays refused.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { shellQuote } from "@armyofagents/adapter-utils";
import { assertHostOrchestrationGitAllowed } from "./local-workspace-command-guard.js";
import { isNoisePath, MAX_FILES_PER_RUN } from "./output-detection.js";

/** Generous ceiling for a repo working tree tarball (incl. `.git`). */
const TAR_MAX_BUFFER = 200 * 1024 * 1024;

const REMOTE_TAR_PATH = "/tmp/aoa-repo.tar";

export interface SandboxExecuteResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SandboxExecuteInput {
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutSec?: number;
}

/**
 * The minimal runner surface this module needs. A strict superset of this
 * shape is produced by `environment-run-orchestrator.ts`'s `buildProviderRunner`
 * (`SandboxFileMovementProviderRunner`) — kept as a separate, decoupled
 * interface here so this module doesn't import orchestrator internals, and
 * so a hand-built test double (over the fake `SandboxRuntimeProvider`) only
 * needs to satisfy this shape, not the full adapter-execution-target type.
 */
export interface SandboxFileMovementRunner {
  execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
  readFiles?(input: { paths: string[] }): Promise<Array<{ path: string; content: Buffer }>>;
  resolveHost?(input: { port: number }): Promise<string>;
}

/**
 * Host-side: tar the host clone's working tree (incl. `.git`) into an
 * in-memory buffer. `--format=ustar` is a deliberate implementation choice —
 * a portable, minimal archive (no GNU long-name/PAX extensions) that keeps
 * the archive trivially parseable by a minimal reader (the fake sandbox
 * provider's `execute()` used in CI, mirroring the AOA_E2E_FAKE_EMBEDDER
 * seam, spec §10). A real E2B VM extracts with a real `tar` binary and is
 * unaffected by this host-side creation choice.
 *
 * Wrapped in the U6.1 host-orchestration guard: this archives a HOST clone
 * that AoA's own orchestration code produced, never a tenant CLI shell, so
 * it is permitted on cloud_auth while the tenant-workspace-command guard
 * stays refused there.
 */
async function tarHostClone(hostClonePath: string): Promise<Buffer> {
  assertHostOrchestrationGitAllowed("org stage-in tar");
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "tar",
      ["--format=ustar", "-cf", "-", "-C", hostClonePath, "."],
      { maxBuffer: TAR_MAX_BUFFER, encoding: "buffer" },
      (error, stdout) => {
        if (error) {
          reject(new Error(`org stage-in: tar failed for "${hostClonePath}": ${error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Uploads the host clone at `hostClonePath` (working tree + `.git`) into the
 * sandbox at `remoteCwd`: tar on the host -> `runner.writeFiles` the archive
 * into the VM -> `tar -xf` it into place in-VM -> clean up the staged
 * archive. `remoteCwd` is shell-quoted (path-injection-safe); the archive's
 * own remote path is a fixed constant, not caller-controlled.
 */
export async function stageRepoIntoSandbox(input: {
  runner: SandboxFileMovementRunner;
  hostClonePath: string;
  remoteCwd: string;
}): Promise<void> {
  const tarBuffer = await tarHostClone(input.hostClonePath);

  await input.runner.writeFiles([{ path: REMOTE_TAR_PATH, content: tarBuffer }]);

  const script = [
    `mkdir -p ${shellQuote(input.remoteCwd)}`,
    `tar -xf ${REMOTE_TAR_PATH} -C ${shellQuote(input.remoteCwd)}`,
    `rm -f ${REMOTE_TAR_PATH}`,
  ].join(" && ");

  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", script],
    cwd: null,
    env: {},
    stdin: null,
    timeoutSec: 120,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `org stage-in: failed to extract repo into sandbox remoteCwd "${input.remoteCwd}" ` +
        `(exit ${result.exitCode ?? "null"}): ${result.stderr || result.stdout}`,
    );
  }
}

// ---------------------------------------------------------------------------
// U6.3 — in-VM diff pull-out.
// ---------------------------------------------------------------------------

const GIT_DIFF_TIMEOUT_SEC = 30;

/**
 * Runs one hooks-neutralized git command inside the sandbox and returns its
 * stdout as trimmed, non-empty lines (same shape `execGitCommand` produces
 * host-side in output-detection.ts).
 *
 * `-c core.hooksPath=` is a SECURITY requirement, not a convenience: this
 * git repo was populated by `stageRepoIntoSandbox` from a host clone (and
 * ultimately from a pulled/committed tenant repo) — a hook script committed
 * into that repo must never execute, in-VM or on the host. Built as a single
 * `sh -c` shell string (mirroring `stageRepoIntoSandbox`'s own script style
 * in this file) with `remoteCwd` shell-quoted.
 */
async function runGitCommand(
  runner: SandboxFileMovementRunner,
  remoteCwd: string,
  gitArgs: string[],
): Promise<string[]> {
  // gitArgs are static, hardcoded literals owned by this module (never
  // caller/tenant-controlled) so, unlike remoteCwd, they don't need
  // individual shell-quoting.
  const script = `git -c core.hooksPath= -C ${shellQuote(remoteCwd)} ${gitArgs.join(" ")}`;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", script],
    cwd: null,
    env: {},
    stdin: null,
    timeoutSec: GIT_DIFF_TIMEOUT_SEC,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `collectSandboxDiff: "git ${gitArgs.join(" ")}" failed in remoteCwd "${remoteCwd}" ` +
        `(exit ${result.exitCode ?? "null"}): ${result.stderr || result.stdout}`,
    );
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Pulls the in-VM working-tree diff out of a staged sandbox repo: modified
 * tracked files (`git diff --name-only HEAD`) plus untracked files (`git
 * ls-files --others --exclude-standard`), deduped (same shape as
 * `detectChangedFilesGit` in output-detection.ts), filtered through the
 * shared `isNoisePath` and capped at the shared `MAX_FILES_PER_RUN` — both
 * reused from output-detection.ts so the sandboxed source is filtered
 * identically to the host path — then read out via `runner.readFiles`.
 *
 * Feeds `output-detection.ts`'s `changedFileSource` (U6.3) for org runs that
 * acquired a provider-sandbox lease (S5: `acquisition.environment.driver
 * === "sandbox"`).
 */
export async function collectSandboxDiff(input: {
  runner: SandboxFileMovementRunner;
  remoteCwd: string;
}): Promise<Array<{ path: string; content: Buffer }>> {
  // Each command fails independently (mirrors output-detection.ts's own
  // detectChangedFilesGit) so a failure on one (e.g. `ls-files`) doesn't
  // zero out the other's results.
  const [modified, untracked] = await Promise.all([
    runGitCommand(input.runner, input.remoteCwd, ["diff", "--name-only", "HEAD"]).catch(
      () => [] as string[],
    ),
    runGitCommand(input.runner, input.remoteCwd, ["ls-files", "--others", "--exclude-standard"]).catch(
      () => [] as string[],
    ),
  ]);

  // Dedupe — same shape as output-detection.ts's detectChangedFilesGit.
  const uniquePaths = Array.from(new Set([...modified, ...untracked]));
  const candidatePaths = uniquePaths.filter((p) => !isNoisePath(p)).slice(0, MAX_FILES_PER_RUN);

  if (candidatePaths.length === 0) return [];

  if (typeof input.runner.readFiles !== "function") {
    throw new Error("collectSandboxDiff: runner does not support readFiles");
  }

  // Read via absolute in-VM paths (relative to remoteCwd, the repo root
  // stageRepoIntoSandbox extracted into), but key results back by the
  // ORIGINAL relative path — matching the relative-path convention
  // output-detection.ts's own DetectedOutput.path uses for the host branch.
  const relativeByRemotePath = new Map(
    candidatePaths.map((relativePath) => [path.posix.join(input.remoteCwd, relativePath), relativePath]),
  );
  const fetched = await input.runner.readFiles({ paths: [...relativeByRemotePath.keys()] });

  const results: Array<{ path: string; content: Buffer }> = [];
  for (const file of fetched) {
    const relativePath = relativeByRemotePath.get(file.path);
    if (!relativePath) continue;
    results.push({ path: relativePath, content: file.content });
  }
  return results;
}

// ---------------------------------------------------------------------------
// U6.6 — preview URLs via E2B `getHost(port)`.
// ---------------------------------------------------------------------------

/**
 * Resolves a public preview URL for a port the sandboxed dev server is
 * listening on, via the provider's `resolveHost` (E2B `getHost(port)`).
 *
 * `getHost` returns the routable HOST ONLY — no scheme (e.g.
 * `"3000-fakesandbox.e2b.app"`) — so `https://` is prefixed here. The result
 * is derived SOLELY from `runner.resolveHost` (the provider's own
 * port -> public-host mapping): never from the control-plane's own
 * host/port, and never a `localhost`/`127.0.0.1`/internal address — that is
 * the whole point of this seam (in-VM dev servers fail the host-loopback
 * preview path on cloud; this is the fix).
 *
 * `resolveHost` is OPTIONAL on `SandboxFileMovementRunner` (a bare
 * `execute`-only runner, or a non-provider/local lease, may not implement
 * it) — throws a clear, named error rather than silently falling back to a
 * host-loopback URL, so a caller's best-effort wrapper (e.g.
 * `emitSandboxPreviewTaskOutput`, task-output-emitters.ts) can log-and-skip
 * instead of persisting a broken preview link.
 */
export async function resolveSandboxPreviewUrl(input: {
  runner: SandboxFileMovementRunner;
  port: number;
}): Promise<string> {
  if (typeof input.runner.resolveHost !== "function") {
    throw new Error(
      "resolveSandboxPreviewUrl: runner does not support resolveHost " +
        "(not a provider-sandbox runner, or this provider does not implement port -> host resolution)",
    );
  }
  const host = await input.runner.resolveHost({ port: input.port });
  return `https://${host}`;
}
