// Re-export shared adapter-utils types. AoA server code imports from this
// shim so call sites don't need to change when adapter-utils is upgraded.
export type {
  AdapterAgent,
  AdapterRuntime,
  UsageSummary,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterExecutionContext,
  McpBridgeSpec,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestStatus,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestContext,
  AdapterSessionCodec,
  AdapterModel,
  AdapterSessionManagement,
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillOrigin,
  AdapterSkillSnapshot,
  AdapterSkillState,
  AdapterSkillSyncMode,
  NativeContextManagement,
  ResolvedSessionCompactionPolicy,
  SessionCompactionPolicy,
  AdapterModelProfile,
  AdapterConfigFieldType,
  AdapterConfigFieldSchema,
  AdapterConfigSchema,
} from "@armyofagents/adapter-utils";

import type {
  AdapterConfigSchema,
  AdapterModelProfile,
  AdapterSessionManagement,
  ServerAdapterModule as BaseServerAdapterModule,
} from "@armyofagents/adapter-utils";

/**
 * Extension of adapter-utils ServerAdapterModule with fields that have not
 * yet been ported upstream. Skills-related fields (listSkills, syncSkills,
 * supportsInstructionsBundle, requiresMaterializedRuntimeSkills,
 * instructionsPathKey) are now provided by the upstream type as of Phase I.2.
 */
export interface ServerAdapterModule extends BaseServerAdapterModule {
  sessionManagement?: AdapterSessionManagement;
  modelProfiles?: AdapterModelProfile[];
  listModelProfiles?: () => Promise<AdapterModelProfile[]>;
  getConfigSchema?: () => Promise<AdapterConfigSchema>;
  getQuotaWindows?: () => unknown;
  detectModel?: (...args: unknown[]) => unknown;
}
