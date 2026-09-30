import { foldEnvKey } from "./server-utils.js";

/**
 * U5 — the from-scratch positive allowlist for what crosses into a sandboxed
 * (provider-sandbox / sandbox-docker) run's environment. Everything else the
 * host process happens to be carrying — DATABASE_URL, the secrets master key,
 * the GitHub PAT, Redis, etc. — is dropped even if a caller's overlay
 * accidentally carries it. This is the SINK-level guard: the caller BUILDS the
 * overlay (target.env merged with opts.env) and this function only FILTERS
 * it down to the allowlist (S2) — it never injects a credential itself.
 */

/** Provider auth env names, keyed by the resolved provider. The embeddings
 *  OPENAI_API_KEY is host-side only and never appears in a run overlay — so
 *  OPENAI_API_KEY is admissible ONLY for an openai-provider run (the agent's
 *  own resolved key), never for a claude run.
 *
 *  Wave 2 review (U5 regression fix): every CLI adapter must resolve a
 *  non-empty `sandboxProvider` at its `runAdapterExecutionTargetProcess` call
 *  site, or its own provider key gets silently stripped in a sandbox — see
 *  each adapter's execute.ts for the `sandboxProvider:` comment explaining
 *  its choice. `xai` (grok-local; also a real `provider/model` prefix for
 *  opencode-local/pi-local's model-catalog format, e.g. "xai/grok-4" per
 *  pi-local's own docs) and `cursor` (cursor-local — cursor-agent
 *  authenticates with ITS OWN account key regardless of which underlying
 *  model is selected; see cursor-local's `test.ts` readiness probe, which
 *  treats CURSOR_API_KEY as the sole canonical auth signal) were added here.
 *  cursor-local's billing-type heuristic also treats an operator-configured
 *  OPENAI_API_KEY as valid Cursor auth (BYOK), so it stays admissible for
 *  `cursor` too — gated to cursor runs only, never widening what an
 *  anthropic/gemini run can carry. */
const PROVIDER_AUTH_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  cursor: ["CURSOR_API_KEY", "OPENAI_API_KEY"],
};

/** Run-identity + control-plane credential env that MAY cross (§9). */
const ALWAYS_ALLOWED = new Set(
  [
    "AOA_API_KEY", "PAPERCLIP_API_KEY", // the run-JWT
    "AOA_API_URL", "PAPERCLIP_API_URL", "AOA_ORIGIN_API_URL", "AOA_CALLBACK_BRIDGE_URL",
    "AOA_RUN_ID", "PAPERCLIP_RUN_ID", "AOA_EXECUTION_TARGET_ID",
    "AOA_RUNTIME_HOOK_TOKEN",
    // in-VM managed homes. HOME itself is real-shape drift vs the plan's §9
    // list (which named CLAUDE_CONFIG_DIR/CODEX_HOME but not HOME): claude-local,
    // cursor-local, and pi-local all redirect `env.HOME` to the sandbox runtime
    // root dir behind the SAME adapterExecutionTargetUsesManagedHome() gate as
    // CLAUDE_CONFIG_DIR/CODEX_HOME (see execute.ts in each package) — it is the
    // isolation mechanism itself, not a credential, and dropping it would leave
    // the CLI reading the container's real $HOME instead of the isolated one.
    "MAX_THINKING_TOKENS", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME",
    // Real-shape drift vs the §9 taxonomy: this chokepoint's OWN caller
    // (runAdapterExecutionTargetProcess) pipes the allowlisted overlay straight
    // into shapeAoaWorkspaceEnvForExecution, which rewrites these exact keys
    // (local cwd -> execution cwd) for sandbox targets — see server-utils.ts
    // applyAoaWorkspaceEnv / refreshAoaWorkspaceEnvForExecution and
    // workspace-runtime.ts. They are path/id/url routing metadata for the
    // Execution Workspaces git-worktree system, never a credential (repo auth
    // is applied at clone time, not embedded in AOA_WORKSPACE_REPO_URL).
    // Dropping them here would silently break isolated-workspace sandbox runs
    // and make shapeAoaWorkspaceEnvForExecution's rewrite dead code, since the
    // allowlist runs BEFORE the shape step in both sandbox branches.
    "AOA_WORKSPACE_CWD", "AOA_WORKSPACE_SOURCE", "AOA_WORKSPACE_STRATEGY", "AOA_WORKSPACE_ID",
    "AOA_WORKSPACE_REPO_URL", "AOA_WORKSPACE_REPO_REF", "AOA_WORKSPACE_BRANCH",
    "AOA_WORKSPACE_WORKTREE_PATH", "AOA_WORKSPACES_JSON", "AGENT_HOME",
  ].map(foldEnvKey),
);

/** Prefix classes admissible in the VM (connector access-token bearers). */
const ALLOWED_PREFIXES = ["AOA_MCP_"].map(foldEnvKey);
const ALLOWED_TOKEN_SUFFIX = "_TOKEN"; // AOA_MCP_*_TOKEN only — never *_REFRESH

export function buildSandboxEnvAllowlist(
  overlay: Record<string, string>,
  opts: { provider: string },
): Record<string, string> {
  const providerKeys = new Set((PROVIDER_AUTH_KEYS[opts.provider] ?? []).map(foldEnvKey));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value !== "string") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // invalid env name (drops "mcp:oauth:*")
    const folded = foldEnvKey(key);
    const isConnectorToken =
      ALLOWED_PREFIXES.some((p) => folded.startsWith(p)) &&
      foldEnvKey(ALLOWED_TOKEN_SUFFIX) === folded.slice(-ALLOWED_TOKEN_SUFFIX.length);
    if (ALWAYS_ALLOWED.has(folded) || providerKeys.has(folded) || isConnectorToken) {
      out[key] = value;
    }
  }
  return out;
}
