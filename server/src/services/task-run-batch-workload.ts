// server/src/services/task-run-batch-workload.ts
//
// CLI-006 / Blocker A — build the frozen `batch` workload a canary task run submits.
//
// WHY THIS EXISTS. The distributed path reaches the sandbox through exactly ONE channel:
// `createSpecFor` (packages/worker-daemon/src/supervisor/supervisor.ts) reads ONLY
// `workload.command` and `workload.args`. `ExecuteInput` has no stdin, `stdinArtifactId`
// has zero consumers, and `workspace` is hard-coded `null`. So argv is the whole contract.
// Until this module existed, `input` was plumbed end-to-end (heartbeat-distributed-rollout →
// run-execution-owner → job-convert-orchestrator → job-admission-bridge) and NOTHING pushed
// into it: every canary job carried `{}`, `createSpecFor` fell back to `command =
// workloadType` ("batch"), and no lease could ever run a real agent.
//
// ── CLI-008 Unit D — argv is no longer the whole contract ─────────────────────────────
// The module now emits TWO things that must agree: the workload, and the FILES that must
// exist inside the sandbox for that workload's argv to mean anything. The prompt and the
// instructions bundle ride CLI-008 Unit B's staging channel (control plane → object storage
// → download grant → `transport.writeFiles`); the argv reads them by absolute path, through
// `sh -c`, exactly as the legacy adapters read them from disk. See
// `task-run-sandbox-invocation.ts` for the shapes and for why nothing is interpolated into
// the script.
//
// ★ THAT CLOSES E7-F008. `FROZEN_MAX_ARG_CHARS` used to gate the PROMPT, so a task whose
// assembled markdown exceeded 8,192 characters could not dispatch distributed at all — a live
// refusal, the only one among the open findings. The prompt is no longer an argv element, so
// the frozen per-element ceiling no longer applies to it. It is bounded instead by
// `MAX_STAGED_FILE_BYTES`, a staging-side sanity ceiling 128× larger, and the mirror constant
// stays because the ARGV is still bounded by the frozen schema.
//
// WHAT IT IS NOT. It is not the shadow comparator (`job-shadow-comparator.ts`), which
// hand-writes `command: agent.adapterType` — a REGISTRY KEY ("claude_local"), not a binary,
// as its own comment concedes. Mirror that module's SHAPE, never its VALUES. The precedent
// this module actually follows is `browser-job-config.ts`: a pure builder that self-validates
// against the frozen schema so it cannot drift from the wire contract.
//
// PURE + SYNCHRONOUS — no I/O, no database, no clock, no randomness. That last one is load
// bearing: `job-submission.ts` hashes the whole command INCLUDING `input`, and a differing
// digest under the same `idempotencyKey` (= `run.id`) is a 409. A timestamp or a nonce here
// would turn every retry into a hard conflict. `buildTaskRunBatchWorkload` is a function of
// its inputs alone; `task-run-batch-workload.test.ts` asserts that byte-for-byte.
//
// FAIL CLOSED, NEVER GUESS. Every refusal returns `{ok:false, reason}` and the seam leaves
// the run with the legacy executor. There is no fallback command, and no truncation: a
// silently truncated prompt would produce a sandbox that runs mutilated work, terminalizes
// cleanly, and satisfies the acceptance verifier while proving nothing.
import {
  batchWorkloadV1Schema,
  type BatchWorkloadV1,
} from "@armyofagents/worker-protocol";
import { dispositionForAdapter } from "./sandbox-coding-disposition.js";
import {
  buildSandboxInvocation,
  type SandboxStagedFile,
} from "./task-run-sandbox-invocation.js";
import {
  resolveHeartbeatRunTimeoutPolicy,
  type HeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

/** Why a canary task run could not be expressed as a `batch` workload. Machine-readable so
 * the seam can log an attributable reason rather than an undifferentiated "stayed legacy". */
export type TaskRunBatchWorkloadRejection =
  /** The adapter is outside the v1 sandboxed-coding scope (sandbox-coding-disposition.ts). */
  | "adapter_not_v1_scope"
  /** `getRuntimeCommandSpec` returned null / an unusable command — 5 of 14 adapters do. */
  | "no_runtime_command_spec"
  /** No task content was assembled for this run, so there is no prompt to deliver. */
  | "empty_prompt"
  /**
   * A file this run must stage exceeds {@link MAX_STAGED_FILE_BYTES}. REFUSED, never
   * truncated.
   *
   * ★ THIS REPLACES `prompt_too_large` (E7-F008). That reason gated the prompt at the frozen
   * 8,192-CHARACTER per-argv-element ceiling, because the prompt WAS an argv element. It is
   * now a staged file, so the frozen ceiling does not reach it and the bound is the staging
   * path's own. The reason was renamed rather than deleted so a refusal still exists and is
   * still attributable: a guard nobody can trip is a false claim of enforcement, and silently
   * dropping the last size check on content that goes into a sandbox is the other half of
   * that mistake.
   */
  | "staged_input_too_large"
  /** The serialized workload exceeds the submission surface's 64 KiB `input` bound. */
  | "workload_too_large"
  /** The assembled workload failed the FROZEN schema — the schema always has the last word. */
  | "invalid_workload";

/** Re-exported so callers of this module do not have to know which module owns the paths. */
export type TaskRunStagedFile = SandboxStagedFile;

/**
 * ★★★ THE WORKLOAD AND THE FILES ARE ONE RESULT, NOT TWO.
 *
 * The argv reads absolute paths; the staged set writes them. A caller that could take one
 * without the other could place a leasable attempt whose command reads a file nobody staged —
 * which is a sandbox that fails at exec, or (worse, if the guard in the script were ever
 * removed) an agent working from nothing. `run-execution-owner.ts` refuses to go distributed
 * when staged files are requested and no staging port is composed, for the same reason.
 */
export type BuildTaskRunBatchWorkloadResult =
  | {
      readonly ok: true;
      readonly workload: BatchWorkloadV1;
      readonly stagedFiles: readonly TaskRunStagedFile[];
    }
  | { readonly ok: false; readonly reason: TaskRunBatchWorkloadRejection };

export interface TaskRunBatchWorkloadInput {
  /** `agents.adapter_type` — the REGISTRY key. Used ONLY to pick the disposition + argv
   * shape; it is never used as a command (that is the shadow comparator's bug). */
  readonly adapterType: string;
  /** `resolveGuardedAdapterExecutionContext(...).runtimeCommandSpec` — the adapter's real
   * binary, already honoring a founder `adapterConfig.command` override. `null` for the 5
   * registered adapters with no `getRuntimeCommandSpec`; a null is a REFUSAL, not a default. */
  readonly runtimeCommandSpec: { readonly command?: unknown } | null | undefined;
  /** The run-scoped adapter config (`runScopedConfig`), read ONLY for the timeout policy. */
  readonly adapterConfig: Record<string, unknown> | null | undefined;
  /** `context.currentTaskMarkdown` — the REAL assembled task content. Deliberately NOT
   * `runScopedConfig.promptTemplate`, which is an UNRENDERED `{{…}}` template (rendering
   * happens inside `adapter.execute`, two lines after the canary returns) and is DELETED
   * outright for agents migrated to the instructions bundle. Template rendering is Unit 2. */
  readonly currentTaskMarkdown: unknown;
  /**
   * CLI-008 Unit D — the agent's instructions bundle ENTRY FILE content, already read off the
   * host by `resolveTaskRunInstructionsBundle`. `null`/absent means this agent has no bundle
   * configured, which is legal and common: the invocation then omits the bundle flag entirely
   * rather than staging an empty file.
   *
   * ★ A CONFIGURED-BUT-UNREADABLE bundle must NEVER arrive here as `null`. That is the
   * distinction the resolver exists to preserve, and it resolves it before this module is
   * called: "no bundle" is a shape, "could not read the bundle" is a refusal, and collapsing
   * them here would run a canary agent without its identity while every gate downstream
   * stayed green.
   */
  readonly instructions?: string | null;
  /**
   * CLI-008 Unit C — the brokered `aoa` MCP config document to stage for a distributed
   * claude run, already assembled by the caller. `null`/absent (and empty/whitespace-only,
   * normalized here) means this run provisions NO tool surface: `buildSandboxInvocation`
   * then stages no config file and emits no `--mcp-config` flag. Non-null only reaches here
   * once the tool-surface flag is on (Unit C S4); until then every caller passes null, so
   * this field is inert.
   */
  readonly aoaMcpConfig?: string | null;
}

/** The frozen per-arg ceiling (`batchWorkloadV1Schema`: `z.array(z.string().max(8192))`).
 * Mirrored so an argv element can be refused with an attributable reason before the schema
 * rejects it generically; the frozen schema still has the last word.
 *
 * ★ SINCE UNIT D THE PROMPT IS NOT AN ARGV ELEMENT, so this no longer bounds task content —
 * that was E7-F008, and it is closed. What it still bounds is what the argv actually carries:
 * a fixed script and the adapter's resolved binary. The constant stays because the mirror is
 * still true and `task-run-batch-workload.test.ts` value-imports the frozen schema to prove
 * it; it is documentation of a wire fact, not a content policy. */
export const FROZEN_MAX_ARG_CHARS = 8192;

/**
 * The per-file ceiling on control-plane-staged content — 1 MiB, 128× the old argv ceiling.
 *
 * ★ WHY A NUMBER AT ALL, WHEN THE CHANNEL HAS NO SMALL BOUND. Object storage does not care,
 * the `job_artifacts` row does not care, and the `extensions[]` pointer is ~200 bytes per file
 * whatever the payload is — so this is not a protocol limit and it must not pretend to be one.
 * It is a sanity ceiling on bytes the control plane pushes into a tenant sandbox, at the one
 * place that decides to push them. Without it, an assembled prompt that grew without bound
 * (a runaway comment thread, a pathological task body) would be uploaded, granted, fetched and
 * written with nothing anywhere saying no.
 *
 * ★★ IT IS DELIBERATELY FAR ABOVE ANY REAL BUNDLE. The largest onboarding bundle entry
 * measured on this branch is the `commander` bundle at ~26 KB across four files; a single
 * entry file is a few KB. A refusal here means something is wrong, not that a founder wrote a
 * long task — which was exactly the complaint against the 8,192 ceiling this replaces.
 */
export const MAX_STAGED_FILE_BYTES = 1_048_576;

/** The submission surface's `input` bound (`packages/shared/src/validators/job-control.ts`:
 * `TextEncoder().encode(JSON.stringify(input)).byteLength > 65_536`). Mirrored exactly. */
export const SUBMISSION_MAX_INPUT_BYTES = 65_536;

/** The server-owned run ceiling, deliberately BENEATH the frozen 86_400 wire ceiling, and
 * the applied default when the agent configures no timeout.
 *
 * ★ A bare clamp CANNOT be used here: `defaultTimeoutSecForAdapter` is literally `return 0;`
 * for EVERY adapter (heartbeat-stop-metadata.ts), so an unconfigured agent yields
 * `effectiveTimeoutSec === 0` and `timeoutConfigured === false`. Clamping that into
 * [1, 86_400] would produce a ONE-SECOND run for every default-configured agent. The
 * `timeoutConfigured` flag — not the number — is what distinguishes "no timeout set" from
 * "a timeout of zero". */
/** ★ The bounds the WORKER actually enforces, mirrored so the workload cannot DECLARE a budget
 * the system will not HONOUR.
 *
 * `packages/worker-daemon/src/lifecycle/run-op-deadline.ts` is the SOURCE OF TRUTH. They are
 * mirrored rather than imported because server's only worker-daemon imports are `import type`
 * (erased at compile time); a value import would pull that barrel into the control plane's
 * RUNTIME graph for the sake of two numbers. `__tests__/task-run-batch-workload.test.ts`
 * value-imports the originals and asserts equality, so drift is a RED TEST, not a silent lie.
 *
 * Why a ceiling: the owned-labels capability lives 300s and is never re-minted on renewal, so a
 * deadline past (capability TTL − teardown headroom) leaves the sandbox un-destroyable — it is
 * recorded `orphaned` and keeps billing. Why a floor: the same value is ALSO the sandbox TTL at
 * `create`, so a very small budget would reap the sandbox out from under its own creation. */
export const TASK_RUN_MIN_ENFORCEABLE_SECONDS = 60;
export const TASK_RUN_MAX_ENFORCEABLE_SECONDS = 240;

/** The applied default when the agent configures no timeout: the most the system can actually
 * honour.
 *
 * ★ This was 600. That made the workload declare a budget nothing enforced — the worker clamps
 * the provider-op deadline to 240s, while `job-leasing.ts` derives the LEASE deadline from THIS
 * field, so the lease outlived the execution deadline by six minutes and a task that used its
 * declared budget died at 240s having been promised 600. Declared and enforced now agree. */
export const TASK_RUN_DEFAULT_MAX_RUNTIME_SECONDS = TASK_RUN_MAX_ENFORCEABLE_SECONDS;

/** The frozen wire ceiling on `maxRuntimeSeconds` (`batchWorkloadV1Schema`, 1..86_400). */
const FROZEN_MAX_RUNTIME_SECONDS = 86_400;

function readCommand(spec: TaskRunBatchWorkloadInput["runtimeCommandSpec"]): string | null {
  if (!spec || typeof spec !== "object") return null;
  const command = (spec as { command?: unknown }).command;
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the run's `maxRuntimeSeconds`.
 *
 * `timeoutConfigured ? min(600, floor(clamp(sec, 1, 86_400))) : 600`. The clamp is applied
 * BEFORE the floor, and the floor is unconditional because `effectiveTimeoutSec` can be
 * FRACTIONAL (`heartbeat-stop-metadata.ts` derives the `http` branch as `timeoutMs / 1000`)
 * while the frozen schema is `.int()`. `http` cannot reach this module today (it is `infra`
 * in the disposition matrix), so the floor is defensive rather than load-bearing — which is
 * exactly why it stays: the gate above it is the only thing making it unreachable.
 */
export function resolveTaskRunMaxRuntimeSeconds(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): number {
  return maxRuntimeSecondsForPolicy(
    resolveHeartbeatRunTimeoutPolicy(adapterType, adapterConfig ?? {}),
  );
}

/**
 * The policy → seconds arithmetic, split out so its FAIL-CLOSED arms are directly testable.
 *
 * `HeartbeatRunTimeoutPolicy.effectiveTimeoutSec` is typed `number | null` even though today
 * both branches of `resolveHeartbeatRunTimeoutPolicy` return a number. A null (or a NaN
 * arriving through the same widened type) must resolve to the 600s DEFAULT, never to
 * `Math.max(1, null) === 1` — which is the one-second trap wearing a different hat. The
 * split exists because that arm is unreachable through the public resolver, and an untestable
 * guard is one nobody can prove is a guard.
 */
export function maxRuntimeSecondsForPolicy(
  policy: Pick<HeartbeatRunTimeoutPolicy, "effectiveTimeoutSec" | "timeoutConfigured">,
): number {
  const seconds = policy.effectiveTimeoutSec;
  if (!policy.timeoutConfigured || typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return TASK_RUN_DEFAULT_MAX_RUNTIME_SECONDS;
  }
  const floored = Math.floor(Math.min(FROZEN_MAX_RUNTIME_SECONDS, Math.max(1, seconds)));
  // ★ Clamp to what the worker ENFORCES, not to the wire ceiling. A configured 45s was
  // previously emitted as 45 and enforced as 60 (the worker's floor); a configured 900s was
  // emitted as 600 and enforced as 240. Both were the same defect in opposite directions.
  return Math.min(
    TASK_RUN_MAX_ENFORCEABLE_SECONDS,
    Math.max(TASK_RUN_MIN_ENFORCEABLE_SECONDS, floored),
  );
}

/**
 * Build the `batch` workload for one canary task run, or refuse with an attributable reason.
 *
 * Never throws; never mutates its input; emits keys in a fixed order so an equivalent
 * resubmission produces a byte-identical workload (the idempotency digest depends on it).
 */
export function buildTaskRunBatchWorkload(
  input: TaskRunBatchWorkloadInput,
): BuildTaskRunBatchWorkloadResult {
  // 1. The disposition gate. There is NO adapter gate at the canary fork in heartbeat.ts
  //    (seven conjuncts, none adapter-related), so ANY of the 14 registered adapters can
  //    reach this seam. Without this gate an `http` agent would emit `command: "http"` —
  //    which passes `z.string().min(1).max(256)` — and the supervisor would run a
  //    nonexistent binary inside a sandbox while the real webhook stayed suppressed.
  //
  //    This is the SAME matrix the credential mint gates on
  //    (`execution-secret-handle-mint.ts`), so a non-v1 adapter could never obtain a
  //    credential handle — and therefore never a capability, and therefore never a sandbox.
  //    Refusing here makes that structural rather than incidental.
  if (dispositionForAdapter(input.adapterType).bucket !== "v1") {
    return { ok: false, reason: "adapter_not_v1_scope" };
  }

  // 2. The real binary. NEVER `agent.adapterType`.
  const command = readCommand(input.runtimeCommandSpec);
  if (command === null) return { ok: false, reason: "no_runtime_command_spec" };

  // 3. The prompt: the REAL assembled task content. Delivered as a STAGED FILE since Unit D.
  const prompt =
    typeof input.currentTaskMarkdown === "string" ? input.currentTaskMarkdown.trim() : "";
  if (prompt.length === 0) return { ok: false, reason: "empty_prompt" };

  // 3b. The instructions bundle entry file, when this agent has one. An empty/whitespace-only
  //     bundle is treated as ABSENT rather than staged: `--append-system-prompt-file` on an
  //     empty file is a flag that promises context and delivers none.
  const instructions =
    typeof input.instructions === "string" && input.instructions.trim().length > 0
      ? input.instructions
      : null;

  // 3b'. The brokered `aoa` MCP config, staged for a distributed claude run so the remote
  //      agent reaches `mcp__aoa__*`. Same empty-is-absent rule as the bundle: an
  //      empty/whitespace-only document is treated as ABSENT (no tool surface), never staged
  //      as a zero-byte config that `--mcp-config` would point at and claude would reject.
  //      Inert until Unit C S4 turns the tool-surface flag on; every caller passes null today.
  const aoaMcpConfig =
    typeof input.aoaMcpConfig === "string" && input.aoaMcpConfig.trim().length > 0
      ? input.aoaMcpConfig
      : null;

  // 3c. The argv AND the files it reads, from one function. `buildSandboxInvocation` owns the
  //     paths, so there is nowhere for the two to disagree about them.
  const invocation = buildSandboxInvocation({
    adapterType: input.adapterType,
    binary: command,
    prompt,
    instructions,
    aoaMcpConfig,
  });
  if (invocation === null) return { ok: false, reason: "adapter_not_v1_scope" };
  const stagedFiles = invocation.stagedFiles;

  // REFUSE, never truncate. A truncated prompt still creates a sandbox, still runs, still
  // terminalizes, and still satisfies the acceptance verifier — while the agent works from a
  // mutilated task. The ceiling is now the staging path's (1 MiB/file), not the frozen argv
  // element's (8,192 chars) — see E7-F008 and `MAX_STAGED_FILE_BYTES`.
  if (stagedFiles.some((file) => file.bytes.byteLength > MAX_STAGED_FILE_BYTES)) {
    return { ok: false, reason: "staged_input_too_large" };
  }

  const candidate = {
    command: invocation.command,
    args: [...invocation.args],
    // Zero consumers anywhere in the daemon; a value here would be inert, so `null` is the
    // honest encoding rather than a promise the runtime does not keep.
    stdinArtifactId: null,
    maxRuntimeSeconds: resolveTaskRunMaxRuntimeSeconds(input.adapterType, input.adapterConfig),
  };

  // 4. The FROZEN schema is the final authority — this module cannot drift from the wire
  //    contract, because every accepted output has been through it.
  const parsed = batchWorkloadV1Schema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "invalid_workload" };

  // 5. The submission surface's own bound, mirrored. Since Unit D the argv is a fixed script
  //    plus the resolved binary and two constant paths, so this cannot fire on task content
  //    any more — but the binary is founder-influenced (`adapterConfig.command`) and the
  //    frozen schema admits 8,192 chars per element against a 64 KiB job, so the backstop
  //    keeps a reachable remit. It stays where it is rather than being deleted as unreachable.
  const encoded = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(encoded).byteLength > SUBMISSION_MAX_INPUT_BYTES) {
    return { ok: false, reason: "workload_too_large" };
  }

  return { ok: true, workload: parsed.data, stagedFiles };
}
