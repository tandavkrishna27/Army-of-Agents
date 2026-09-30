/**
 * W5c Task 5 — codex `app-server` approval bridge.
 *
 * Pure async function that Task 7 wires as the driver's `onServerApproval`
 * (`driver.ts` → `onServerApproval(method, params) => Promise<decision-string>`,
 * then `respond(id, { decision })`). Given a codex server approval REQUEST
 * (`item/commandExecution/requestApproval` or `item/fileChange/requestApproval`),
 * it surfaces the decision to a human via the injected
 * `AdapterRuntimeDecisionBroker` and returns the codex v2 decision STRING.
 *
 * This module MIRRORS the W5b (claude_local) hook bridge conventions
 * (`server/src/services/runtime-hook-bridge.ts`) so codex is consistent with
 * claude: same `AdapterRuntimePermissionPrompt` fields (title/summary/promptText/
 * command/cwd/path/riskClass), the same `allow_once|allow_always|deny` outcome
 * mapping, and `timeoutPolicy: "escalate"` on every prompt.
 *
 * SECURITY — FAIL-CLOSED. Every path that isn't an explicit human "allow"
 * returns `"decline"` (a valid universal deny per protocol §4):
 *   - unsupervised (`!bridged`) or no broker → decline, broker never called.
 *   - broker times out / throws (incl. RuntimeDecisionCancelledError) → decline.
 *   - unrecognized/unparseable broker outcome → decline.
 *   - a file-change target that escapes the workspace root (`cwd`) → decline
 *     WITHOUT even surfacing the prompt (an out-of-tree write must never be
 *     offered for approval).
 * The whole body is wrapped so the function NEVER throws.
 *
 * Pure: no fs calls, no process spawning. The path trust boundary is a
 * string-level `path.resolve` comparison — no stat/readlink (see §trust-boundary).
 *
 * Adapters MUST NOT import from `server/`; the broker types come from
 * `@armyofagents/adapter-utils`.
 */
import path from "node:path";
import type {
  AdapterRuntimeDecisionBroker,
  AdapterRuntimePermissionPrompt,
  AdapterRuntimePermissionAnswer,
} from "@armyofagents/adapter-utils";

/** The only decision strings this bridge ever returns (protocol §4, restricted). */
export type CodexReviewDecision = "accept" | "acceptForSession" | "decline";

const CMD_METHOD = "item/commandExecution/requestApproval";
const FILE_METHOD = "item/fileChange/requestApproval";

/** Fail-closed default: a valid universal deny for both approval kinds. */
const DECLINE: CodexReviewDecision = "decline";

