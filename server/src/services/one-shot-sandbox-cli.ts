/**
 * U13.1 — the shared ephemeral-sandbox one-shot CLI helper. Every host-side
 * one-shot provider-CLI family that must run inside a sandbox on cloud
 * (extraction — U13.2/U13.3, Commander compaction — U13.6, readiness
 * probes — U13.7) routes through this single seam:
 *
 *   1. resolve the COMPANY's own model-provider key (U13.0,
 *      `resolveCompanyProviderCredential`) — never the host's.
 *   2. acquire a fresh sandbox lease via the U4 execution-context seam
 *      (`acquireExecutionContext`), or reuse a pre-acquired batch lease
 *      passed as `sandboxHandle` (U13.3 — one sandbox per extraction batch).
 *   3. resolve provider config EXACTLY the way `executeRunLeaseCommand`
 *      does (S6, environment-runtime.ts): read `lease.provider` +
 *      `lease.providerLeaseId` + `lease.metadata.providerMetadata`, then
 *      `resolveRuntimeProviderConfig(...)` — never a hand-built shape.
 *   4. build the env overlay FIRST (only the company credential — a
 *      one-shot CLI has no MCP loopback / run identity, so no
 *      AOA_RUN_ID / AOA_API_URL), then filter it through the U5 positive
 *      allowlist (`buildSandboxEnvAllowlist`, S2).
 *   5. run the command, tear the sandbox down ONLY when this call acquired
 *      its own lease (a reused `sandboxHandle` is owned/released by the
 *      batch caller) via `environmentRuntimeService(db).releaseRunLease`
 *      (Wave 3 review, FIX 1) — NOT a raw `sandboxProviderRuntime()
 *      .releaseLease` call, which kills the VM but never flips the
 *      `environment_leases` row to 'released', orphaning it (this lease's
 *      heartbeatRunId is always null, so the org-only
 *      `releaseLeasesForRun` reaper can never reap it either).
 *      `releaseRunLease` reads the lease's real environment config
 *      (platform-default, which bakes `reuseLease:false` in) so this is
 *      still an ephemeral KILL, never a pause. The release-guarding `try`
 *      opens immediately after the lease is assigned (before the
 *      provider/providerLeaseId null-guards and provider-config resolve),
 *      so any throw between acquire and execute still releases the
 *      self-acquired VM+lease (orphan-safety).
 *
 * Real-shape note (grounded against acquire-execution-context.ts +
 * acquire-execution-context.test.ts, not the plan doc's simplified
 * sketch): `acquireExecutionContext`'s actual return type is
 * `{ sandbox: EnvironmentAcquisitionResult | null, lease, warmResolved }`,
 * NOT a bare `EnvironmentAcquisitionResult`. `sandbox` is null on the
 * "no environment resolved" (desktop/local_trusted) signal — that and any
 * thrown acquire failure both classify as `sandbox_unavailable` here.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import type { EnvironmentLease } from "@armyofagents/shared";
import { buildSandboxEnvAllowlist } from "@armyofagents/adapter-utils";
import {
  acquireExecutionContext as defaultAcquireExecutionContext,
  type AcquiredExecutionContext,
} from "./acquire-execution-context.js";
import type { EnvironmentAcquisitionResult } from "./environment-run-orchestrator.js";
import {
  resolveRuntimeProviderConfig as defaultResolveRuntimeProviderConfig,
  environmentRuntimeService as defaultEnvironmentRuntimeService,
} from "./environment-runtime.js";
import { sandboxProviderRuntime as defaultSandboxProviderRuntime } from "./sandbox-provider-runtime.js";
import { runtimeProviderKeyService as defaultRuntimeProviderKeyService } from "./runtime-provider-keys.js";
import { resolveCompanyProviderCredential as defaultResolveCompanyProviderCredential } from "./one-shot-provider-credential.js";
import {
  preflightOneShotCliSpend as defaultPreflightOneShotCliSpend,
  recordOneShotCliCost as defaultRecordOneShotCliCost,
  type OneShotCliCostSource,
} from "./one-shot-cli-budget.js";
import { logger } from "../middleware/logger.js";

export type OneShotSandboxErrorKind = "sandbox_unavailable" | "timeout" | "nonzero_exit";

export class OneShotSandboxError extends Error {
  constructor(
    message: string,
    readonly kind: OneShotSandboxErrorKind,
    readonly exitCode: number | null = null,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "OneShotSandboxError";
  }
}

export interface OneShotCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Pre-acquired batch lease (U13.3): the caller owns acquire + release; this
 *  helper only reuses it for one command and never tears it down. */
