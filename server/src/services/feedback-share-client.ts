import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { stableStringify } from "./feedback-redaction.js";
import {
  ENDPOINT_ENV,
  isTransmissionEnabled,
  transmitFeedbackBundle,
} from "./feedback-transmission.js";
import { logger } from "../middleware/logger.js";

const gzipAsync = promisify(gzip);

// AoA's home-dir convention is `~/.aoa/` (see cli/src/config/home.ts's
// `resolveAoaHomeDir` + docs/deploy/*). F.3 initially used `~/.aoa/`; F.4
// migrates this to `~/.aoa/feedback-exports/` for convention parity so
// operators don't have to know a second home dir for a sibling subsystem.
export const FEEDBACK_LOCAL_EXPORT_DIR_NAME = path.join(".aoa", "feedback-exports");

// Minimal shape the share client actually touches. Keeping this a structural
// type (not imported from the bundles service) avoids a cycle and lets the
// future HTTP transmission client reuse the same signature.
export interface ShareableBundle {
  id: string;
  createdAt?: Date | string | null;
  [key: string]: unknown;
}

export interface WriteBundleResult {
  path: string;
  size: number;
}

function resolveCreatedAtStamp(createdAt: Date | string | null | undefined): string {
  let iso: string;
  if (createdAt instanceof Date) iso = createdAt.toISOString();
  else if (typeof createdAt === "string" && createdAt.length > 0) iso = createdAt;
  else iso = new Date().toISOString();
  // Windows NTFS filenames can't contain `:` — `10:30:00` in an ISO stamp
  // would reject at write time. Colons → hyphens; trailing Z preserved.
  return iso.replace(/:/g, "-");
}

// Writes the bundle as gzipped stableStringified JSON under
// ~/.aoa/feedback-exports/. Filename = <bundle.id>-<createdAt stamp>.json.gz.
// stableStringify ensures byte-identical output across runs (deterministic
// field ordering — lets ops diff historical bundles + lets future dedupe logic
// hash contents without re-serializing).
//
// This remains the durable local path. `shareFeedbackBundle` (below) wraps it
// with env-based HTTP transmission (Phase I.2 Task 11 / PF.1): if
// AOA_FEEDBACK_ENDPOINT is set, transmission is tried first and local is used
// as a fallback. Unset → local-only (this function is the whole path).
export async function writeBundleLocally(bundle: ShareableBundle): Promise<WriteBundleResult> {
  const dir = path.join(os.homedir(), FEEDBACK_LOCAL_EXPORT_DIR_NAME);
  await mkdir(dir, { recursive: true });

  const stamp = resolveCreatedAtStamp(bundle.createdAt);
  const filename = `${bundle.id}-${stamp}.json.gz`;
  const filePath = path.join(dir, filename);

  const payload = stableStringify(bundle);
  const gzipped = await gzipAsync(Buffer.from(payload, "utf8"));

  await writeFile(filePath, gzipped);
  return { path: filePath, size: gzipped.length };
}

export type ShareFeedbackResult =
  | { delivered: "transmitted"; endpoint: string; status: number }
  | {
      delivered: "local";
      path: string;
      size: number;
      transmissionFailure?: { status?: number; error?: string };
    };

/**
 * Resolves F.D1 (feedback transmission destination). Behavioural contract:
 *
 *  - `AOA_FEEDBACK_ENDPOINT` unset → local-only (calls `writeBundleLocally`).
 *  - Endpoint set + POST succeeds → no local write; returns `"transmitted"`.
 *    Operators who want a local audit trail should tee it on their side.
 *  - Endpoint set + POST fails → falls back to `writeBundleLocally` and
 *    annotates the result with `transmissionFailure` so callers can surface
 *    the failure in admin UI. Votes are never lost on a transient outage.
 *
 * Redaction is expected to have already run — callers pass an already-built
 * bundle whose payloadSnapshot went through `feedback-redaction.ts`.
 */
export async function shareFeedbackBundle(bundle: ShareableBundle): Promise<ShareFeedbackResult> {
  if (isTransmissionEnabled()) {
    const result = await transmitFeedbackBundle(bundle);
    if (result.ok) {
      return {
        delivered: "transmitted",
        endpoint: process.env[ENDPOINT_ENV] ?? "",
        status: result.status ?? 0,
      };
    }
    const local = await writeBundleLocally(bundle);
    logger.warn(
      { status: result.status, error: result.error, endpoint: process.env[ENDPOINT_ENV] },
      "feedback transmission failed — bundle persisted locally as fallback",
    );
    return {
      delivered: "local",
      path: local.path,
      size: local.size,
      transmissionFailure: { status: result.status, error: result.error },
    };
  }
  const local = await writeBundleLocally(bundle);
  return { delivered: "local", path: local.path, size: local.size };
}
