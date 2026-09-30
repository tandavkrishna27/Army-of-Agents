// packages/worker-daemon/src/bin/container-host.ts
//
// WRK-014 — the CONTAINER composition host (§2, seam (a)).
//
// The analogue of `runDesktopHost` for a `file_record` container: a host that
// constructs custody and injects it into the pure `bootstrapWorkerDaemon` sink.
// It lives INSIDE `worker-daemon` — not a sibling package like the desktop host —
// because the file-backed store carries no confined capability: only `node:fs` +
// `node:crypto`, which the daemon's two-dependency boundary already allows
// (Pivot 2). The daemon stays a pure sink; this file is the only place that reads
// `AOA_WORKER_STATE_DIR` and builds the stores. It is deliberately simpler than
// the desktop host: a container has no control subcommands and — by design — no
// `--reset-identity`, so a bad identity crash-loops loudly rather than silently
// re-minting one the server will deny forever (§4).
//
// ★ LANDS INERT (WRK-014). The image CMD still runs `worker-daemon.js`; nothing
// switches a deployed worker to `file_record` or to this host. WRK-015 Part 1
// landed the POSIX enrolment-input fix, so `assertLocalAbsolutePath` no longer
// rejects a container's `/worker/...` ticket path — the validator-level crash-loop
// hazard is gone. WIRING the container path on d1 (a compose `command:` override
// on ONE worker + a CI-exercised first-enrol proof — NOT an image-CMD repoint,
// which would crash-loop every still-`mounted_secret` container because this host
// injects stores unconditionally and `resolveCustody("mounted_secret", stores)`
// refuses) is deferred to WRK-017 (WRK-015 Part 2 split; d1 harness has no worker-
// enrol flow). Until then the tests drive `runContainerHost` + `file_record` directly.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { bootstrapWorkerDaemon, type ProcessLike } from "./worker-daemon.js";
import { FileRecordStore } from "../identity/file-record-store.js";
import { identityRecordCodec, receiptRecordCodec } from "../identity/record-codec.js";
import type { SandboxProvider } from "../supervisor/provider.js";

export type { ProcessLike };

/** Read DIRECTLY from the env — never via `loadWorkerConfig`, which runs AFTER
 * the host has already built the stores, so a config field would have no consumer
 * under this seam (review F4; a `config.stateDir` was explicitly rejected). */
export const STATE_DIR_ENV = "AOA_WORKER_STATE_DIR";
export const DEFAULT_STATE_DIR = "/worker";
export const IDENTITY_RECORD_FILE = "identity.json";
export const RECEIPT_RECORD_FILE = "receipt.json";

/** The device identity + receipt live in this directory, which MUST be a durable
 * named volume for the singleton canary worker (§4). Whitespace/empty ⇒ default. */
export function resolveStateDir(env: Record<string, string | undefined>): string {
  const raw = env[STATE_DIR_ENV]?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_STATE_DIR;
}

export type StateDirCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

/**
 * A boot-time, fail-closed writability probe (§4).
 *
 * A recreated container that lost its `DeviceIdentityRecord` re-mints a workerId,
 * which the server denies as `worker_transfer_denied` forever — and there is no
 * container reset. So a state dir the stores cannot write must be a LOUD exit
 * here, before any socket, never a silent degrade that ends in a re-mint.
 */
export function assertStateDirWritable(dir: string): StateDirCheck {
  let probe: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    probe = join(dir, `.write-probe-${randomUUID()}`);
    writeFileSync(probe, "", { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    // The errno CODE only (EACCES/EROFS/ENOSPC/…). Content-free; the dir name is
    // a config value, not a secret, so the CALLER may name it in the log.
    return { ok: false, reason: isErrno(err) && err.code ? err.code : "unknown" };
  } finally {
    if (probe !== undefined) {
      try { rmSync(probe, { force: true }); } catch { /* an orphaned probe is harmless */ }
    }
  }
}

export interface ContainerHostDeps {
  readonly env: Record<string, string | undefined>;
  readonly proc: ProcessLike;
  readonly bootstrap?: typeof bootstrapWorkerDaemon;
  readonly log?: (message: string) => void;
  /**
   * DEP-010 — ABSENT for the shipped container (E4-D01: the daemon image cannot
   * carry a provider package, so it cannot construct one). Present only for an
   * embedder or a test; dispatch stays off by the flag regardless.
   */
  readonly provider?: SandboxProvider;
  /** Injected for tests; the default is a real probe write in the state dir. */
  readonly assertStateDirWritable?: (dir: string) => StateDirCheck;
}

export async function runContainerHost(deps: ContainerHostDeps): Promise<{ ok: boolean }> {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const bootstrap = deps.bootstrap ?? bootstrapWorkerDaemon;
  const stateDir = resolveStateDir(deps.env);

  // FAIL CLOSED BEFORE ANY SOCKET. The custody VERDICT is pre-socket inside
  // bootstrap already (I11); this catches the other half — a state dir the stores
  // cannot write — before the health listener ever binds, so an operator learns
  // at boot rather than from a worker that reports UP and then cannot persist.
  const check = (deps.assertStateDirWritable ?? assertStateDirWritable)(stateDir);
  if (!check.ok) {
    log(`container host: state dir ${JSON.stringify(stateDir)} is not writable (${check.reason}); refusing to start`);
    deps.proc.exit(1);
    return { ok: false };
  }

  const identityStore = new FileRecordStore({
    path: join(stateDir, IDENTITY_RECORD_FILE),
    codec: identityRecordCodec,
  });
  const receiptStore = new FileRecordStore({
    path: join(stateDir, RECEIPT_RECORD_FILE),
    codec: receiptRecordCodec,
  });

  const result = await bootstrap({
    env: deps.env,
    proc: deps.proc,
    identityStore,
    receiptStore,
    // Undefined for the shipped container; the daemon then refuses to compose
    // dispatch (`no_provider`) exactly as the desktop default does.
    provider: deps.provider,
  });
  return { ok: result.ok };
}

/**
 * Mask anything shaped like an enrolment code — the container host's last line of
 * defence (mirrors `aoa-worker-desktop.ts`). The daemon logger's redactor covers
 * the normal paths; this guards the ONE path that bypasses it, the entry guard's
 * `console.error(err.stack)` below, because this host is the one that reads an
 * enrolment ticket. The pattern mirrors the server's own regex and the client
 * mirror in `enrollment/ticket.ts`, so it matches exactly a real credential.
 */
export function redactEnrollmentCodes(text: string): string {
  return text.replace(/aoa_enr_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}/g, "aoa_enr_[redacted]");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runContainerHost({ env: process.env, proc: process })
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error && err.stack ? err.stack : String(err);
      console.error(redactEnrollmentCodes(detail));
      process.exit(1);
    });
}
