/**
 * Provider catalog — the single source of truth for credentialed runtimes.
 *
 * UI-safe: contains only serialisable metadata. Server-side runners (login
 * spawn, authHome resolution) are attached separately in
 * server/src/services/providers/provider-registry.ts.
 *
 * Scope: this is the source of truth for the Settings -> Providers surface
 * (install / auth status / key storage). It does NOT yet subsume the older
 * provider enums that serve other surfaces — `COMMANDER_PROVIDERS` and
 * `CREW_PROVIDERS` in ../provider-mapping.ts still drive Commander's cliTool
 * picker and crew adapter selection. Those overlap this catalog and are pinned
 * against it by test (see the provider-mapping parity test); collapsing them is
 * a later task.
 *
 * Excluded deliberately: hermes_local (JWT wire protocol, not a user
 * credential), openclaw/openclaw_gateway (per-agent endpoint token), process and
 * http (no auth). acpx_local inherits Claude/Codex and is rendered as such.
 * The exclusion list is mirrored — with reasons — in the catalog test, which
 * fails if a new adapter appears in AGENT_ADAPTER_TYPES without being triaged.
 *
 * Install hints and login commands here are VERIFIED against this repo's own
 * adapter packages (`SANDBOX_INSTALL_COMMAND`, each adapter's `login.ts` spawn
 * args) and against the npm registry. Where a package could not be confirmed
 * the hint points at vendor docs instead — a wrong install command is worse
 * than "see docs".
 */
import type { AgentAdapterType } from "../constants.js";

export type ProviderKind = "local_cli" | "managed_api";

/**
 * Provider ids, declared as an array so downstream tasks can build a zod enum
 * (`z.enum(PROVIDER_IDS)`) instead of hardcoding a second list. Pinned against
 * PROVIDER_CATALOG by test — the two cannot drift.
 *
 * NOTE: this is declared separately rather than derived from PROVIDER_CATALOG
 * because ProviderDescriptor references ProviderId (via `credentialOwnerId`),
 * and deriving the union from a catalog that `satisfies ProviderDescriptor[]`
 * would be a circular type reference.
 */
export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "cursor",
  "cursor_cloud",
  "opencode",
  "grok",
  "pi",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Secret names OUTSIDE the `provider:*` namespace that already bind these env
 * vars, with the code that writes them. These are deliberately separate
 * mechanisms, not accidents:
 *
 *   - `llm:<provider>`     — hosted LLM/embeddings key (Settings -> Memory;
 *                            CLAUDE.md Rule #11). Written/read by
 *                            server/src/services/internal-agent/providers/index.ts
 *                            and server/src/adapters/api-common.ts.
 *   - `<ENV_VAR>`          — legacy env-style secret name, still read by
 *                            PROVIDER_SECRET_NAMES in the same file.
 *   - `Commander <p> API key` — bound into the Commander AGENT's
 *                            adapterConfig.env, not company-wide. Written by
 *                            server/src/services/commander-key.ts.
 *   - `provider:<id>`      — THIS catalog: the company-level default injected
 *                            into adapter env.
 *
 * They legitimately coexist because they target different scopes. What is NOT
 * acceptable is that coexistence being invisible: a founder who pasted an
 * Anthropic key during Commander onboarding must not be shown an empty input on
 * the Providers tab that invites a duplicate paste (which would leave one of the
 * two stale after rotation).
 *
 * REQUIREMENT FOR TASK 7/9: the Providers tab must DETECT a pre-existing key for
 * an env var from ANY binding listed here and render it as already-configured.
 * Adding a fifth binding must trip the pinning test in this module's test file.
 */
export const KNOWN_EXTERNAL_SECRET_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  ANTHROPIC_API_KEY: ["llm:anthropic", "ANTHROPIC_API_KEY", "Commander anthropic API key"],
  OPENAI_API_KEY: ["llm:openai", "OPENAI_API_KEY", "Commander openai API key"],
};

export interface ProviderApiKeySpec {
  envVar: string;
  /**
   * Reserved `provider:*` namespace. Providers sharing a credential (Cursor +
   * Cursor Cloud both use CURSOR_API_KEY) MUST share this exact name so one save
   * satisfies both — see `credentialOwnerId`.
   *
   * This uniqueness rule holds WITHIN this catalog. Other subsystems bind the
   * same env vars under different names by design — see
   * KNOWN_EXTERNAL_SECRET_BINDINGS above.
   */
  secretName: string;
  placeholder: string;
  /**
   * Other env vars this provider also accepts (Gemini: GOOGLE_API_KEY; GCA
   * OAuth). READ-ONLY: v1 stores only `envVar`, and nothing may ever be written
   * under an alternative. They are surfaced in the UI so a founder authenticated
   * another way understands why the probe still passes.
   */
  alternativeEnvVars?: readonly string[];
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  adapterType: AgentAdapterType;
  kind: ProviderKind;
  credential: {
    apiKey?: ProviderApiKeySpec;
    /**
     * Set when this provider READS a credential another provider OWNS. The UI
     * must render a link to the owner's card, not a second input — two inputs
     * writing one secret means saving either silently overwrites the other.
     */
    credentialOwnerId?: ProviderId;
    /** True only when an in-app login exists AND can finish without a terminal. */
    selfCompletingLogin: boolean;
    /** Shown when login is not self-completing (copyable). */
    manualLoginCommand?: string;
  };
  /** Omitted for managed runtimes that require no local install. */
  installHint?: { mac: string; win: string; linux: string; docsUrl?: string };
}