export interface ApprovalBridgeDeps {
  /** Human-decision broker. Absent → fail-closed decline. */
  broker?: AdapterRuntimeDecisionBroker;
  /** Whether THIS run is supervised (per-run opt-in). False → decline. */
  bridged: boolean;
  /** Bounded wait budget handed to the broker. */
  timeoutMs: number;
  /** Workspace root; the file-change trust boundary. */
  cwd: string;
  /** Non-fatal log sink (audit / escape traces). */
  onLog?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Small readers — defensive, never throw
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, maxLen)}…`;
}

// ---------------------------------------------------------------------------
// File-change trust boundary (SECURITY)
// ---------------------------------------------------------------------------

/** One validated change target: the raw path plus its normalized absolute form. */
interface ValidatedPath {
  rawPath: string;
  normalizedPath: string;
}

/**
 * Resolve `rawPath` against the workspace root and confirm it is INSIDE it.
 *
 * - relative → `path.resolve(cwd, rawPath)`; absolute → `path.resolve(rawPath)`.
 * - IN-TREE iff resolved === resolve(cwd)  OR  resolved starts with
 *   resolve(cwd) + path.sep. The `+ path.sep` closes the prefix-trap so
 *   `/work/proj` does NOT match a sibling `/work/proj-evil`.
 * - `..` traversal collapses inside `path.resolve`, so `../../etc/passwd`
 *   resolves out-of-tree and is rejected here.
 *
 * String-level only — no fs (no stat/readlink). Returns null when out-of-tree.
 */
function validatePathInRoot(rawPath: string, cwd: string): ValidatedPath | null {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(root, rawPath);
  const inTree = resolved === root || resolved.startsWith(root + path.sep);
  return inTree ? { rawPath, normalizedPath: resolved } : null;
}

/** Extract raw change paths from `params.item.changes[].path` (defensive). */
function extractChangePaths(params: unknown): string[] {
  const item = asRecord(asRecord(params).item);
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths: string[] = [];
  for (const change of changes) {
    const p = safeStr(asRecord(change).path);
    if (p != null) paths.push(p);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Prompt builders — mirror W5b conventions
// ---------------------------------------------------------------------------

function buildCommandPrompt(params: unknown): AdapterRuntimePermissionPrompt {
  const p = asRecord(params);
  const command = safeStr(p.command);
  const cwd = safeStr(p.cwd);
  const reason = safeStr(p.reason);
  const detail = command ?? "(command)";
  const summaryReason = reason ? ` — ${truncate(reason, 200)}` : "";
  return {
    kind: "permission",
    title: `Command: ${truncate(detail, 80)}`,
    summary: `Agent wants to run a command${summaryReason}`,
    promptText: `Allow this command to run?\n\n${truncate(detail, 400)}`,
    command,
    cwd,
    riskClass: "shell",
    timeoutPolicy: "escalate",
    options: [
      {
        source: "codex_app_server",
        kind: "command",
        method: CMD_METHOD,
        reason: reason ?? undefined,
      },
    ],
  };
}

function buildFileChangePrompt(
  validated: ValidatedPath[],
  params: unknown,
): AdapterRuntimePermissionPrompt {
  const p = asRecord(params);
  const reason = safeStr(p.reason);
  const first = validated[0];
  const displayPath = first?.normalizedPath ?? null;
  const extra = validated.length > 1 ? ` (+${validated.length - 1} more)` : "";
  const summaryReason = reason ? ` — ${truncate(reason, 200)}` : "";
  return {
    kind: "permission",
    title: `File change: ${truncate(displayPath ?? "(files)", 80)}${extra}`,
    summary: `Agent wants to modify ${validated.length} file(s)${summaryReason}`,
    promptText: `Allow this file change?\n\n${displayPath ?? "(no path)"}${extra}`,
    path: displayPath,
    // Mirror buildCommandPrompt: an absent codex cwd yields null (not the server
    // process dir). The fileChange approval frame carries no cwd anyway; the trust
    // boundary uses deps.cwd, so this field is audit-only.
    cwd: safeStr(p.cwd),
    riskClass: "filesystem",
    timeoutPolicy: "escalate",
    // Audit metadata: carry BOTH the raw and normalized path for every change.
    options: validated.map((v) => ({
      source: "codex_app_server",
      kind: "file_change",
      method: FILE_METHOD,
      rawPath: v.rawPath,
      normalizedPath: v.normalizedPath,
      reason: reason ?? undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Broker outcome → codex decision
// ---------------------------------------------------------------------------

/**
 * Map the broker outcome to the codex decision string. Mirrors W5b's
 * `mapAnswerToHookResponse` allow/deny split, extended for codex's richer enum:
 *   allow_once   → accept
 *   allow_always → acceptForSession   (approve + remember for session)
 *   deny         → decline
 *   { timedOut } / unrecognized / unparseable → decline (fail-closed)
 */
function mapOutcome(
  outcome: AdapterRuntimePermissionAnswer | { timedOut: true } | null | undefined,
): CodexReviewDecision {
  if (!outcome || typeof outcome !== "object") return DECLINE;
  if ("timedOut" in outcome && outcome.timedOut === true) return DECLINE;
  const decision = (outcome as AdapterRuntimePermissionAnswer).decision;
  switch (decision) {
    case "allow_once":
      return "accept";
    case "allow_always":
      return "acceptForSession";
    case "deny":
      return DECLINE;
    default:
      return DECLINE;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function handleApprovalRequest(
  method: string,
  params: unknown,
  deps: ApprovalBridgeDeps,
): Promise<CodexReviewDecision> {
  const log = (msg: string): void => {
    try {
      deps.onLog?.(msg);
    } catch {
      // logging must never affect the decision
    }
  };

  try {
    // 1. Fail-closed gate: never relay when unsupervised or broker-less.
    if (!deps.bridged || !deps.broker) {
      return DECLINE;
    }

    // 2. Build the prompt (with the file-change trust boundary up front).
    let prompt: AdapterRuntimePermissionPrompt;
    if (method === FILE_METHOD) {
      const rawPaths = extractChangePaths(params);
      // Fail-closed: a file-change approval with no identifiable target path
      // gives us nothing to validate against the workspace root. We must not
      // blindly approve a write we cannot confirm is in-tree.
      if (rawPaths.length === 0) {
        log(
          `[aoa][codex-approval] file-change request carried no change paths — ` +
            `denied (cannot confirm in-tree).`,
        );
        return DECLINE;
      }
      const validated: ValidatedPath[] = [];
      for (const raw of rawPaths) {
        const ok = validatePathInRoot(raw, deps.cwd);
        if (!ok) {
          // ANY escaping change fails the WHOLE request closed — do not even
          // surface an out-of-tree write for approval.
          log(
            `[aoa][codex-approval] file-change target "${raw}" escapes workspace ` +
              `root "${path.resolve(deps.cwd)}" — denied without prompting.`,
          );
          return DECLINE;
        }
        validated.push(ok);
      }
      prompt = buildFileChangePrompt(validated, params);
      prompt.cwd = path.resolve(deps.cwd);
    } else if (method === CMD_METHOD) {
      prompt = buildCommandPrompt(params);
    } else {
      log(`[aoa][codex-approval] unsupported server request "${method}" denied without prompting.`);
      return DECLINE;
    }

    // 3. Ask the human (bounded). Any throw → decline (caught below).
    const outcome = await deps.broker.requestPermissionBounded(prompt, deps.timeoutMs);
    return mapOutcome(outcome);
  } catch (error) {
    // 4. NEVER throws — every error path is fail-closed.
    log(
      `[aoa][codex-approval] approval bridge error (${method}); denying: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return DECLINE;
  }
}
