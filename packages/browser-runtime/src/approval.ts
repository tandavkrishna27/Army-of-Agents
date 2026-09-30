// packages/browser-runtime/src/approval.ts
//
// BRW-004 slice (c) — THE IN-GUEST APPROVAL SEAM, and D5's closure of the auto-approval
// widening that populating a scope field would otherwise open.
//
// WHAT THIS IS. `runBrowserSession` had no pause/ask seam of any kind: BRW-004's terrain §1
// measured zero approval producers in `packages/browser-runtime`, and its only refusal was
// `download_refused`, decided by pure path resolution. This file is the seam plus the two
// pure decisions around it, both of which are security properties and neither of which may be
// decided by the guest:
//
//   1. WHICH DECISIONS LET A BROWSER ACTION PROCEED (D5), and
//   2. WHAT HAPPENS WHEN NO DECISION ARRIVES (fail closed).
//
// ★★ WHY THE DECISION SET IS NARROWER THAN THE PROTOCOL'S. `PERMISSION_DECISIONS` is
// `[allow_once, allow_run, allow_always, deny, expired, cancelled]`. BRW-004 §D5 accepts
// exactly ONE of them — `allow_once` — and that is not tidiness, it is the closure of a real
// widening this ticket creates.
//
// Terrain §3b measured why a browser action cannot be auto-approved TODAY: `extractScope` has
// no browser branch, so `networkTarget` and `riskClass` come through null, `hasConcreteTrustScope`
// fails, and `allow_always` / `allow_run` are both refused as `unprocessable`. That inertness is
// ACCIDENTAL. The moment a browser prompt carries a real `networkTarget` — which slice (c) must
// do, because an approval that cannot name its destination is not a scoped approval — a
// standing trust rule becomes matchable and `allow_always` becomes reachable for browser egress.
//
// A standing, non-expiring grant to navigate a domain is a DIFFERENT PRODUCT DECISION from a
// one-shot approval, and it must not arrive as a side effect of adding a scope field. So the
// widening and its closure ship in the same file: `classifyBrowserPermissionDecision` refuses
// `allow_run` and `allow_always` explicitly, by name, with their own reason code — not by
// omission, so a reader can see the refusal was chosen rather than forgotten.
//
// ★★ AND THE DEFAULT IS REFUSE, INCLUDING FOR VALUES THAT DO NOT EXIST YET. An unrecognised
// decision string refuses. If a future protocol version adds a seventh permission decision,
// this guest treats it as a refusal until someone deliberately admits it here. The opposite
// default — "unknown means proceed" — is how a fail-closed lever becomes a dead one.
//
// ★ WHAT THIS FILE DELIBERATELY DOES NOT DO, so the result doc does not have to walk it back:
// it does not mint the frozen `permissionRuntimeDecisionRequestV1`. That event carries a
// `requestDigest` — SHA-256 over canonical bytes — and a `sourceRevision`, and the guest has
// neither the canonicalizer nor the revision counter. Minting a digest the control plane would
// recompute differently is worse than not minting one: it fails as a request that never
// verifies. So the guest produces an INTENT carrying only the fields it is the authority for,
// and the worker-side sequencer — which already owns nonce, digest and sequence discipline,
// and already redacts before digesting — completes it. That completion step is NOT built by
// this slice, and the intent is inert until it is.

/** The six frozen permission decisions, mirrored so this module stays dependency-free. */
export type BrowserPermissionDecision =
  | "allow_once"
  | "allow_run"
  | "allow_always"
  | "deny"
  | "expired"
  | "cancelled";

/** Why a browser action was refused. Every value is a closed, testable cause. */
export type ApprovalRefusalReason =
  /** The founder denied it. */
  | "denied"
  /** The decision expired, or none arrived before the deadline. */
  | "timed_out"
  /** The decision was cancelled upstream. */
  | "cancelled"
  /**
   * D5: `allow_run` / `allow_always` are standing grants. A browser prompt accepts
   * `allow_once` only, so a standing grant is refused rather than honoured.
   */
  | "standing_grant_refused"
  /** The decision string is not one this guest understands. Fail closed. */
  | "unrecognised_decision"
  /** The resolver itself threw. A broken approval channel is a refusal, never a pass. */
  | "resolver_failed";