export interface OneShotSandboxHandle {
  environment: EnvironmentAcquisitionResult["environment"];
  lease: EnvironmentLease;
  providerConfig: Record<string, unknown>;
}

export interface OneShotDeps {
  acquireExecutionContext: typeof defaultAcquireExecutionContext;
  sandboxProviderRuntime: typeof defaultSandboxProviderRuntime;
  resolveRuntimeProviderConfig: typeof defaultResolveRuntimeProviderConfig;
  resolveCompanyProviderCredential: typeof defaultResolveCompanyProviderCredential;
  runtimeProviderKeyService: typeof defaultRuntimeProviderKeyService;
  preflightOneShotCliSpend: typeof defaultPreflightOneShotCliSpend;
  recordOneShotCliCost: typeof defaultRecordOneShotCliCost;
  /** Wave 3 review (FIX 1): teardown seam — see the `finally` block below. */
  environmentRuntimeService: typeof defaultEnvironmentRuntimeService;
}

const DEFAULT_DEPS: OneShotDeps = {
  acquireExecutionContext: defaultAcquireExecutionContext,
  sandboxProviderRuntime: defaultSandboxProviderRuntime,
  resolveRuntimeProviderConfig: defaultResolveRuntimeProviderConfig,
  resolveCompanyProviderCredential: defaultResolveCompanyProviderCredential,
  runtimeProviderKeyService: defaultRuntimeProviderKeyService,
  preflightOneShotCliSpend: defaultPreflightOneShotCliSpend,
  recordOneShotCliCost: defaultRecordOneShotCliCost,
  environmentRuntimeService: defaultEnvironmentRuntimeService,
};

export interface RunOneShotCliInput {
  db: Db;
  companyId: string;
  cliTool: string; // "claude" | "codex"
  command: string;
  args: string[];
  stdinContent?: string; // extraction/compaction prompt content
  stagedFile?: { remotePath: string; content: string }; // U13.5 file-import (plumbed only; files.write lands in U13.5)
  timeoutMs: number;
  sandboxHandle?: OneShotSandboxHandle; // U13.3 pre-acquired batch lease (skip own acquire + release)
  /** U13.4 — which one-shot CLI family incurred this spend; becomes
   *  `cost_events.billing_type` on the row recorded after a successful run. */
  source: OneShotCliCostSource;
  deps?: Partial<OneShotDeps>; // test injection
}

