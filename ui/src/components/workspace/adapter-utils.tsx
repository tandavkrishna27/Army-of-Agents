// ui/src/components/workspace/adapter-utils.tsx
import { Sparkles, Brain, Gem, Terminal, Globe, Monitor, Bot } from "lucide-react";
import type { ComponentType } from "react";

type IconComponent = ComponentType<{ className?: string }>;

const ADAPTER_ICONS: Record<string, { icon: IconComponent; color: string; label: string }> = {
  claude_local: { icon: Sparkles, color: "text-purple-500", label: "Claude" },
  gemini_local: { icon: Gem, color: "text-blue-500", label: "Gemini" },
  opencode_local: { icon: Terminal, color: "text-gray-400", label: "OpenCode" },
  codex_local: { icon: Brain, color: "text-green-500", label: "Codex" },
  cursor: { icon: Monitor, color: "text-gray-400", label: "Cursor" },
  hermes_local: { icon: Terminal, color: "text-gray-400", label: "Hermes" },
  http: { icon: Globe, color: "text-gray-400", label: "HTTP" },
  process: { icon: Terminal, color: "text-gray-400", label: "Process" },
  openclaw: { icon: Bot, color: "text-gray-400", label: "OpenClaw" },
};

export function getAdapterInfo(adapterType: string) {
  return ADAPTER_ICONS[adapterType] ?? { icon: Bot, color: "text-gray-400", label: adapterType };
}

const MODEL_CONTEXT_LIMITS: Array<[string, number]> = [
  // Anthropic
  ["opus", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
  // OpenAI — order matters: mini before non-mini
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4", 128_000],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  ["o4-mini", 200_000],
  // Google
  ["2.5-pro", 1_000_000],
  ["2.5-flash", 1_000_000],
  ["2.0-flash", 1_000_000],
];

export function getContextLimit(modelId: string | null): number | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const [pattern, limit] of MODEL_CONTEXT_LIMITS) {
    if (lower.includes(pattern)) return limit;
  }
  return null;
}

/** Extract short model display name from full model ID. e.g. "claude-sonnet-4-20250514" → "Sonnet" */
export function shortModelName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";
  if (lower.includes("gpt-4o-mini")) return "GPT-4o Mini";
  if (lower.includes("gpt-4o")) return "GPT-4o";
  if (lower.includes("gpt-4")) return "GPT-4";
  if (lower.includes("o1-mini")) return "o1 Mini";
  if (lower.includes("o1")) return "o1";
  if (lower.includes("o3-mini")) return "o3 Mini";
  if (lower.includes("o3")) return "o3";
  if (lower.includes("o4-mini")) return "o4 Mini";
  if (lower.includes("o4")) return "o4";
  if (lower.includes("2.5-pro")) return "2.5 Pro";
  if (lower.includes("2.5-flash")) return "2.5 Flash";
  if (lower.includes("2.0-flash")) return "2.0 Flash";
  // Fallback: return last segment or full ID
  const parts = modelId.split(/[-/]/);
  return parts[parts.length - 1] ?? modelId;
}
