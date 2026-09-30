export const type = "hermes_local";
export const label = "Hermes Agent";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

export const models = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (Anthropic)" },
  { id: "anthropic/claude-opus-4", label: "Claude Opus 4 (Anthropic)" },
  { id: "openai/gpt-4.1", label: "GPT-4.1 (OpenAI)" },
  { id: "openai/o3", label: "o3 (OpenAI)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (Google)" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
  { id: "anthropic/claude-haiku-3.5", label: "Claude Haiku 3.5 (Anthropic)" },
];

export const agentConfigurationDoc = `# Hermes Agent Configuration

Hermes runs locally through the \`hermes chat\` CLI. Install Hermes and configure its model credentials on the host.

Options: \`model\`, \`provider\`, \`timeoutSec\` (default 300), \`graceSec\` (default 10), \`toolsets\`, \`enabledToolsets\`, \`persistSession\` (default true), \`worktreeMode\`, \`checkpoints\`, \`quiet\`, \`verbose\`, \`hermesCommand\` (default \`hermes\`), \`extraArgs\`, \`env\`, \`cwd\`, and \`promptTemplate\`.

Prompt variables: \`{{agentId}}\`, \`{{agentName}}\`, \`{{companyId}}\`, \`{{companyName}}\`, \`{{runId}}\`, \`{{taskId}}\`, \`{{taskTitle}}\`, \`{{taskBody}}\`, \`{{projectName}}\`, and \`{{aoaApiUrl}}\`.
The task environment provides \`AOA_API_URL\`, \`AOA_API_KEY\`, \`AOA_RUN_ID\`, and \`AOA_TASK_ID\` when available.
`;
