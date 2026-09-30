import type { ServerAdapterModule } from "./types.js";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
} from "@armyofagents/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  SANDBOX_INSTALL_COMMAND as claudeSandboxInstallCommand,
} from "@armyofagents/adapter-claude-local";
import {
  execute as acpxExecute,
  listAcpxSkills,
  syncAcpxSkills,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
} from "@armyofagents/adapter-acpx-local/server";
import {
  agentConfigurationDoc as acpxAgentConfigurationDoc,
  models as acpxModels,
} from "@armyofagents/adapter-acpx-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
} from "@armyofagents/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  SANDBOX_INSTALL_COMMAND as codexSandboxInstallCommand,
} from "@armyofagents/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@armyofagents/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  SANDBOX_INSTALL_COMMAND as cursorSandboxInstallCommand,
} from "@armyofagents/adapter-cursor-local";
import {
  agentConfigurationDoc as cursorCloudAgentConfigurationDoc,
} from "@armyofagents/adapter-cursor-cloud";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@armyofagents/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  SANDBOX_INSTALL_COMMAND as openCodeSandboxInstallCommand,
} from "@armyofagents/adapter-opencode-local";
import {
  execute as openclawExecute,
  testEnvironment as openclawTestEnvironment,
  onHireApproved as openclawOnHireApproved,
} from "@armyofagents/adapter-openclaw/server";
import {
  agentConfigurationDoc as openclawAgentConfigurationDoc,
  models as openclawModels,
} from "@armyofagents/adapter-openclaw";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
  getConfigSchema as getOpenclawGatewayConfigSchema,
} from "@armyofagents/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@armyofagents/adapter-openclaw-gateway";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@armyofagents/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  SANDBOX_INSTALL_COMMAND as geminiSandboxInstallCommand,
} from "@armyofagents/adapter-gemini-local";
import {
  execute as grokExecute,
  listGrokSkills,
  syncGrokSkills,
  testEnvironment as grokTestEnvironment,
  sessionCodec as grokSessionCodec,
} from "@armyofagents/adapter-grok-local/server";
import {
  agentConfigurationDoc as grokAgentConfigurationDoc,
  models as grokModels,
} from "@armyofagents/adapter-grok-local";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@armyofagents/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  models as piModels,
  SANDBOX_INSTALL_COMMAND as piSandboxInstallCommand,
} from "@armyofagents/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import {
  parseObject,
  asString,
} from "@armyofagents/adapter-utils/server-utils";
import { getAdapterSessionManagement } from "@armyofagents/adapter-utils";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { getDisabledAdapterTypes, isAdapterDisabled } from "../services/adapter-plugin-store.js";

function buildNpmRuntimeCommandSpec(
  command: string,
  packageName: string | null,
  configuredCommand: unknown,
) {
  const installCommand = packageName
    ? `if ! command -v ${command} >/dev/null 2>&1; then npm install -g ${packageName}; fi`
    : null;
  return buildRuntimeCommandSpec(command, installCommand, configuredCommand);
}

function buildRuntimeCommandSpec(
  command: string,
  installCommand: string | null,
  configuredCommand: unknown,
) {
  const resolved = asString(configuredCommand, command).trim() || command;
  return {
    command: resolved,
    detectCommand: `command -v ${resolved}`,
    installCommand: resolved === command ? installCommand : null,
  };
}

function normalizeServerAdapter(adapter: ServerAdapterModule): ServerAdapterModule {
  if (adapter.sessionManagement) return adapter;
  const sessionManagement = getAdapterSessionManagement(adapter.type);
  return sessionManagement ? { ...adapter, sessionManagement } : adapter;
}

// Local/provider CLI adapters persist a durable question and return control to
// the scheduler. They do not claim same-session relay unless an adapter has a
// real broker implementation and explicitly opts into the stricter capability
// contract. This keeps the UI and continuation path honest for every provider.
const PARKED_HUMAN_QUESTION_CAPABILITIES = {
  mode: "ask_and_park",
  preservesProducerInvocationId: true,
} as const;

