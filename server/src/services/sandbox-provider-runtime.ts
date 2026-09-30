import { randomUUID } from "node:crypto";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { createGvisorSandboxRuntimeProvider } from "./gvisor-sandbox-provider.js";

export interface SandboxProviderAcquireInput {
  companyId: string;
  environmentId: string;
  issueId: string | null;
  heartbeatRunId: string | null;
  config: Record<string, unknown>;
  workspaceMode: string | null;
  /**
   * S4 — best-effort egress allowlist for this sandbox. Recorded verbatim in
   * `SandboxProviderLease.metadata.egressAllowlist` when provided; omitted
   * entirely (not defaulted to `[]`) when absent, so existing exact-shape
   * lease-metadata assertions in `sandbox-provider-runtime.test.ts` stay
   * green. Managed E2B cannot fully enforce this (§11/§12 of the spec) — the
   * provider records it for best-effort/managed recording and MUST NOT throw
   * when it cannot lock egress down. U11 unions connector hosts + npm into
   * this array at the acquire call site.
   */
  egressAllowlist?: string[];
}

export interface SandboxProviderLease {
  providerLeaseId: string;
  expiresAt?: Date | string | null;
  metadata: Record<string, unknown>;
}

export interface SandboxProviderReleaseInput {
  providerLeaseId: string | null;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}

export interface SandboxProviderReleaseResult {
  cleanupStatus: "success" | "failed";
  metadata?: Record<string, unknown>;
}

/**
 * U7.4 — warm-resume input. Mirrors the shape of `SandboxProviderReleaseInput`
 * (providerLeaseId + persisted lease metadata + optional resolved config) so
 * callers can resume a previously-paused lease the same way they release one.
 */
export interface SandboxProviderResumeInput {
  providerLeaseId: string;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}

/**
 * U7.4 — `resumed: false` signals "the paused sandbox is gone, create a
 * fresh one" — it is NEVER an error path (spec §8 "never error the run").
 * Callers key off `resumed`, not exceptions.
 */
export interface SandboxProviderResumeResult {
  resumed: boolean;
  providerLeaseId: string;
  metadata: Record<string, unknown>;
}