export type ApprovalOutcome =
  | { readonly ok: true; readonly decision: "allow_once" }
  | { readonly ok: false; readonly reason: ApprovalRefusalReason; readonly detail: string };

/**
 * The classes of browser action that require an approval. Both are named on the acceptance
 * clause ("allowed domains and download/upload policy are enforced") and both map onto the
 * shipped `permission_download_egress` runtime-decision authority.
 */
export type BrowserApprovalAction = "navigate" | "download";

/**
 * What the guest is the authority for, and nothing more.
 *
 * Every field here is a field of the frozen `permissionRuntimeDecisionRequestV1` — pinned by a
 * test that imports the real schema rather than by this comment. `riskClass` and `networkTarget`
 * are the two the shipped `extractScope` leaves null for browser prompts today (terrain §3b),
 * and populating them is exactly what makes D5's refusal necessary.
 */
export interface BrowserApprovalIntent {
  readonly action: BrowserApprovalAction;
  /** Human-readable title. Bounded to the frozen `title` limit at construction. */
  readonly title: string;
  /** Human-readable summary, or null. Bounded to the frozen `summary` limit. */
  readonly summary: string | null;
  /** The destination ORIGIN for a navigation; null for an action with no network target. */
  readonly networkTarget: string | null;
  /** The risk class the control plane scopes a trust rule against. */
  readonly riskClass: string;
}

/** The injected decision channel. Slice (c) ships only the refusing one. */
export type ApprovalResolver = (intent: BrowserApprovalIntent) => Promise<BrowserPermissionDecision>;

// The frozen bounds, mirrored. Exceeding them would make the completed request unparseable at
// the control plane, and a request that never parses is a session that hangs to its envelope
// deadline rather than one that is refused — a different, and worse, failure.
const TITLE_MAX = 500;
const SUMMARY_MAX = 4000;
const NETWORK_TARGET_MAX = 1000;
const RISK_CLASS_MAX = 100;

/**
 * Build the intent for one action, with every bounded field truncated at its frozen limit.
 *
 * Truncating here rather than at the control plane is deliberate: the guest is the only place
 * that knows the untruncated value, so a silent rejection upstream would lose the reason.
 */
export function buildApprovalIntent(input: {
  action: BrowserApprovalAction;
  title: string;
  summary?: string | null;
  networkTarget?: string | null;
  riskClass: string;
}): BrowserApprovalIntent {
  return {
    action: input.action,
    title: input.title.slice(0, TITLE_MAX),
    summary: input.summary == null ? null : input.summary.slice(0, SUMMARY_MAX),
    networkTarget: input.networkTarget == null ? null : input.networkTarget.slice(0, NETWORK_TARGET_MAX),
    riskClass: input.riskClass.slice(0, RISK_CLASS_MAX),
  };
}

/**
 * The destination origin a navigation approval is scoped to.
 *
 * Returns null for an unparseable URL: a scope this code cannot name must not be guessed at,
 * and the caller treats a null target as an action it cannot scope rather than as a wildcard.
 */
