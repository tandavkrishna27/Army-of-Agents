export type {
  AdapterAgent,
  AdapterRuntime,
  UsageSummary,
  AdapterBillingType,
  AdapterExecutionTargetType,
  AdapterLocalExecutionTarget,
  AdapterDockerExecutionTarget,
  AdapterProviderSandboxRunInput,
  AdapterProviderSandboxRunner,
  AdapterProviderSandboxExecutionTarget,
  AdapterExecutionTarget,
  AdapterRuntimeCommandSpec,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
  AdapterInvocationMeta,
  AdapterModelProfileDefinition,
  AdapterExecutionContext,
  McpBridgeSpec,
  RuntimeHookBridgeSpec,
  AdapterRuntimeDecisionBroker,
  AdapterRuntimeDecisionPromptBase,
  AdapterRuntimeDecisionTimeoutPolicy,
  AdapterRuntimePermissionAnswer,
  AdapterRuntimePermissionDecision,
  AdapterRuntimePermissionPrompt,
  AdapterRuntimeWorkQuestionAnswer,
  AdapterRuntimeWorkQuestionPrompt,
  HumanQuestionRuntimeCapabilities,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestStatus,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestContext,
  AdapterSkillSyncMode,
  AdapterSkillState,
  AdapterSkillOrigin,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
  AdapterSkillContext,
  AdapterSessionCodec,
  AdapterModel,
  AdapterConfigFieldType,
  AdapterConfigFieldSchema,
  AdapterConfigSchema,
  HireApprovedPayload,
  HireApprovedHookResult,
  ServerAdapterModule,
  TranscriptEntry,
  StdoutLineParser,
  CLIAdapterModule,
  CreateConfigValues,
} from "./types.js";
export type { AdapterTargetProcessOptions } from "./execution-target.js";
export type { SandboxCallbackBridgeServer } from "./sandbox-callback-bridge.js";
export type {
  WorkspaceEntrySnapshot,
  WorkspaceSnapshot,
  CaptureWorkspaceSnapshotOptions,
  MergeChangedWorkspaceFilesOptions,
} from "./workspace-restore-merge.js";
export type {
  AdapterModelProfile,
} from "./model-profiles.js";
export type {
  SessionCompactionPolicy,
  NativeContextManagement,
  AdapterSessionManagement,
  ResolvedSessionCompactionPolicy,
} from "./session-compaction.js";
export {
  buildDockerRunArgs,
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetFile,
  formatDockerBindSource,
  isDockerAvailable,
  prepareWorkspaceForExecutionTarget,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTarget,
  runAdapterExecutionTargetShellCommand,
  runAdapterExecutionTargetProcess,
  runLocalTargetProcess,
  syncAdapterExecutionTargetDirectory,
  syncAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  maybeRunSandboxInstallCommand,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  startAdapterExecutionTargetPaperclipBridge,
} from "./execution-target.js";
export { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
export { buildSandboxEnvAllowlist } from "./sandbox-env-allowlist.js";
export {
  isAoaAmbientSecretEnvKey,
  aoaAmbientSecretEnvKeys,
} from "./aoa-secret-env.js";
export type { AoaAmbientSecretOptions } from "./aoa-secret-env.js";
export {
  stripConnectorRunBearers,
  CONNECTOR_STRIPPED_RUN_BEARER_KEYS,
} from "./server-utils.js";
export { preferredShellForSandbox } from "./sandbox-shell.js";
export {
  isAllowedAoaBridgeRequest,
  startSandboxCallbackBridgeServer,
  generateSandboxBridgeEntrypointInstallScript,
} from "./sandbox-callback-bridge.js";
export {
  captureWorkspaceSnapshot,
  mergeChangedWorkspaceFiles,
} from "./workspace-restore-merge.js";
export {
  findAdapterModelProfile,
  normalizeAdapterModelProfiles,
} from "./model-profiles.js";
export {
  buildNpmGlobalInstallIfMissingCommand,
  buildSandboxNpmInstallCommand,
  shellQuote,
} from "./sandbox-install.js";

export function inferOpenAiCompatibleBiller(
  env: Record<string, string>,
  fallback: string | null = null,
): string | null {
  if (env.OPENAI_API_KEY) return "openai";
  if (env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_ENDPOINT) return "azure_openai";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  return fallback;
}
export {
  ADAPTER_SESSION_MANAGEMENT,
  LEGACY_SESSIONED_ADAPTER_TYPES,
  getAdapterSessionManagement,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
  hasSessionCompactionThresholds,
} from "./session-compaction.js";
export {
  RUNTIME_HOOK_BLOCK_TIMEOUT_SEC,
  RUNTIME_HOOK_PATH,
} from "./runtime-hooks.js";
export { detectAuthFailure, isAuthFailure } from "./auth-failure-detector.js";
export type { AuthFailureKind, AuthFailureDetection } from "./auth-failure-detector.js";
export { extractVerificationUrl, createLoginUrlDetector, isLoopbackUrl } from "./login-url-detector.js";
export type { LoginUrlDetector } from "./login-url-detector.js";
export { runAuthStatusAndBranch } from "./auth-probe-branch.js";
export type { AuthProbeStatus, AuthProbeBranchOptions } from "./auth-probe-branch.js";
export {
  isStdioServerSpec,
  isHttpServerSpec,
  RESERVED_MCP_SERVER_NAMES,
  stripReservedMcpServerNames,
  reservedMcpServerNameCollisions,
  mergeExternalMcpServers,
  AOA_SECRET_PLACEHOLDER_PATTERN,
  containsAoaSecretPlaceholder,
  aoaSecretPlaceholderVars,
  aoaSecretPlaceholderFor,
  brokeredAoaHttpEntry,
  type BrokeredAoaHttpEntry,
  stdioSpecCarriesSecretPlaceholder,
  withSynthesizedBearerHeader,
} from "./mcp-server-spec.js";
export type {
  McpServerSpec,
  McpStdioServerSpec,
  McpHttpServerSpec,
  McpWriterSkipReason,
  McpWriterSkip,
  McpWriterResult,
} from "./mcp-server-spec.js";
export {
  AOA_MCP_MANIFEST_FILENAME,
  resolveMcpManagedManifestPath,
  tryResolveMcpManagedManifestPath,
  readAoaManagedServerNames,
  writeAoaManagedServerNames,
  tryWriteAoaManagedServerNames,
  removeLegacyCwdManifest,
  sweepAoaManagedEntries,
} from "./mcp-managed-manifest.js";
export type { McpManagedManifestScope } from "./mcp-managed-manifest.js";