export interface SandboxProviderExecuteInput {
  providerLeaseId: string;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  stdin?: string | null;
  /** U13.5 — deliver `content` into the VM as a NAMED file at `remotePath`
   *  (chosen by the caller, e.g. one-shot-sandbox-cli.ts) instead of
   *  anonymous stdin. Written BEFORE the command runs, via the SAME internal
   *  file-staging mechanism `stdin` already relies on (there is no separate
   *  top-level `files.write` operation on this interface — see the E2B
   *  `execute()` implementation below). Mutually exclusive with `stdin` in
   *  practice: callers pass one or the other, never both (when both are
   *  present this field wins — see `execute()`). */
  stagedFile?: { remotePath: string; content: string } | null;
  timeoutMs?: number | null;
  /** U7.5b — optional live-output callbacks. When set, the provider forwards
   *  incremental stdout/stderr chunks to them (E2B `commands.run` callbacks) in
   *  addition to returning the final buffered result. Omitted ⇒ byte-identical
   *  to the buffered-only path (org/crew today). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SandboxProviderExecuteResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxProviderWriteFilesInput {
  providerLeaseId: string;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  files: Array<{ path: string; content: Buffer }>;
}

export interface SandboxProviderReadFilesInput {
  providerLeaseId: string;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  paths: string[];
}

export interface SandboxProviderResolveHostInput {
  providerLeaseId: string;
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  port: number;
}

export interface SandboxProviderConfigValidationResult {
  ok: boolean;
  provider: string;
  errors?: string[];
  sanitizedConfig?: Record<string, unknown>;
}

export interface SandboxProviderProbeInput {
  companyId: string;
  environmentId: string;
  config: Record<string, unknown>;
}

export interface SandboxProviderProbeResult {
  ok: boolean;
  provider: string;
  summary: string;
  metadata?: Record<string, unknown>;
  errors?: string[];
}

export interface SandboxRuntimeProvider {
  readonly provider: string;
  validateConfig?(config: Record<string, unknown>): Promise<SandboxProviderConfigValidationResult>;
  probe?(input: SandboxProviderProbeInput): Promise<SandboxProviderProbeResult>;
  acquireLease(input: SandboxProviderAcquireInput): Promise<SandboxProviderLease>;
  releaseLease(input: SandboxProviderReleaseInput): Promise<SandboxProviderReleaseResult>;
  /**
   * U7.4 — warm resume. OPTIONAL: providers without warm-pause support (e.g.
   * gVisor today) simply don't implement it; the `sandboxProviderRuntime`
   * passthrough below throws a clear "does not support resume" error if a
   * caller invokes it on such a provider, rather than silently no-oping.
   * Implementations MUST resolve `{ resumed: false, ... }` instead of
   * rejecting when the underlying sandbox is gone (dead/GC'd) — never throw
   * for that case (spec §8 "never error the run").
   */
  resumeLease?(input: SandboxProviderResumeInput): Promise<SandboxProviderResumeResult>;
  execute(input: SandboxProviderExecuteInput): Promise<SandboxProviderExecuteResult>;
  /**
   * U6.2 — file-movement seam. OPTIONAL so providers that don't (yet) support
   * staging files in/out (e.g. a future docker/self-hosted driver) don't have
   * to implement a no-op. Implemented today by the fake provider (in-memory
   * `Map`) and the E2B provider (`sandbox.files.write`/`.read` via connect()).
   */
  writeFiles?(input: SandboxProviderWriteFilesInput): Promise<void>;
  readFiles?(input: SandboxProviderReadFilesInput): Promise<Array<{ path: string; content: Buffer }>>;
  /** Resolve a public/preview host for a port exposed inside the sandbox (E2B `getHost`). */
  resolveHost?(input: SandboxProviderResolveHostInput): Promise<string>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function sanitizeProviderLeasePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "lease";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// ---------------------------------------------------------------------------
// Fake provider in-memory FS + minimal ustar/shell emulation (U6.2).
//
// The fake provider is the CI stand-in for a real sandbox (mirrors the
// AOA_E2E_FAKE_EMBEDDER pattern, spec §10): `writeFiles`/`readFiles` are the
// source of truth over an in-memory `Map<string, Buffer>`, and `execute`
// additionally interprets the small, fixed set of `sh -c "..."` shell
// scripts AoA's own orchestration code emits (`mkdir -p`, `tar -xf … -C …`,
// `rm -f`, `ls -a`, `test -d`) so a real `stageRepoIntoSandbox` round-trips
// against it without needing a live VM. This is NOT a general shell/tar
// implementation — unrecognized commands fall back to the pre-existing
// generic "fake: <cmd>" stub.
// ---------------------------------------------------------------------------

interface FakeSandboxFs {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

function fakePosixNormalize(p: string): string {
  const normalized = path.posix.normalize(p);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function fakeMarkDir(fs: FakeSandboxFs, dirPath: string): void {
  let current = fakePosixNormalize(dirPath);
  while (true) {
    fs.dirs.add(current);
    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function fakeWriteFile(fs: FakeSandboxFs, filePath: string, content: Buffer): void {
  const normalized = fakePosixNormalize(filePath);
  fs.files.set(normalized, content);
  fakeMarkDir(fs, path.posix.dirname(normalized));
}

/** Minimal POSIX ustar reader: enough for a repo tar of regular files + dirs. */
function parseUstarBuffer(buf: Buffer): Array<{ name: string; type: "file" | "dir"; data: Buffer }> {
  const entries: Array<{ name: string; type: "file" | "dir"; data: Buffer }> = [];
  const BLOCK = 512;

  function readCString(header: Buffer, start: number, len: number): string {
    const slice = header.subarray(start, start + len);
    const nul = slice.indexOf(0);
    return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
  }
  function readOctal(header: Buffer, start: number, len: number): number {
    const raw = readCString(header, start, len).trim();
    return raw.length > 0 ? parseInt(raw, 8) || 0 : 0;
  }

  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const fullName = prefix ? `${prefix}/${name}` : name;
    offset += BLOCK;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (!fullName) continue;
    if (typeflag === "5" || fullName.endsWith("/")) {
      entries.push({ name: fullName.replace(/\/+$/, ""), type: "dir", data: Buffer.alloc(0) });
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      entries.push({ name: fullName, type: "file", data: Buffer.from(data) });
    }
    // Other typeflags (symlinks, PAX/GNU-longname extensions, …) are outside
    // this minimal reader's scope — `stageRepoIntoSandbox` writes with
    // `--format=ustar` on the host precisely to avoid emitting them.
  }
  return entries;
}

/**
 * Splits a `&&`-segment into shell words, unquoting simple single-quoted
 * tokens (what this file's own `shellQuote()` produces for plain paths).
 * Not a general shell parser — sufficient for the fixed command shapes
 * `stageRepoIntoSandbox`/the stage-in test emit.
 */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  const re = /'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment.trim())) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return tokens;
}

/** Runs one `&&`-chained `sh -c "…"` script against the fake in-memory FS. */
function runFakeShellScript(script: string, fs: FakeSandboxFs): SandboxProviderExecuteResult {
  const segments = script.split(" && ").map((s) => s.trim()).filter(Boolean);
  let lastStdout = "";
  for (const segment of segments) {
    const tokens = tokenizeShellSegment(segment);
    const [cmd, ...rest] = tokens;
    if (cmd === "mkdir" && rest.includes("-p")) {
      const target = rest.filter((t) => t !== "-p")[0];
      if (target) fakeMarkDir(fs, target);
      lastStdout = "";
      continue;
    }
    if (cmd === "tar") {
      const xIdx = rest.indexOf("-xf");
      const cIdx = rest.indexOf("-C");
      const tarPath = xIdx >= 0 ? rest[xIdx + 1] : undefined;
      const destDir = cIdx >= 0 ? rest[cIdx + 1] : undefined;
      if (!tarPath || !destDir) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: `tar: missing -xf/-C in "${segment}"` };
      }
      const archive = fs.files.get(fakePosixNormalize(tarPath));
      if (!archive) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: `tar: cannot open '${tarPath}'` };
      }
      fakeMarkDir(fs, destDir);
      for (const entry of parseUstarBuffer(archive)) {
        const target = path.posix.join(destDir, entry.name);
        if (entry.type === "dir") fakeMarkDir(fs, target);
        else fakeWriteFile(fs, target, entry.data);
      }
      lastStdout = "";
      continue;
    }
    if (cmd === "rm") {
      const target = rest.filter((t) => t !== "-f" && t !== "-r" && t !== "-rf").pop();
      if (target) fs.files.delete(fakePosixNormalize(target));
      lastStdout = "";
      continue;
    }
    if (cmd === "ls") {
      const target = rest.filter((t) => t !== "-a" && t !== "-l" && t !== "-la" && t !== "-al").pop();
      const normalized = target ? fakePosixNormalize(target) : ".";
      const exists = fs.dirs.has(normalized) || [...fs.files.keys()].some((f) => f.startsWith(`${normalized}/`));
      if (!exists) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: `ls: cannot access '${target}': No such file or directory` };
      }
      const names = new Set<string>();
      for (const d of fs.dirs) {
        if (path.posix.dirname(d) === normalized) names.add(path.posix.basename(d));
      }
      for (const f of fs.files.keys()) {
        if (path.posix.dirname(f) === normalized) names.add(path.posix.basename(f));
      }
      lastStdout = [".", "..", ...names].join("\n");
      continue;
    }
    if (cmd === "test" && rest[0] === "-d") {
      const target = rest[1] ? fakePosixNormalize(rest[1]) : "";
      if (!fs.dirs.has(target)) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "" };
      }
      lastStdout = "";
      continue;
    }
    // Unrecognized command inside the script — fall back to the generic stub
    // rather than failing the whole chain (keeps this a minimal emulation).
    lastStdout = `fake: ${tokens.join(" ")}`.trim();
  }
  return { exitCode: 0, signal: null, timedOut: false, stdout: lastStdout, stderr: "" };
}

