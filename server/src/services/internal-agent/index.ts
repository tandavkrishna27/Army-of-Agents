export type {
  AgentTool,
  ToolContext,
  ToolResult,
  ToolCategory,
  ServiceContainer,
  JsonSchema,
} from "./types.js";

export { createServiceContainer } from "./service-container.js";

export {
  createToolRegistry,
  getToolsForMessage,
  toolToAnthropicFormat,
  toolToOpenAIFormat,
  executeTool,
} from "./tool-registry.js";

export { contextAssemblyService } from "./context-assembly.js";
export { conversationService } from "./conversation.js";
export { agentLoopService } from "./agent-loop.js";
export type { AgentStreamChunk, ChatInput } from "./agent-loop.js";

export {
  blockedTaskScan,
  budgetThresholdAlert,
  staleWorkDetection,
  dependencyChainGaps,
  memoryConflictScan,
  workloadImbalance,
  morningDigest,
  checkReminders,
} from "./proactive.js";

export { createEventListener } from "./event-listener.js";
export type { EventTriggerResult } from "./event-listener.js";

export { cliModeService, detectCliTool, buildMcpConfig, toolToMcpFormat } from "./cli-mode.js";
export { createCLISessionStore } from "./cli-session-store.js";
export type { CLISession, CLIToolType, CLISessionStore } from "./cli-session-store.js";
export { createToolCallHandler, buildToolListResponse } from "./mcp-bridge.js";
export {
  canonicalRuntimeApprovalParams,
  hashRuntimeApprovalParams,
  runtimeApprovalService,
} from "./runtime-approvals.js";