export function navigationTarget(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * D5 — classify a permission decision for a BROWSER-sourced prompt.
 *
 * Pure, total, and the single place the browser's narrower decision set is expressed.
 */
export function classifyBrowserPermissionDecision(decision: string): ApprovalOutcome {
  switch (decision) {
    case "allow_once":
      return { ok: true, decision: "allow_once" };
    case "allow_run":
    case "allow_always":
      // NOT an omission. See the header: a standing grant to navigate a domain is a separate
      // product decision and must not arrive as a side effect of populating `networkTarget`.
      return {
        ok: false,
        reason: "standing_grant_refused",
        detail: `browser prompts accept allow_once only; "${decision}" is a standing grant (BRW-004 D5)`,
      };
    case "deny":
      return { ok: false, reason: "denied", detail: "the decision was deny" };
    case "expired":
      return { ok: false, reason: "timed_out", detail: "the decision expired before it was answered" };
    case "cancelled":
      return { ok: false, reason: "cancelled", detail: "the decision was cancelled" };
    default:
      return {
        ok: false,
        reason: "unrecognised_decision",
        detail: `unrecognised permission decision ${JSON.stringify(decision)}`,
      };
  }
}

/** A timer, injected so the deadline is a test assertion rather than a wall-clock wait. */
export type Delay = (ms: number) => Promise<void>;

export interface AwaitApprovalInput {
  readonly resolver: ApprovalResolver;
  readonly intent: BrowserApprovalIntent;
  /** Wall-clock budget for a decision to arrive. */
  readonly timeoutMs: number;
  readonly delay: Delay;
}

/**
 * Ask for a decision and BLOCK until one arrives or the deadline passes.
 *
 * Three fail-closed properties, all of them observable:
 *   * no decision by the deadline  -> refuse `timed_out`;
 *   * the resolver throws          -> refuse `resolver_failed` (a broken channel is not a pass);
 *   * anything other than allow_once -> refuse, per `classifyBrowserPermissionDecision`.
 *
 * ★ A LATE ARRIVAL CANNOT UN-REFUSE. Once the deadline wins the race the outcome is fixed; a
 * decision that lands afterwards is ignored here and, at the control plane, is rejected by the
 * frozen `matchRuntimeDecisionResultToRequestV1` late-positive guard. Both layers refuse it,
 * which is the point — the guest is not the authority for the pairing.
 */
export async function awaitApprovalDecision(input: AwaitApprovalInput): Promise<ApprovalOutcome> {
  // A sentinel object rather than a string: a resolver that returned the literal "timed_out"
  // must not be able to impersonate the deadline, and reference identity makes that impossible.
  const TIMED_OUT: { readonly timedOut: true } = { timedOut: true };
  let decision: BrowserPermissionDecision | typeof TIMED_OUT;

  // ★★★ A BELIEF THIS CODE USED TO DEFEND AGAINST, MEASURED AND FOUND FALSE. An earlier version
  // added `void Promise.allSettled([...])` here, reasoning that `Promise.race` settles once, so a
  // resolver that rejects AFTER the deadline has won would leave a rejected promise with nothing
  // listening — fatal under `--unhandled-rejections=strict`, and this code runs as the sandbox's
  // entrypoint process. The mutation that deletes the guard SURVIVED, which is a question, not a
  // verdict, and the answer was that the guard was unnecessary: `Promise.race` calls `.then` on
  // EVERY element, so the loser's rejection is already observed. Measured directly in a strict-mode
  // child process — the late rejection does not kill it. The guard was removed rather than shipped
  // beside a test that could never fail, because a defensive line nothing can falsify is a false
  // claim of enforcement, which this programme treats as worse than the absent check.
  //
  // The rejection that WINS the race still reaches the catch below and still becomes
  // `resolver_failed`; that path has its own test.
  try {
    decision = await Promise.race<BrowserPermissionDecision | typeof TIMED_OUT>([
      input.resolver(input.intent),
      input.delay(input.timeoutMs).then(() => TIMED_OUT),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: "resolver_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (typeof decision !== "string") {
    return {
      ok: false,
      reason: "timed_out",
      detail: `no decision within ${input.timeoutMs}ms`,
    };
  }
  return classifyBrowserPermissionDecision(decision);
}

/**
 * The resolver slice (c) ships: it refuses everything.
 *
 * ★ This is NOT a placeholder that "will be replaced". It is the correct default for a runtime
 * with no delivery channel: BRW-004 terrain §4 measured that no control-plane hop delivers a
 * decision to a running worker at all — `commandKind` appeared zero times in
 * `packages/worker-daemon/src` and `decideControlReceiverV1` HAD zero production callers — ★ BOTH ARE NOW FALSE as of JOB-015 (`lease/control-commands.ts` calls it), though no command reaches the channel from a production-queued row yet. The
 * hop is chartered as JOB-015 and is NOT this ticket's. Until it exists, a resolver that
 * pretended to grant would be a lie about a channel that does not carry anything.
 */
export const inertRefusingResolver: ApprovalResolver = async () => "deny";