/** U13.4 — matches the codebase's existing char/4 estimate heuristic
 *  (context-assembly.ts, crew-context-bundle.ts): neither the sandbox
 *  runtime (`SandboxProviderExecuteResult`) nor the CLI wrapper report real
 *  token usage today, so this is the best available estimate at this seam. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function runOneShotCliInSandbox(input: RunOneShotCliInput): Promise<OneShotCliResult> {
  const deps: OneShotDeps = { ...DEFAULT_DEPS, ...input.deps };
  const startedAt = Date.now();

  // U13.4: fail BEFORE any spend — credential resolve, sandbox acquire, and
  // execute all cost something (a DB round-trip at minimum, real sandbox
  // compute/model tokens at most). Runs unconditionally, even when a
  // pre-acquired `sandboxHandle` is supplied (batch reuse, U13.3): there's
  // no acquire step to gate in that branch, but THIS CALL still spends model
  // tokens via `execute`, so the gate must still run per-call, not just
  // per-batch-acquire.
  const preflight = await deps.preflightOneShotCliSpend(input.db, { companyId: input.companyId });
  if (!preflight.allowed) {
    throw new OneShotSandboxError(
      `One-shot CLI spawn blocked before any sandbox spend: ${preflight.reason}`,
      "sandbox_unavailable",
    );
  }

  // S3: the company's own model-provider key — never the host process env.
  const credential = await deps.resolveCompanyProviderCredential(input.db, input.companyId, {
    cliTool: input.cliTool,
  });

  const handle = input.sandboxHandle;
  const selfAcquired = !handle;

  let environment: EnvironmentAcquisitionResult["environment"];
  let lease: EnvironmentLease;

  if (handle) {
    environment = handle.environment;
    lease = handle.lease;
  } else {
    let acquired: AcquiredExecutionContext;
    try {
      acquired = await deps.acquireExecutionContext(input.db, {
        runIdentity: {
          companyId: input.companyId,
          agentId: null,
          runId: randomUUID(),
          adapterType: input.cliTool === "codex" ? "codex_local" : "claude_local",
        },
        functionType: null, // one-shot CLI has no functionType — always ephemeral
        warmPreference: false, // one-shot CLI is never warm (U7.5)
        worktree: null,
        environmentId: null, // no pin -> platform-default resolution (U1)
        issueId: null,
        heartbeatRunId: null,
      });
    } catch (err) {
      throw new OneShotSandboxError(
        `Failed to acquire an execution sandbox: ${err instanceof Error ? err.message : String(err)}`,
        "sandbox_unavailable",
      );
    }
    // S5: `sandbox` is null on the "no environment resolved" signal
    // (desktop/local_trusted); a resolved-but-non-sandbox driver is also
    // unusable for a one-shot CLI spawn — both classify the same way.
    if (!acquired.sandbox || acquired.sandbox.environment.driver !== "sandbox") {
      throw new OneShotSandboxError(
        "No isolated sandbox environment is available for this company.",
        "sandbox_unavailable",
      );
    }
    environment = acquired.sandbox.environment;
    lease = acquired.sandbox.lease;
  }

  // Wave 3 review (FIX 1, orphan-safety, findings 1/2/3/7): the release-
  // guarding `try` starts HERE — immediately after `lease` is assigned —
  // not just around `execute`. Once `lease` exists for a self-acquired run,
  // a REAL VM + `environment_leases` row already exist; a throw from ANY
  // point below (a lease missing provider/providerLeaseId,
  // resolveRuntimeProviderConfig failing, or execute itself failing) must
  // still release it, or the VM+row orphan. A reused `sandboxHandle` is
  // owned by the batch caller (selfAcquired:false), so the `finally` below
  // is correctly a no-op for it regardless of where this try starts.
  try {
    // S6: resolve provider config EXACTLY the way executeRunLeaseCommand does
    // (environment-runtime.ts:512-541) — never a hand-built lease shape.
    const provider = readString(lease.provider);
    if (!provider) {
      throw new OneShotSandboxError("Sandbox lease is missing a provider.", "sandbox_unavailable");
    }
    const providerLeaseId = readString(lease.providerLeaseId);
    if (!providerLeaseId) {
      throw new OneShotSandboxError(`Sandbox lease "${lease.id}" is missing providerLeaseId.`, "sandbox_unavailable");
    }
    const providerMetadata = readObject(readObject(lease.metadata).providerMetadata);
    const providerConfig =
      handle?.providerConfig ??
      (await deps.resolveRuntimeProviderConfig({
        companyId: input.companyId,
        provider,
        config: readObject(environment.config),
        runtimeProviderKeys: deps.runtimeProviderKeyService(input.db),
        issueId: null,
        heartbeatRunId: null,
      }));

    // S2: build the overlay FIRST (only the company's own resolved credential —
    // no AOA_RUN_ID / AOA_API_URL, this is not an MCP-loopback-capable run),
    // then filter it through the positive allowlist. Never read process.env.
    const overlay: Record<string, string> = { [credential.envName]: credential.value };
    const env = buildSandboxEnvAllowlist(overlay, { provider: credential.provider });

    const runtime = deps.sandboxProviderRuntime();

    const result = await runtime.execute(provider, {
      command: input.command,
      args: input.args,
      env,
      // U13.5: when a staged file is requested, content flows via the file
      // staged into the VM (below), not anonymous stdin.
      stdin: input.stagedFile ? undefined : input.stdinContent,
      stagedFile: input.stagedFile,
      providerLeaseId,
      leaseMetadata: providerMetadata,
      config: providerConfig,
      timeoutMs: input.timeoutMs,
    });

    if (result.timedOut) {
      throw new OneShotSandboxError("One-shot CLI timed out inside the sandbox.", "timeout");
    }
    const exitCode = result.exitCode;
    if (typeof exitCode !== "number") {
      throw new OneShotSandboxError("One-shot CLI produced no exit code.", "nonzero_exit", exitCode ?? null, result.stderr);
    }
    if (exitCode !== 0) {
      throw new OneShotSandboxError(`One-shot CLI exited with code ${exitCode}.`, "nonzero_exit", exitCode, result.stderr);
    }

    // U13.4: record spend on a genuinely successful run only (exit 0, past
    // every OneShotSandboxError throw above). Priced against the COMPANY's
    // own resolved credential (provider+model) — the actual thing being
    // billed — never a generic per-cliTool rate table. Best-effort: a
    // cost-recording failure must never fail an otherwise-successful CLI
    // call (mirrors the codebase's other best-effort post-success side
    // effects, e.g. postRunSummaryComment).
    try {
      await deps.recordOneShotCliCost(input.db, {
        companyId: input.companyId,
        provider: credential.provider,
        model: credential.model,
        inputTokens: estimateTokens(input.stdinContent ?? input.stagedFile?.content ?? ""),
        outputTokens: estimateTokens(result.stdout),
        source: input.source,
      });
    } catch (err) {
      logger.error({ err }, "recordOneShotCliCost failed after a successful one-shot CLI run");
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // Wave 3 review (FIX 1, findings 1/2/3/7): route teardown through
    // environmentRuntimeService(...).releaseRunLease — mirrors the crew fix
    // at runner.ts:1677 — instead of calling
    // sandboxProviderRuntime().releaseLease directly. The raw provider call
    // only kills the e2b VM; it never flips the `environment_leases` row to
    // 'released'. Because this lease is acquired with heartbeatRunId:null
    // (a one-shot CLI has no heartbeat run), the org-only reaper
    // (`releaseLeasesForRun`, filtered on `heartbeat_run_id`) can never find
    // or reap it — releaseRunLease's DB-flip is the ONLY release path here,
    // same as crew. The ephemeral KILL (never pause) still holds:
    // `environmentId:null` always resolves to the platform-default
    // environment (platform-default-environment.ts), whose config bakes
    // `reuseLease:false` in — releaseRunLease reads THAT environment
    // config (not a hand-built shape), so the e2b provider kills rather
    // than pausing. ONLY for a lease this call acquired itself — a reused
    // `sandboxHandle` (batch path, U13.3) is released once by the batch
    // caller. Best-effort (`.catch`): a release failure must never mask
    // the already-decided result/error above.
    if (selfAcquired) {
      await deps
        .environmentRuntimeService(input.db)
        .releaseRunLease({ environment, lease, status: "released" })
        .catch((err) => {
          logger.warn({ err }, "one-shot sandbox release failed");
        });
    }
  }
}
