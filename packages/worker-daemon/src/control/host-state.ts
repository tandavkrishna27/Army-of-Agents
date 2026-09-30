/**
 * The host state record (DSK-003 Lane A) — how a control command finds the running host,
 * and why a pid alone is never enough to act on.
 *
 * THE STALE-PID PROBLEM IS THE REASON THIS IS NOT JUST A PID FILE. A host that crashed
 * leaves its pid behind; the OS recycles that pid for something else; `drain` then signals
 * a stranger's process. On a desktop that stranger is the user's own editor, and the
 * failure is silent — the signal succeeds.
 *
 * So the record carries an `instanceId`, a random per-boot nonce, and
 * {@link resolveTargetProcess} requires the LIVE host to report the same one before it
 * hands back a pid. The recorded pid is a hint; the instance match is the authority.
 *
 * THE RECORD HOLDS NO SECRET AND NO DEVICE IDENTITY. It sits on disk for the life of the
 * process, and the file that tells you where the host is must not also tell you how to
 * control it or which device it is. `HOST_STATE_KEYS` is an exhaustive allowlist and
 * `buildHostStateRecord` constructs by NAMING each field — never by spreading — so a
 * future field is invisible here until someone writes it in. Same shape as DSK-002 Lane
 * D's projection, for the same reason.
 *
 * Custody matches the control token: a state file any local user can read tells every
 * local process exactly which pid to signal and which port to talk to.
 *
 * Runtime imports: `node:fs` — the E4-D01 boundary.
 */

import { readFileSync } from "node:fs";

import { ownerOnlyViolation, type OwnerOnlyDeps } from "../identity/file-custody.js";

/**
 * Every field the record may carry. Deliberately short, and deliberately free of
 * `workerId` / `targetId` / any key material: an operator needs to find and address the
 * host, not to learn what it is.
 */
export const HOST_STATE_KEYS = [
  "instanceId",
  "pid",
  "healthPort",
  "startedAt",
  "version",
] as const;

export type HostStateKey = (typeof HOST_STATE_KEYS)[number];

export interface HostStateRecord {
  /** A random per-boot nonce. The stale-pid defence turns on this and nothing else. */
  readonly instanceId: string;
  readonly pid: number;
  readonly healthPort: number;
  readonly startedAt: string;
  readonly version: string;
}

const KEY_SET: ReadonlySet<string> = new Set(HOST_STATE_KEYS);

/**
 * Build the record by NAMING each field.
 *
 * Never by spreading and deleting: a spread inherits every future field by default and
 * relies on someone remembering to remove it, which is exactly how a credential ends up
 * in a file nobody thought of as sensitive.
 */
export function buildHostStateRecord(input: HostStateRecord): HostStateRecord {
  return {
    instanceId: input.instanceId,
    pid: input.pid,
    healthPort: input.healthPort,
    startedAt: input.startedAt,
    version: input.version,
  };
}

/** Keys of `record` that are NOT allowlisted — every one is a disclosure. */
export function hostStateLeakKeys(record: HostStateRecord): string[] {
  return Object.keys(record).filter((key) => !KEY_SET.has(key));
}

export const HOST_STATE_REJECTIONS = [
  "no_record",
  "insecure_permissions",
  "malformed_record",
] as const;
export type HostStateRejection = (typeof HOST_STATE_REJECTIONS)[number];

export type HostStateResult =
  | { readonly ok: true; readonly record: HostStateRecord }
  | { readonly ok: false; readonly reason: HostStateRejection };

function isUsablePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Read and validate the record. Fails closed on every path.
 *
 * Custody is checked BEFORE the read, matching `control-token.ts`: do not pull a file's
 * contents into the process before its permissions have been validated.
 */
export function readHostState(statePath: string, deps: OwnerOnlyDeps = {}): HostStateResult {
  if (ownerOnlyViolation(statePath, deps) === "insecure_permissions") {
    return { ok: false, reason: "insecure_permissions" };
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return { ok: false, reason: "no_record" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed_record" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed_record" };
  }

  const row = parsed as Record<string, unknown>;
  if (typeof row.instanceId !== "string" || row.instanceId.length === 0) {
    return { ok: false, reason: "malformed_record" };
  }
  if (!isUsablePid(row.pid)) return { ok: false, reason: "malformed_record" };
  if (!isUsablePid(row.healthPort)) return { ok: false, reason: "malformed_record" };
  if (typeof row.startedAt !== "string" || row.startedAt.length === 0) {
    return { ok: false, reason: "malformed_record" };
  }
  if (typeof row.version !== "string" || row.version.length === 0) {
    return { ok: false, reason: "malformed_record" };
  }

  return {
    ok: true,
    record: buildHostStateRecord({
      instanceId: row.instanceId,
      pid: row.pid,
      healthPort: row.healthPort,
      startedAt: row.startedAt,
      version: row.version,
    }),
  };
}

export const TARGET_PROCESS_REJECTIONS = [
  ...HOST_STATE_REJECTIONS,
  "host_not_responding",
  "instance_mismatch",
] as const;
export type TargetProcessRejection = (typeof TARGET_PROCESS_REJECTIONS)[number];

export type TargetProcessResult =
  | { readonly ok: true; readonly pid: number }
  | { readonly ok: false; readonly reason: TargetProcessRejection };

export interface TargetProcessDeps extends OwnerOnlyDeps {
  /** Ask the loopback health surface which instance is listening on `port`. */
  readonly probe: (port: number) => Promise<{ instanceId?: string }>;
}

/**
 * Resolve the pid a control command may signal — or refuse.
 *
 * THE RECORDED PID IS A HINT; THE INSTANCE MATCH IS THE AUTHORITY. A record can be
 * perfectly well formed, correctly permissioned, and point at a live process that is not
 * ours, because the pid was recycled after a crash. Only a live host reporting the same
 * `instanceId` authorizes a signal.
 *
 * The probe is not reached at all when the record is unusable, so a corrupt file cannot
 * turn a refusal into a port scan.
 */
export async function resolveTargetProcess(
  statePath: string,
  deps: TargetProcessDeps,
): Promise<TargetProcessResult> {
  const state = readHostState(statePath, deps);
  if (!state.ok) return { ok: false, reason: state.reason };

  let live: { instanceId?: string };
  try {
    live = await deps.probe(state.record.healthPort);
  } catch {
    return { ok: false, reason: "host_not_responding" };
  }

  if (live?.instanceId !== state.record.instanceId) {
    return { ok: false, reason: "instance_mismatch" };
  }
  return { ok: true, pid: state.record.pid };
}
