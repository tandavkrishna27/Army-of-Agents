import type { CLIAdapterModule } from "@armyofagents/adapter-utils";
import { printClaudeStreamEvent } from "@armyofagents/adapter-claude-local/cli";
import { printCodexStreamEvent } from "@armyofagents/adapter-codex-local/cli";
import { printCursorStreamEvent } from "@armyofagents/adapter-cursor-local/cli";
import { printOpenCodeStreamEvent } from "@armyofagents/adapter-opencode-local/cli";
import { printOpenClawStreamEvent } from "@armyofagents/adapter-openclaw/cli";
import { printGeminiStreamEvent } from "@armyofagents/adapter-gemini-local/cli";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const claudeLocalCLIAdapter: CLIAdapterModule = {
  type: "claude_local",
  formatStdoutEvent: printClaudeStreamEvent,
};

const codexLocalCLIAdapter: CLIAdapterModule = {
  type: "codex_local",
  formatStdoutEvent: printCodexStreamEvent,
};

const openCodeLocalCLIAdapter: CLIAdapterModule = {
  type: "opencode_local",
  formatStdoutEvent: printOpenCodeStreamEvent,
};

const cursorLocalCLIAdapter: CLIAdapterModule = {
  type: "cursor",
  formatStdoutEvent: printCursorStreamEvent,
};

const openclawCLIAdapter: CLIAdapterModule = {
  type: "openclaw",
  formatStdoutEvent: printOpenClawStreamEvent,
};

const geminiLocalCLIAdapter: CLIAdapterModule = {
  type: "gemini_local",
  formatStdoutEvent: printGeminiStreamEvent,
};

const adaptersByType = new Map<string, CLIAdapterModule>(
  [claudeLocalCLIAdapter, codexLocalCLIAdapter, openCodeLocalCLIAdapter, cursorLocalCLIAdapter, openclawCLIAdapter, geminiLocalCLIAdapter, processCLIAdapter, httpCLIAdapter].map((a) => [a.type, a]),
);

export function getCLIAdapter(type: string): CLIAdapterModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