export function createFakeSandboxRuntimeProvider(): SandboxRuntimeProvider {
  const fs: FakeSandboxFs = { files: new Map(), dirs: new Set(["/", "."]) };

  return {
    provider: "fake",

    async acquireLease(input) {
      const remoteCwd = readString(input.config.remoteCwd) ?? "/workspace";
      const shellCommand = readString(input.config.shellCommand) === "bash" ? "bash" : "sh";
      const timeoutMs = readPositiveInteger(input.config.timeoutMs);
      fakeMarkDir(fs, remoteCwd);
      return {
        providerLeaseId: `fake-sandbox-${sanitizeProviderLeasePart(input.environmentId)}-${sanitizeProviderLeasePart(input.heartbeatRunId ?? "test")}`,
        metadata: {
          provider: "fake",
          remoteCwd,
          shellCommand,
          timeoutMs,
          workspaceMode: input.workspaceMode,
          // S4 — verbatim when provided; omitted (not `[]`) when absent, so
          // the pre-existing exact-shape metadata assertion in
          // sandbox-provider-runtime.test.ts keeps passing unchanged.
          ...(input.egressAllowlist !== undefined ? { egressAllowlist: input.egressAllowlist } : {}),
        },
      };
    },

    async releaseLease(input) {
      return {
        cleanupStatus: "success",
        metadata: {
          releasedProviderLeaseId: input.providerLeaseId,
        },
      };
    },

    // U7.4 — echoes resumed:true for any lease EXCEPT one whose persisted
    // metadata carries `__dead: true`, letting higher-level tests simulate a
    // GC'd/expired sandbox without a real provider round-trip.
    async resumeLease(input) {
      const resumed = input.leaseMetadata?.__dead !== true;
      return {
        resumed,
        providerLeaseId: input.providerLeaseId,
        metadata: { provider: "fake", resumed },
      };
    },

    async execute(input) {
      const args = input.args ?? [];
      if (input.command === "sh" && args[0] === "-c" && typeof args[1] === "string") {
        const result = runFakeShellScript(args[1], fs);
        return {
          ...result,
          metadata: {
            cwd: input.cwd ?? readString(input.leaseMetadata?.remoteCwd) ?? null,
            envKeys: Object.keys(input.env ?? {}).sort(),
            providerLeaseId: input.providerLeaseId,
          },
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `fake: ${[input.command, ...args].join(" ")}`.trim(),
        stderr: "",
        metadata: {
          cwd: input.cwd ?? readString(input.leaseMetadata?.remoteCwd) ?? null,
          envKeys: Object.keys(input.env ?? {}).sort(),
          providerLeaseId: input.providerLeaseId,
        },
      };
    },

    async writeFiles(input) {
      for (const file of input.files) {
        fakeWriteFile(fs, file.path, file.content);
      }
    },

    async readFiles(input) {
      return input.paths.map((p) => ({
        path: p,
        content: fs.files.get(fakePosixNormalize(p)) ?? Buffer.alloc(0),
      }));
    },

    async resolveHost(input) {
      return `${input.port}-fakesandbox.e2b.app`;
    },
  };
}

type E2bCommandResult = {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

type E2bSandbox = {
  sandboxId?: string;
  sandboxDomain?: string;
  commands: {
    run(command: string, options?: Record<string, unknown>): Promise<E2bCommandResult>;
  };
  files?: {
    // RW4 — real SDK signature is `write(path, data: string | ArrayBuffer |
    // Blob | ReadableStream)` (verified against
    // `node_modules/e2b/dist/index.d.ts:4251`). A raw Node `Buffer` is NOT
    // in that union — it is a `Uint8Array` view, not an `ArrayBuffer` — so
    // callers must convert (see `bufferToArrayBuffer` below) rather than
    // pass a `Buffer` straight through.
    write(path: string, content: string | ArrayBuffer): Promise<void>;
    remove(path: string): Promise<void>;
    // U6.2 — optional (not on the SDK surface before this wave; existing test
    // doubles that stub `files: { write, remove }` without `read` must stay
    // valid, so this is NOT a required member).
    //
    // RW4 — the real SDK overloads `read` on `opts.format` (verified against
    // `node_modules/e2b/dist/index.d.ts:4185`/`:4199`): no `format` (or
    // `format: "text"`) returns a UTF-8-**decoded string** (lossy for
    // non-UTF-8 bytes — every non-UTF-8 byte becomes U+FFFD and does not
    // round-trip); only `{ format: "bytes" }` returns the raw `Uint8Array`.
    // Modeled here as two call signatures so callers requesting bytes get a
    // `Uint8Array` back at the type level, not `Uint8Array | string`.
    read?: {
      (path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
      (path: string, opts?: { format?: "text" }): Promise<string>;
    };
  };
  // U6.2 — resolve a public host for a port exposed inside the sandbox
  // (real E2B SDK: `sandbox.getHost(port)`). Optional — absent on the SDK
  // surface used before this wave and on any provider that doesn't expose it.
  getHost?(port: number): Promise<string> | string;
  setTimeout?(timeoutMs: number): Promise<void>;
  kill?(): Promise<void>;
  pause?(): Promise<void>;
};

type E2bModule = {
  Sandbox: {
    create(template: string, options: Record<string, unknown>): Promise<E2bSandbox>;
    connect(providerLeaseId: string, options: Record<string, unknown>): Promise<E2bSandbox>;
  };
  CommandExitError?: new (...args: unknown[]) => Error;
  TimeoutError?: new (...args: unknown[]) => Error;
  SandboxNotFoundError?: new (...args: unknown[]) => Error;
};

interface E2bDriverConfig {
  template: string;
  apiKey: string | null;
  domain: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

export interface E2bSandboxRuntimeProviderOptions {
  importE2b?: () => Promise<E2bModule>;
  env?: Record<string, string | undefined>;
  randomId?: () => string;
}

function parseE2bDriverConfig(raw: Record<string, unknown>): E2bDriverConfig {
  const timeoutMs = readPositiveInteger(raw.timeoutMs) ?? 3_600_000;
  return {
    template: readString(raw.template) ?? "base",
    apiKey: readString(raw.resolvedApiKey) ?? readString(raw.apiKey),
    domain: readString(raw.domain),
    timeoutMs,
    reuseLease: raw.reuseLease === true,
  };
}

function sanitizedE2bConfig(config: E2bDriverConfig, env: Record<string, string | undefined>) {
  return {
    provider: "e2b",
    template: config.template,
    timeoutMs: config.timeoutMs,
    reuseLease: config.reuseLease,
    hasApiKey: Boolean(config.apiKey ?? readString(env.E2B_API_KEY)),
    selfHosted: Boolean(config.domain ?? readString(env.E2B_DOMAIN)),
  };
}

function validateE2bDriverConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
): SandboxProviderConfigValidationResult {
  const config = parseE2bDriverConfig(raw);
  const errors: string[] = [];
  if (config.timeoutMs < 1_000 || config.timeoutMs > 86_400_000) {
    errors.push("E2B timeoutMs must be between 1000 and 86400000.");
  }
  if (!config.apiKey && !readString(env.E2B_API_KEY)) {
    errors.push("E2B sandbox environments require an API key in config or E2B_API_KEY.");
  }
  return {
    ok: errors.length === 0,
    provider: "e2b",
    ...(errors.length > 0 ? { errors } : {}),
    sanitizedConfig: sanitizedE2bConfig(config, env),
  };
}

function resolveE2bApiKey(config: E2bDriverConfig, env: Record<string, string | undefined>): string {
  const apiKey = config.apiKey ?? readString(env.E2B_API_KEY);
  if (!apiKey) {
    throw new Error("E2B sandbox environments require an API key in config or E2B_API_KEY.");
  }
  return apiKey;
}

function resolveE2bDomain(config: E2bDriverConfig, env: Record<string, string | undefined>): string | null {
  return config.domain ?? readString(env.E2B_DOMAIN);
}

function e2bDomainOption(domain: string | null): { domain: string } | Record<string, never> {
  return domain ? { domain } : {};
}

function defaultImportE2b(): Promise<E2bModule> {
  return import("e2b") as Promise<E2bModule>;
}

async function resolveE2bWorkingDirectory(sandbox: E2bSandbox): Promise<string> {
  const result = await sandbox.commands.run("pwd");
  const cwd = typeof result.stdout === "string" && result.stdout.trim().length > 0
    ? result.stdout.trim()
    : "/";
  const remoteCwd = path.posix.join(cwd, "aoa-workspace");
  await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`);
  return remoteCwd;
}

function buildE2bLeaseMetadata(input: {
  config: E2bDriverConfig;
  sandbox: E2bSandbox;
  remoteCwd: string;
  workspaceMode: string | null;
  resolvedDomain: string | null;
  /** S4 — verbatim when provided; omitted (not `[]`) when absent so the
   *  pre-existing exact-shape `toEqual(lease)` assertions in
   *  sandbox-provider-runtime.test.ts keep passing unchanged. */
  egressAllowlist?: string[];
}) {
  return {
    provider: "e2b",
    template: input.config.template,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    sandboxId: input.sandbox.sandboxId ?? null,
    sandboxDomain: input.sandbox.sandboxDomain ?? null,
    remoteCwd: input.remoteCwd,
    shellCommand: "bash",
    workspaceMode: input.workspaceMode,
    ...(input.resolvedDomain ? { domain: input.resolvedDomain } : {}),
    ...(input.egressAllowlist !== undefined ? { egressAllowlist: input.egressAllowlist } : {}),
  };
}

function buildE2bLoginShellScript(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }

  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const preExecCommands: string[] = [];
  const codexHome = readString(env.CODEX_HOME);
  if (codexHome) {
    preExecCommands.push(`mkdir -p ${shellQuote(codexHome)}`);
  }
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  return [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    ...preExecCommands,
    execLine,
  ].join(" && ");
}

function configFromE2bLease(input: {
  leaseMetadata: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  env: Record<string, string | undefined>;
}): E2bDriverConfig {
  const metadata = input.leaseMetadata ?? {};
  const config = input.config ?? {};
  return parseE2bDriverConfig({
    provider: "e2b",
    template: config.template ?? metadata.template,
    timeoutMs: config.timeoutMs ?? metadata.timeoutMs,
    reuseLease: config.reuseLease ?? metadata.reuseLease,
    resolvedApiKey: config.resolvedApiKey,
    apiKey: config.apiKey,
    domain: config.domain ?? metadata.domain,
  });
}

function isInstanceOf(error: unknown, ctor: unknown): boolean {
  return typeof ctor === "function" && error instanceof ctor;
}

/**
 * RW4 — converts a Node `Buffer` to the exact `ArrayBuffer` slice backing
 * it. NOT simply `buffer.buffer`: Node pools small allocations, so a
 * `Buffer`'s underlying `ArrayBuffer` is frequently larger than (and offset
 * from) the buffer's own bytes — passing `buffer.buffer` directly would ship
 * neighboring pooled bytes (or the wrong bytes entirely) to the sandbox.
 * `.slice(byteOffset, byteOffset + byteLength)` copies out exactly this
 * buffer's own bytes.
 */
function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function readErrorStream(error: unknown, key: "stdout" | "stderr"): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const direct = record[key];
  if (typeof direct === "string") return direct;
  const nested = record.result && typeof record.result === "object"
    ? (record.result as Record<string, unknown>)[key]
    : null;
  return typeof nested === "string" ? nested : "";
}

export function createE2bSandboxRuntimeProvider(
  options: E2bSandboxRuntimeProviderOptions = {},
): SandboxRuntimeProvider {
  const importE2b = options.importE2b ?? defaultImportE2b;
  const env = options.env ?? process.env;
  const randomId = options.randomId ?? randomUUID;

  async function connect(config: E2bDriverConfig, providerLeaseId: string): Promise<E2bSandbox> {
    const e2b = await importE2b();
    return await e2b.Sandbox.connect(providerLeaseId, {
      apiKey: resolveE2bApiKey(config, env),
      timeoutMs: config.timeoutMs,
      ...e2bDomainOption(resolveE2bDomain(config, env)),
    });
  }

  return {
    provider: "e2b",

    async validateConfig(config) {
      return validateE2bDriverConfig(config, env);
    },

    async probe(input) {
      const validation = validateE2bDriverConfig(input.config, env);
      if (!validation.ok) {
        return {
          ok: false,
          provider: "e2b",
          summary: "E2B sandbox configuration is invalid.",
          errors: validation.errors,
          metadata: validation.sanitizedConfig,
        };
      }

      const config = parseE2bDriverConfig(input.config);
      const e2b = await importE2b();
      const sandbox = await e2b.Sandbox.create(config.template, {
        apiKey: resolveE2bApiKey(config, env),
        timeoutMs: config.timeoutMs,
        ...e2bDomainOption(resolveE2bDomain(config, env)),
        metadata: {
          aoaProvider: "e2b",
          companyId: input.companyId,
          environmentId: input.environmentId,
        },
      });

      try {
        await sandbox.setTimeout?.(config.timeoutMs);
        const remoteCwd = await resolveE2bWorkingDirectory(sandbox);
        return {
          ok: true,
          provider: "e2b",
          summary: "E2B sandbox created and workspace directory prepared.",
          metadata: {
            template: config.template,
            timeoutMs: config.timeoutMs,
            sandboxId: sandbox.sandboxId ?? null,
            sandboxDomain: sandbox.sandboxDomain ?? null,
            remoteCwd,
          },
        };
      } finally {
        await sandbox.kill?.().catch(() => undefined);
      }
    },

    async acquireLease(input) {
      const config = parseE2bDriverConfig(input.config);
      const resolvedDomain = resolveE2bDomain(config, env);
      const e2b = await importE2b();
      const sandbox = await e2b.Sandbox.create(config.template, {
        apiKey: resolveE2bApiKey(config, env),
        timeoutMs: config.timeoutMs,
        ...e2bDomainOption(resolvedDomain),
        metadata: {
          aoaProvider: "e2b",
          companyId: input.companyId,
          environmentId: input.environmentId,
          // S4 — best-effort managed recording only (§11/§12: managed E2B
          // egress is not fully lockable). Omitted entirely when no
          // allowlist was supplied, so the pre-existing exact `create(...)`
          // call assertions in sandbox-provider-runtime.test.ts stay green.
          ...(input.egressAllowlist && input.egressAllowlist.length > 0
            ? { egressAllowlist: input.egressAllowlist.join(",") }
            : {}),
        },
      });

      try {
        await sandbox.setTimeout?.(config.timeoutMs);
        const remoteCwd = await resolveE2bWorkingDirectory(sandbox);
        return {
          providerLeaseId: sandbox.sandboxId ?? "",
          metadata: buildE2bLeaseMetadata({
            config,
            sandbox,
            remoteCwd,
            workspaceMode: input.workspaceMode,
            resolvedDomain,
            egressAllowlist: input.egressAllowlist,
          }),
        };
      } catch (error) {
        await sandbox.kill?.().catch(() => undefined);
        throw error;
      }
    },

    async releaseLease(input) {
      if (!input.providerLeaseId) {
        return { cleanupStatus: "success", metadata: { skipped: "missing_provider_lease_id" } };
      }
      const config = configFromE2bLease({
        leaseMetadata: input.leaseMetadata,
        config: input.config,
        env,
      });
      try {
        const sandbox = await connect(config, input.providerLeaseId);
        if (config.reuseLease) {
          await sandbox.pause?.();
        } else {
          await sandbox.kill?.();
        }
        return { cleanupStatus: "success" };
      } catch (error) {
        const e2b = await importE2b();
        if (isInstanceOf(error, e2b.SandboxNotFoundError)) {
          return { cleanupStatus: "success", metadata: { alreadyGone: true } };
        }
        return {
          cleanupStatus: "failed",
          metadata: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },

    // U7.4 — warm resume. `Sandbox.connect` auto-resumes a paused E2B
    // snapshot (same reconnect pattern as `execute`/`releaseLease` above).
    // A dead/GC'd sandbox (SandboxNotFoundError — or ANY other connect
    // failure, per spec §8 "never error the run") resolves
    // `{ resumed: false, metadata: { deadOnResume: true } }` rather than
    // rejecting, so callers can transparently fall back to create-fresh.
    async resumeLease(input) {
      const config = configFromE2bLease({
        leaseMetadata: input.leaseMetadata,
        config: input.config,
        env,
      });
      try {
        const sandbox = await connect(config, input.providerLeaseId);
        await sandbox.setTimeout?.(config.timeoutMs);
        const resolvedDomain = resolveE2bDomain(config, env);
        return {
          resumed: true,
          providerLeaseId: input.providerLeaseId,
          metadata: buildE2bLeaseMetadata({
            config,
            sandbox,
            remoteCwd: readString(input.leaseMetadata?.remoteCwd) ?? "/home/user/aoa-workspace",
            workspaceMode: readString(input.leaseMetadata?.workspaceMode),
            resolvedDomain,
            egressAllowlist: Array.isArray(input.leaseMetadata?.egressAllowlist)
              ? (input.leaseMetadata!.egressAllowlist as string[])
              : undefined,
          }),
        };
      } catch (error) {
        // §8 "never error the run" — a dead/GC'd sandbox (SandboxNotFoundError)
        // OR any other connect failure signals create-fresh, it never rejects.
        logger.warn(
          { err: error, providerLeaseId: input.providerLeaseId },
          "sandbox-provider-runtime: E2B resumeLease found a dead/unresumable sandbox; signaling create-fresh",
        );
        return {
          resumed: false,
          providerLeaseId: input.providerLeaseId,
          metadata: { deadOnResume: true },
        };
      }
    },

    async execute(input) {
      const config = configFromE2bLease({
        leaseMetadata: input.leaseMetadata,
        config: input.config,
        env,
      });
      const e2b = await importE2b();
      const sandbox = await connect(config, input.providerLeaseId);
      await sandbox.setTimeout?.(config.timeoutMs).catch(() => undefined);

      let stagedStdinPath: string | null = null;
      let stagedFilePath: string | null = null;
      const baseCommand = buildE2bLoginShellScript({
        command: input.command,
        args: input.args ?? [],
        env: input.env,
      });
      let command = baseCommand;
      if (input.stagedFile) {
        // U13.5 — file-import: the CALLER (one-shot-sandbox-cli.ts) supplies
        // a persistent, meaningful remote path (unlike the auto-generated
        // `aoa-stdin-*` path below) and its content. Written into the VM
        // BEFORE the command runs — the same `sandbox.files.write`
        // mechanism `stdin` already uses internally — then redirected into
        // the CLI's stdin. Neither claude nor codex has a "read prompt
        // content from an arbitrary file path" CLI flag (verified against
        // `claude --help` / `codex exec --help`: the only file-path flags
        // are claude's `--system-prompt-file`, SYSTEM channel only, and
        // codex's `-i/--image`, images only) — both DO read piped stdin, so
        // that remains the real delivery mechanism; only the SOURCE changes
        // from an anonymous in-memory string to a named staged file.
        if (!sandbox.files) throw new Error("E2B sandbox file API is required to stage a file.");
        stagedFilePath = input.stagedFile.remotePath;
        await sandbox.files.write(stagedFilePath, input.stagedFile.content);
        command = `${baseCommand} < ${shellQuote(stagedFilePath)}`;
      } else if (input.stdin != null) {
        if (!sandbox.files) throw new Error("E2B sandbox file API is required to pass stdin.");
        stagedStdinPath = `/tmp/aoa-stdin-${sanitizeProviderLeasePart(randomId())}`;
        await sandbox.files.write(stagedStdinPath, input.stdin);
        command = `${baseCommand} < ${shellQuote(stagedStdinPath)}`;
      }

      try {
        const result = await sandbox.commands.run(command, {
          cwd: input.cwd ?? readString(input.leaseMetadata?.remoteCwd) ?? undefined,
          timeoutMs: input.timeoutMs ?? config.timeoutMs,
          // U7.5b — forward incremental stdout/stderr to the caller's callbacks
          // (E2B `commands.run` `onStdout`/`onStderr`, real SDK shape
          // `(data: string) => void`). Keys stay UNSET when the callbacks are
          // absent so the options object is byte-identical to the buffered-only
          // path (org/crew today). The buffered `result` below is unchanged and
          // remains the source of truth for cost/usage accounting.
          ...(input.onStdout ? { onStdout: input.onStdout } : {}),
          ...(input.onStderr ? { onStderr: input.onStderr } : {}),
        });
        return {
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
          signal: null,
          timedOut: false,
          stdout: typeof result.stdout === "string" ? result.stdout : "",
          stderr: typeof result.stderr === "string" ? result.stderr : "",
        };
      } catch (error) {
        if (isInstanceOf(error, e2b.CommandExitError)) {
          const record = error as unknown as Record<string, unknown>;
          return {
            exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
            signal: null,
            timedOut: false,
            stdout: readErrorStream(error, "stdout"),
            stderr: readErrorStream(error, "stderr"),
          };
        }
        if (isInstanceOf(error, e2b.TimeoutError)) {
          return {
            exitCode: null,
            signal: null,
            timedOut: true,
            stdout: readErrorStream(error, "stdout"),
            stderr: readErrorStream(error, "stderr") || (error instanceof Error ? error.message : String(error)),
          };
        }
        throw error;
      } finally {
        if (stagedStdinPath && sandbox.files) {
          await sandbox.files.remove(stagedStdinPath).catch(() => undefined);
        }
        if (stagedFilePath && sandbox.files) {
          await sandbox.files.remove(stagedFilePath).catch(() => undefined);
        }
      }
    },

    // U6.2 — file-movement seam. Same reconnect pattern as `execute()` above
    // (connect() to the already-created sandbox by providerLeaseId, do not
    // re-`Sandbox.create`).
    async writeFiles(input) {
      const config = configFromE2bLease({ leaseMetadata: input.leaseMetadata, config: input.config, env });
      const sandbox = await connect(config, input.providerLeaseId);
      if (!sandbox.files) throw new Error("E2B sandbox file API is required to write files.");
      for (const file of input.files) {
        // RW4 — the real SDK's `write` accepts `string | ArrayBuffer | Blob
        // | ReadableStream`, NOT a Node `Buffer` (verified against
        // `node_modules/e2b/dist/index.d.ts:4251`). Convert via
        // `bufferToArrayBuffer` (not `file.content.buffer`) so binary
        // content round-trips regardless of Node's buffer-pooling.
        await sandbox.files.write(file.path, bufferToArrayBuffer(file.content));
      }
    },

    async readFiles(input) {
      const config = configFromE2bLease({ leaseMetadata: input.leaseMetadata, config: input.config, env });
      const sandbox = await connect(config, input.providerLeaseId);
      if (!sandbox.files?.read) throw new Error("E2B sandbox file API is required to read files.");
      const results: Array<{ path: string; content: Buffer }> = [];
      for (const filePath of input.paths) {
        // RW4 — MUST request `{ format: "bytes" }`. The real SDK defaults to
        // `format: "text"`, which UTF-8-decodes the response server-side —
        // lossy (U+FFFD) for any non-UTF-8 byte, e.g. a PNG's `0x89` lead
        // byte — and does not round-trip. Only `{ format: "bytes" }` returns
        // the raw `Uint8Array` (verified against
        // `node_modules/e2b/dist/index.d.ts:4185`/`:4199`).
        const raw = await sandbox.files.read(filePath, { format: "bytes" });
        results.push({
          path: filePath,
          content: Buffer.from(raw),
        });
      }
      return results;
    },

    async resolveHost(input) {
      const config = configFromE2bLease({ leaseMetadata: input.leaseMetadata, config: input.config, env });
      const sandbox = await connect(config, input.providerLeaseId);
      if (typeof sandbox.getHost !== "function") {
        throw new Error("E2B sandbox does not support host resolution (getHost).");
      }
      return await sandbox.getHost(input.port);
    },
  };
}