/**
 * Leading tokens of a hint the founder can actually paste into a terminal.
 *
 * Some `installHint` entries are PROSE pointing at docs ("See the OpenCode docs
 * for Windows install.") rather than commands — every Grok platform, plus
 * `cursor.win` and `opencode.win`. A UI that renders both identically inside a
 * `<code>` block under "run this" invites the founder to paste an English
 * sentence into a shell.
 *
 * This predicate is the ONE place that distinction is drawn: the catalog test
 * uses it to require a `docsUrl` behind every non-command hint, and the
 * Providers card uses it to choose between a copyable command and a docs link.
 * Two separately-maintained regexes would be exactly the drift this catalog
 * exists to prevent.
 */
const RUNNABLE_INSTALL_PREFIX =
  /^(npm|npx|pnpm|yarn|curl|wget|brew|winget|scoop|choco|pip|pipx|sh|bash) /;

export function isRunnableInstallCommand(hint: string): boolean {
  return RUNNABLE_INSTALL_PREFIX.test(hint);
}

const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
const CODEX_INSTALL = "npm install -g @openai/codex";
const GEMINI_INSTALL = "npm install -g @google/gemini-cli";
// Pinned to match the adapter's own SANDBOX_INSTALL_COMMAND
// (packages/adapters/pi-local/src/index.ts). The adapter pins deliberately:
// unpinned latest can install a CLI whose flags this adapter does not drive.
// Bump both together.
const PI_INSTALL = "npm install -g @earendil-works/pi-coding-agent@0.74.0";
const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";
const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/install | bash";