function normalizeCursorCloudSession(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const cursorAgentId =
    asString(record.cursorAgentId, "").trim() ||
    asString(record.agentId, "").trim() ||
    asString(record.sessionId, "").trim();
  if (!cursorAgentId) return null;
  const latestRunId = asString(record.latestRunId ?? record.runId, "").trim();
  const runtime = asString(record.runtime, "cloud").trim() || "cloud";
  const envType = asString(record.envType, "").trim();
  const envName = asString(record.envName, "").trim();
  const repos = Array.isArray(record.repos)
    ? record.repos
        .map((entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : null
        )
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => {
          const url = asString(entry.url, "").trim();
          const startingRef = asString(entry.startingRef, "").trim();
          const prUrl = asString(entry.prUrl, "").trim();
          return {
            url,
            ...(startingRef ? { startingRef } : {}),
            ...(prUrl ? { prUrl } : {}),
          };
        })
        .filter((entry) => entry.url.length > 0)
    : [];
  return {
    cursorAgentId,
    ...(latestRunId ? { latestRunId } : {}),
    runtime,
    ...(envType ? { envType } : {}),
    ...(envName ? { envName } : {}),
    ...(repos.length > 0 ? { repos } : {}),
  };
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  models: claudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("claude", claudeSandboxInstallCommand, config.command),
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  models: acpxModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: async () => getAcpxConfigSchema(),
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec("acpx", "acpx", config.command),
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("codex", codexSandboxInstallCommand, config.command),
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("agent", cursorSandboxInstallCommand, config.command),
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: async (ctx) => {
    const { execute } = await import("@armyofagents/adapter-cursor-cloud/server");
    return execute(ctx);
  },
  testEnvironment: async (ctx) => {
    const { testEnvironment } = await import("@armyofagents/adapter-cursor-cloud/server");
    return testEnvironment(ctx);
  },
  sessionCodec: {
    deserialize: normalizeCursorCloudSession,
    serialize: normalizeCursorCloudSession,
    getDisplayId: (serialized) => normalizeCursorCloudSession(serialized)?.cursorAgentId as string | null,
  },
  models: [],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: async () => {
    const { getConfigSchema } = await import("@armyofagents/adapter-cursor-cloud/server");
    return getConfigSchema();
  },
};

const openclawAdapter: ServerAdapterModule = {
  type: "openclaw",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: openclawExecute,
  testEnvironment: openclawTestEnvironment,
  onHireApproved: openclawOnHireApproved,
  models: openclawModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: openclawAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec("openclaw", null, config.command),
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("opencode", openCodeSandboxInstallCommand, config.command),
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
  getConfigSchema: async () => getOpenclawGatewayConfigSchema(),
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("gemini", geminiSandboxInstallCommand, config.command),
};

