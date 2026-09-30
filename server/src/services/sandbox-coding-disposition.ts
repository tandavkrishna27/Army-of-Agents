/**
 * sandbox-coding-disposition.ts — CLI-002/D3.
 *
 * The per-adapter-TYPE disposition matrix + the execute-path gate that decides,
 * BEFORE execution, whether a coding adapter may run on the sandboxed cloud pool.
 * It is the machine-checkable realization of program-design.md:765's mandate that
 * "every registered adapter has an explicit disposition" and CLI-002's acceptance
 * clause: "a coding adapter outside the v1 sandboxed scope fails closed with an
 * attributable reason before execution — never a silent host fallback."
 *
 * Grounded in `server/src/adapters/registry.ts` (the 12 registered types +
 * process/http) and the sandbox provider-key map in
 * `packages/adapter-utils/src/sandbox-env-allowlist.ts` (anthropic/openai/gemini/
 * xai/cursor). The matrix is the SOURCE OF TRUTH; a static lint (the
 * `sandbox-coding-disposition.test.ts` unit + the `check-sandbox-coding-disposition`
 * policy checker) asserts every registered type is present and none is mis-bucketed.
 *
 * Buckets (design §2):
 *   - v1          : admitted on the sandboxed cloud pool — `claude_local` (anthropic),
 *                   `codex_local` (openai); the two #320-wired (U5 provider key +
 *                   brokered MCP), W8 live-validated.
 *   - follow_up   : a local CLI with a #320-threaded sandbox provider key, RECORDED
 *                   but NOT admitted yet — admit once in-VM MCP staging + model→
 *                   provider mapping are proven.
 *   - out_of_scope: fails closed under cloud_auth with an attributable reason (no
 *                   sandbox provider-key mapping / cloud service / gateway / external
 *                   wire-protocol runtime).
 *   - infra       : not a coding CLI at all (`process`/`http`) — outside the matrix;
 *                   never admitted to the coding path.
 */

export type CodingDispositionBucket = "v1" | "follow_up" | "out_of_scope" | "infra";

export interface AdapterDisposition {
  readonly adapterType: string;
  readonly bucket: CodingDispositionBucket;
  /** The U5 sandbox provider key this adapter authenticates with, when it has one. */
  readonly provider?: string;
  /** Human-attributable reason, REQUIRED for `out_of_scope` + `infra` + `follow_up`. */
  readonly reason?: string;
}

/**
 * The disposition matrix — EXACTLY the registered adapter types
 * (`BUILTIN_ADAPTER_TYPES`). Adding/removing a registered type without updating
 * this map is caught by the static coverage lint (fail-closed on drift).
 */
export const CODING_ADAPTER_DISPOSITIONS: Readonly<Record<string, AdapterDisposition>> = {
  // v1 sandboxed (admit)
  claude_local: { adapterType: "claude_local", bucket: "v1", provider: "anthropic" },
  codex_local: { adapterType: "codex_local", bucket: "v1", provider: "openai" },

  // Follow-up (recorded, not admitted yet)
  gemini_local: {
    adapterType: "gemini_local",
    bucket: "follow_up",
    provider: "gemini",
    reason: "follow-up: local CLI with a #320-threaded sandbox provider key; admit once in-VM MCP staging + model→provider mapping are proven",
  },
  opencode_local: {
    adapterType: "opencode_local",
    bucket: "follow_up",
    reason: "follow-up: local CLI (model-prefix provider); admit once in-VM MCP staging + model→provider mapping are proven",
  },
  cursor: {
    adapterType: "cursor",
    bucket: "follow_up",
    provider: "cursor",
    reason: "follow-up: local CLI with its own account key; admit once in-VM MCP staging + model→provider mapping are proven",
  },
  grok_local: {
    adapterType: "grok_local",
    bucket: "follow_up",
    provider: "xai",
    reason: "follow-up: local CLI with a #320-threaded sandbox provider key; admit once in-VM MCP staging + model→provider mapping are proven",
  },
  pi_local: {
    adapterType: "pi_local",
    bucket: "follow_up",
    reason: "follow-up: local CLI (model-prefix provider); admit once in-VM MCP staging + model→provider mapping are proven",
  },

  // Out of scope for the sandbox path in v1 (fail closed under cloud_auth)
  acpx_local: {
    adapterType: "acpx_local",
    bucket: "out_of_scope",
    reason: "out of scope: local CLI with no sandbox provider-key mapping in the U5 allowlist",
  },
  openclaw: {
    adapterType: "openclaw",
    bucket: "out_of_scope",
    reason: "out of scope: local CLI with no sandbox provider-key mapping in the U5 allowlist",
  },
  cursor_cloud: {
    adapterType: "cursor_cloud",
    bucket: "out_of_scope",
    reason: "out of scope: executes on the Cursor cloud service, not a local CLI inside the VM",
  },
  openclaw_gateway: {
    adapterType: "openclaw_gateway",
    bucket: "out_of_scope",
    reason: "out of scope: gateway transport, not a CLI in the VM",
  },
  hermes_local: {
    adapterType: "hermes_local",
    bucket: "out_of_scope",
    reason: "out of scope: PAPERCLIP wire-protocol external-agent runtime, not a sandboxed CLI",
  },

  // Infra (outside the coding-CLI matrix)
  process: {
    adapterType: "process",
    bucket: "infra",
    reason: "infra: generic shell process, not a coding CLI",
  },
  http: {
    adapterType: "http",
    bucket: "infra",
    reason: "infra: HTTP webhook, not a coding CLI",
  },
};

