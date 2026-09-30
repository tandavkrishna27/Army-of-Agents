/**
 * Shared "spawn the CLI's own auth-status command and branch on it" step for
 * environment-test probes.
 *
 * A hello/echo probe failing with an auth signal can't by itself tell "never
 * signed in" from "signed in, but the token was revoked" — both fail the
 * probe identically. The fix is to additionally ask the CLI's own status
 * command, which reports whether credentials EXIST locally (not whether they
 * still work), and use that to pick the right recovery copy for the founder.
 *
 * This module owns only the orchestration (call status, degrade on failure,
 * branch, build the check) — it is deliberately runner-agnostic. The caller
 * supplies `runStatus`, a zero-arg async function that already knows how to
 * spawn its adapter's CLI (via that adapter's execution-target runner) and
 * parse its own status output shape. That is what lets claude-local and
 * codex-local share this one function instead of each carrying a copy of the
 * try/catch-degrade/branch logic: only the spawn+parse differs per adapter,
 * and that lives in the `runStatus` closure the caller builds.
 */

import type { AdapterEnvironmentCheck } from "./types.js";

export interface AuthProbeStatus {
  /** Credentials are present locally. Says nothing about whether they still work. */
  loggedIn: boolean;
  /** Account label to show the founder ("ada@example.com"), when known. */
  account: string | null;
}

export interface AuthProbeBranchOptions {
  /**
   * Spawns the CLI's status command and parses its output. Must not throw
   * for expected failure modes (older CLI without the subcommand, spawn
   * error, timeout) — but if it does, `runAuthStatusAndBranch` catches it
   * and degrades to the "required" branch rather than propagating, so a
   * caller that can't guarantee a non-throwing implementation is still safe.
   */
  runStatus: () => Promise<AuthProbeStatus>;
  /** `AdapterEnvironmentCheck.code` to use for each branch. */
  codes: { expired: string; required: string };
  /** Message text for each branch. */
  copy: {
    expiredWithAccount: (account: string) => string;
    expiredNoAccount: string;
    required: string;
  };
  /** Hint text for each branch. */
  hints: { expired: string; required: string };
  /** Optional shared `detail` (e.g. a summarized probe failure line). */
  detail?: string | null;
}

/**
 * Runs `runStatus`, degrading to "not logged in" on any error, and returns
 * the single `AdapterEnvironmentCheck` the caller should push onto its
 * checks array — `expired` copy/code when the CLI reports credentials
 * present, `required` copy/code otherwise.
 */
export async function runAuthStatusAndBranch(
  opts: AuthProbeBranchOptions,
): Promise<AdapterEnvironmentCheck> {
  let status: AuthProbeStatus;
  try {
    status = await opts.runStatus();
  } catch {
    status = { loggedIn: false, account: null };
  }

  if (status.loggedIn) {
    return {
      code: opts.codes.expired,
      level: "warn",
      message: status.account ? opts.copy.expiredWithAccount(status.account) : opts.copy.expiredNoAccount,
      ...(opts.detail ? { detail: opts.detail } : {}),
      hint: opts.hints.expired,
    };
  }

  return {
    code: opts.codes.required,
    level: "warn",
    message: opts.copy.required,
    ...(opts.detail ? { detail: opts.detail } : {}),
    hint: opts.hints.required,
  };
}