const grokLocalAdapter: ServerAdapterModule = {
  type: "grok_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: grokExecute,
  testEnvironment: grokTestEnvironment,
  listSkills: listGrokSkills,
  syncSkills: syncGrokSkills,
  sessionCodec: grokSessionCodec,
  models: grokModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: grokAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("grok", null, config.command),
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  models: piModels,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
  getRuntimeCommandSpec: (config) =>
    buildRuntimeCommandSpec("pi", piSandboxInstallCommand, config.command),
};

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  humanQuestionCapabilities: PARKED_HUMAN_QUESTION_CAPABILITIES,
  execute: async (ctx) => {
    // Hermes reads its config from ctx.agent.adapterConfig — build a patched
    // agent object so env injection flows through to the child process.
    // Spread to avoid mutating the original adapterConfig object.
    const agentConfig = { ...parseObject(ctx.agent?.adapterConfig) } as Record<string, unknown>;
    // parseObject returns Record<string, unknown> — do NOT cast to Record<string, string>.
    // Build nextEnv with explicit per-value coercion so non-string env values
    // (numbers, booleans, objects) cannot silently slip through to the child process.
    const env = parseObject(agentConfig.env);
    const nextEnv: Record<string, string> = {};
    for (const [k, val] of Object.entries(env)) {
      const s = asString(val, "");
      nextEnv[k] = s;
    }

    // Always inject PAPERCLIP_RUN_ID.
    // PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID are wire-protocol contracts with
    // hermes-paperclip-adapter — do NOT rename these to AOA_*.
    nextEnv.PAPERCLIP_RUN_ID = ctx.runId;

    // Inject PAPERCLIP_API_KEY from agent JWT only when not explicitly
    // configured — an explicit key takes precedence over the JWT.
    const explicitApiKey = asString(env.PAPERCLIP_API_KEY, "").trim();
    if (!explicitApiKey && ctx.authToken) {
      nextEnv.PAPERCLIP_API_KEY = ctx.authToken;
    }
    agentConfig.env = nextEnv;

    // Honor hermesCommand override (preferred); fall back to legacy "command"
    // field for back-compat with agents saved before this rename.
    const hermesCommand = asString(
      agentConfig.hermesCommand ?? agentConfig.command,
      "hermes",
    );
    agentConfig.hermesCommand = hermesCommand;

    const patchedAgent = { ...ctx.agent, adapterConfig: agentConfig };
    return hermesExecute({ ...ctx, agent: patchedAgent });
  },
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAdapterModule>(
  [claudeLocalAdapter, acpxLocalAdapter, codexLocalAdapter, openCodeLocalAdapter, cursorLocalAdapter, cursorCloudAdapter, openclawAdapter, openclawGatewayAdapter, geminiLocalAdapter, grokLocalAdapter, piLocalAdapter, hermesLocalAdapter, processAdapter, httpAdapter]
    .map((a) => normalizeServerAdapter(a))
    .map((a) => [a.type, a]),
);

// Builtin adapters that have been replaced by an external adapter of the same
// type are stashed here so they can be restored when the override is paused or
// removed.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently paused. When paused,
// findActiveServerAdapter() returns the builtin fallback instead of the
// external adapter.
const pausedOverrides = new Set<string>();

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types
    return processAdapter;
  }
  return adapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

/**
 * Like findServerAdapter but respects paused overrides — if an external
 * adapter's override is currently paused, returns the original builtin.
 */
export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    return builtinFallbacks.get(type) ?? null;
  }
  return adaptersByType.get(type) ?? null;
}

/**
 * List adapters that are not currently disabled in the plugin store. Used for
 * agent-creation menus that should hide disabled adapters.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = new Set(getDisabledAdapterTypes());
  return listServerAdapters().filter((a) => !disabled.has(a.type));
}

/**
 * Register a (possibly external) adapter at runtime. If the adapter type
 * matches a builtin, the existing builtin is stashed in builtinFallbacks so
 * it can be restored when the override is paused or the external adapter is
 * unregistered.
 */
export function registerServerAdapter(adapter: ServerAdapterModule): void {
  const normalizedAdapter = normalizeServerAdapter(adapter);
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, normalizedAdapter);
}

/**
 * Unregister an adapter. If it was overriding a builtin, the builtin is
 * restored. process and http adapters cannot be unregistered. Pure builtins
 * (no override) are also left in place.
 */
export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    builtinFallbacks.delete(type);
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/**
 * Pause or resume an external adapter's override of a builtin type. Returns
 * true if the state changed. No-op (returns false) when the type has no
 * active external override — there's nothing to pause.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    return true;
  }
  return false;
}

// Surface disabled-state check so the route doesn't have to import the store
// directly — registry becomes the single source of truth for "is this adapter
// usable right now?".
export { isAdapterDisabled as isServerAdapterDisabled };