/** Deployment modes on which the sandboxed cloud pool is the execution substrate. */
const CLOUD_SANDBOX_MODES: ReadonlySet<string> = new Set(["cloud_auth", "authenticated"]);

/**
 * True for a deployment mode whose runs execute in the SHARED CLOUD sandbox pool,
 * i.e. the modes where a Company's own model-provider key is resolved and staged
 * (Decision #104's 2026-08-08 amendment). Self-hosted modes are keyless: the CLI
 * uses its installed local login and no hosted key exists to stage.
 *
 * Exported so DAT-008's handle mint asks the SAME question this module already
 * asks, rather than carrying a second copy of the mode set that could drift.
 * NOTE this is deliberately NOT what `gateCodingAdapterDispatch` gates on — that
 * function admits on the adapter's v1 bucket and uses the mode only to phrase its
 * rejection. The two gates are independent and a caller usually needs both.
 */
export function isCloudSandboxMode(deploymentMode: string): boolean {
  return CLOUD_SANDBOX_MODES.has(deploymentMode);
}

export interface DispositionGateDecision {
  readonly admitted: boolean;
  readonly disposition: AdapterDisposition;
  /** Attributable reason, present iff `admitted === false`. Never a silent fallback. */
  readonly rejectionReason?: string;
}

/** Look up a registered adapter's disposition; an UNKNOWN type is fail-closed
 * (treated as out_of_scope with an attributable reason). */
export function dispositionForAdapter(adapterType: string): AdapterDisposition {
  return (
    CODING_ADAPTER_DISPOSITIONS[adapterType] ?? {
      adapterType,
      bucket: "out_of_scope",
      reason: `out of scope: unregistered adapter type "${adapterType}" has no coding disposition`,
    }
  );
}

/**
 * The execute-path gate (CLI-002/D3). Runs BEFORE execution. Under a cloud
 * sandbox deployment it admits ONLY the v1 set; every other bucket (follow_up,
 * out_of_scope, infra, unknown) fails closed with an attributable reason — never a
 * silent host fallback. Non-cloud deployments do not use the sandboxed coding path,
 * so admission is likewise scoped to v1 (the gate is bucket-driven; the mode only
 * colours the reason for auditability).
 */
export function gateCodingAdapterDispatch(
  adapterType: string,
  deploymentMode: string,
): DispositionGateDecision {
  const disposition = dispositionForAdapter(adapterType);
  if (disposition.bucket === "v1") {
    return { admitted: true, disposition };
  }
  const modeNote = CLOUD_SANDBOX_MODES.has(deploymentMode)
    ? `under ${deploymentMode}`
    : `under ${deploymentMode} (sandboxed coding path)`;
  const because = disposition.reason ?? `bucket "${disposition.bucket}" is not admitted to the v1 sandboxed coding scope`;
  return {
    admitted: false,
    disposition,
    rejectionReason: `adapter "${adapterType}" is not in the v1 sandboxed coding scope ${modeNote}: ${because}`,
  };
}

// --- static disposition lint (mirrors the CLI-001 capability-matrix lint) -----

export interface DispositionCoverageResult {
  readonly ok: boolean;
  /** Registered types with no disposition entry (a fail-closed drift). */
  readonly undispositioned: readonly string[];
  /** Disposition entries for types NOT in the registry (stale/mis-typed). */
  readonly unregistered: readonly string[];
  /** Entries whose reason is required (non-v1) but missing/empty. */
  readonly missingReasons: readonly string[];
}

const VALID_BUCKETS: ReadonlySet<string> = new Set<CodingDispositionBucket>([
  "v1",
  "follow_up",
  "out_of_scope",
  "infra",
]);

/**
 * Assert every registered adapter type is dispositioned, no disposition is stale,
 * every non-v1 bucket carries an attributable reason, and every bucket value is
 * valid. `registeredTypes` is the registry's `BUILTIN_ADAPTER_TYPES` (passed in so
 * this stays a pure function the unit lint + the policy checker share).
 */
export function evaluateDispositionCoverage(
  registeredTypes: Iterable<string>,
  dispositions: Readonly<Record<string, AdapterDisposition>> = CODING_ADAPTER_DISPOSITIONS,
): DispositionCoverageResult {
  const registered = new Set(registeredTypes);
  const undispositioned: string[] = [];
  for (const type of registered) {
    if (!dispositions[type]) undispositioned.push(type);
  }
  const unregistered: string[] = [];
  const missingReasons: string[] = [];
  for (const [type, disp] of Object.entries(dispositions)) {
    if (!registered.has(type)) unregistered.push(type);
    if (!VALID_BUCKETS.has(disp.bucket)) {
      missingReasons.push(`${type}: invalid bucket "${disp.bucket}"`);
    }
    if (disp.bucket !== "v1" && (!disp.reason || disp.reason.trim().length === 0)) {
      missingReasons.push(`${type}: non-v1 bucket "${disp.bucket}" lacks an attributable reason`);
    }
  }
  return {
    ok: undispositioned.length === 0 && unregistered.length === 0 && missingReasons.length === 0,
    undispositioned: undispositioned.sort(),
    unregistered: unregistered.sort(),
    missingReasons: missingReasons.sort(),
  };
}