export function sandboxProviderRuntime(
  options: {
    providers?: SandboxRuntimeProvider[];
  } = {},
) {
  const providers = new Map<string, SandboxRuntimeProvider>();
  for (const provider of options.providers ?? [
    createFakeSandboxRuntimeProvider(),
    createE2bSandboxRuntimeProvider(),
    createGvisorSandboxRuntimeProvider(),
  ]) {
    providers.set(provider.provider, provider);
  }

  function getProvider(providerKey: string): SandboxRuntimeProvider | null {
    return providers.get(providerKey) ?? null;
  }

  function requireProvider(providerKey: string): SandboxRuntimeProvider {
    const provider = getProvider(providerKey);
    if (!provider) {
      throw new Error(`Unsupported sandbox provider "${providerKey}"`);
    }
    return provider;
  }

  return {
    getProvider,

    acquireLease(providerKey: string, input: SandboxProviderAcquireInput) {
      return requireProvider(providerKey).acquireLease(input);
    },

    releaseLease(providerKey: string, input: SandboxProviderReleaseInput) {
      return requireProvider(providerKey).releaseLease(input);
    },

    // U7.4 — mirrors releaseLease's passthrough; guarded (like writeFiles/
    // readFiles/resolveHost below) so a provider without warm-resume support
    // fails with a clear message rather than silently no-oping.
    resumeLease(providerKey: string, input: SandboxProviderResumeInput): Promise<SandboxProviderResumeResult> {
      const provider = requireProvider(providerKey);
      if (typeof provider.resumeLease !== "function") {
        throw new Error(`Sandbox provider "${providerKey}" does not support resume.`);
      }
      return provider.resumeLease(input);
    },

    execute(providerKey: string, input: SandboxProviderExecuteInput) {
      return requireProvider(providerKey).execute(input);
    },

    writeFiles(providerKey: string, input: SandboxProviderWriteFilesInput): Promise<void> {
      const provider = requireProvider(providerKey);
      if (typeof provider.writeFiles !== "function") {
        throw new Error(`Sandbox provider "${providerKey}" does not support file writes.`);
      }
      return provider.writeFiles(input);
    },

    readFiles(providerKey: string, input: SandboxProviderReadFilesInput): Promise<Array<{ path: string; content: Buffer }>> {
      const provider = requireProvider(providerKey);
      if (typeof provider.readFiles !== "function") {
        throw new Error(`Sandbox provider "${providerKey}" does not support file reads.`);
      }
      return provider.readFiles(input);
    },

    resolveHost(providerKey: string, input: SandboxProviderResolveHostInput): Promise<string> {
      const provider = requireProvider(providerKey);
      if (typeof provider.resolveHost !== "function") {
        throw new Error(`Sandbox provider "${providerKey}" does not support host resolution.`);
      }
      return provider.resolveHost(input);
    },

    validateConfig(providerKey: string, config: Record<string, unknown>): Promise<SandboxProviderConfigValidationResult> {
      const provider = requireProvider(providerKey);
      return provider.validateConfig?.(config) ?? Promise.resolve({
        ok: true,
        provider: providerKey,
        sanitizedConfig: { provider: providerKey },
      });
    },

    probe(providerKey: string, input: SandboxProviderProbeInput): Promise<SandboxProviderProbeResult> {
      const provider = requireProvider(providerKey);
      return provider.probe?.(input) ?? Promise.resolve({
        ok: true,
        provider: providerKey,
        summary: `${providerKey} sandbox provider is registered.`,
      });
    },
  };
}

export type SandboxProviderRuntime = ReturnType<typeof sandboxProviderRuntime>;