export const PROVIDER_CATALOG = [
  {
    id: "anthropic",
    label: "Claude",
    adapterType: "claude_local",
    kind: "local_cli",
    credential: {
      apiKey: {
        envVar: "ANTHROPIC_API_KEY",
        secretName: "provider:anthropic",
        placeholder: "sk-ant-…",
      },
      // `claude auth login` redirects to a REMOTE callback and then blocks on a
      // "Paste code here" stdin prompt, so it cannot finish in-app yet.
      selfCompletingLogin: false,
      // Verified against the actual spawn args in
      // packages/adapters/claude-local/src/server/login.ts (`["auth", "login"]`).
      // There is NO `claude login` — it just prints "Please run /login" and exits.
      manualLoginCommand: "claude auth login",
    },
    installHint: { mac: CLAUDE_INSTALL, win: CLAUDE_INSTALL, linux: CLAUDE_INSTALL },
  },
  {
    id: "openai",
    label: "Codex",
    adapterType: "codex_local",
    kind: "local_cli",
    credential: {
      apiKey: { envVar: "OPENAI_API_KEY", secretName: "provider:openai", placeholder: "sk-…" },
      // `codex login` self-completes via a local callback — the only one wired.
      selfCompletingLogin: true,
      // Present DESPITE selfCompletingLogin, because self-completing describes
      // the provider, not the surface. A consumer that renders no in-app login
      // button (the agent-config badge passes no handler) would otherwise leave a
      // "Needs sign-in" Codex card with no remediation at all. This is the
      // terminal fallback for those surfaces.
      manualLoginCommand: "codex login",
    },
    installHint: { mac: CODEX_INSTALL, win: CODEX_INSTALL, linux: CODEX_INSTALL },
  },
  {
    id: "google",
    label: "Gemini",
    adapterType: "gemini_local",
    kind: "local_cli",
    credential: {
      apiKey: {
        envVar: "GEMINI_API_KEY",
        secretName: "provider:google",
        placeholder: "AIza…",
        alternativeEnvVars: ["GOOGLE_API_KEY"], // plus GCA OAuth (GOOGLE_GENAI_USE_GCA)
      },
      selfCompletingLogin: false,
      manualLoginCommand: "gemini auth login",
    },
    installHint: { mac: GEMINI_INSTALL, win: GEMINI_INSTALL, linux: GEMINI_INSTALL },
  },
  {
    id: "cursor",
    label: "Cursor",
    adapterType: "cursor",
    kind: "local_cli",
    credential: {
      apiKey: {
        envVar: "CURSOR_API_KEY",
        secretName: "provider:cursor",
        placeholder: "key_…",
        // cursor-local/src/server/execute.ts also accepts OPENAI_API_KEY.
        alternativeEnvVars: ["OPENAI_API_KEY"],
      },
      selfCompletingLogin: false,
      manualLoginCommand: "agent login",
    },
    installHint: {
      mac: CURSOR_INSTALL,
      // The vendor installer is a POSIX shell script; no confirmed Windows form.
      win: "See the Cursor CLI docs for Windows install.",
      linux: CURSOR_INSTALL,
      docsUrl: "https://cursor.com/docs/cli",
    },
  },
  {
    id: "cursor_cloud",
    label: "Cursor Cloud",
    adapterType: "cursor_cloud",
    kind: "managed_api",
    credential: {
      // BORROWS Cursor's credential: same env var, so the SAME secretName on
      // purpose. Do not "fix" this to provider:cursor_cloud.
      apiKey: { envVar: "CURSOR_API_KEY", secretName: "provider:cursor", placeholder: "key_…" },
      credentialOwnerId: "cursor",
      selfCompletingLogin: false,
    },
    // No installHint: managed remote runtime, nothing to install.
  },
  {
    id: "opencode",
    label: "OpenCode",
    adapterType: "opencode_local",
    kind: "local_cli",
    // OpenCode brokers per-provider credentials through its own auth store;
    // there is no single OPENCODE_API_KEY to store here.
    credential: { selfCompletingLogin: false, manualLoginCommand: "opencode auth login" },
    installHint: {
      mac: OPENCODE_INSTALL,
      win: "See the OpenCode docs for Windows install.",
      linux: OPENCODE_INSTALL,
      docsUrl: "https://opencode.ai/docs",
    },
  },
  {
    id: "grok",
    label: "Grok Build",
    adapterType: "grok_local",
    kind: "local_cli",
    credential: {
      // XAI_API_KEY belongs to Grok, not Pi — grok-local/src/server/execute.ts
      // switches to "api" auth mode exactly when XAI_API_KEY is present.
      apiKey: { envVar: "XAI_API_KEY", secretName: "provider:grok", placeholder: "xai-…" },
      selfCompletingLogin: false,
      manualLoginCommand: "grok login",
    },
    installHint: {
      // No official xAI Grok CLI package exists on npm (every `grok-cli` hit is a
      // third-party fork), and this repo's adapter declares no install command.
      // Point at docs rather than ship something unverified.
      mac: "See the xAI Grok CLI docs for install instructions.",
      win: "See the xAI Grok CLI docs for install instructions.",
      linux: "See the xAI Grok CLI docs for install instructions.",
      docsUrl: "https://docs.x.ai",
    },
  },
  {
    id: "pi",
    label: "Pi",
    adapterType: "pi_local",
    kind: "local_cli",
    credential: {
      // BORROWS Claude's credential: Pi is provider-agnostic and runs on
      // someone else's key (pi-local/src/server/test.ts names ANTHROPIC_API_KEY
      // and XAI_API_KEY). Saving here writes the SHARED provider:anthropic
      // secret, which claude_local also reads — and where a stored API key
      // OVERRIDES subscription auth (`claude_anthropic_api_key_overrides_
      // subscription` in claude-local/src/server/test.ts). `credentialOwnerId`
      // is what tells the UI to link to Claude's card instead of showing a
      // second input.
      apiKey: {
        envVar: "ANTHROPIC_API_KEY",
        secretName: "provider:anthropic",
        placeholder: "sk-ant-…",
        alternativeEnvVars: ["XAI_API_KEY"],
      },
      credentialOwnerId: "anthropic",
      selfCompletingLogin: false,
    },
    installHint: { mac: PI_INSTALL, win: PI_INSTALL, linux: PI_INSTALL },
  },
] satisfies readonly ProviderDescriptor[];

/**
 * @deprecated Alias of {@link PROVIDER_CATALOG}, kept only so an in-flight
 * consumer does not break. Iterate `PROVIDER_CATALOG` directly.
 *
 * (History: the catalog was briefly `as const`, which narrowed each entry so
 * optional fields did not exist on members that omit them and made iteration a
 * compile error. `as const` is no longer needed — `ProviderId` derives from
 * PROVIDER_IDS, not from the catalog — so the widened view is redundant.)
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = PROVIDER_CATALOG;

export function getProviderById(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function getProviderByAdapterType(adapterType: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.adapterType === adapterType);
}

/** The provider that actually owns this provider's stored credential. */
export function getCredentialOwner(provider: ProviderDescriptor): ProviderDescriptor {
  const ownerId = provider.credential.credentialOwnerId;
  return ownerId ? (getProviderById(ownerId) ?? provider) : provider;
}
