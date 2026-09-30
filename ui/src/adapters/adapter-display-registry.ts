import type { ComponentType } from "react";
import { Bot, Code, Cpu, Gem, MousePointer2, Sparkles, Terminal } from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";

const TYPE_SUFFIXES: Record<string, string> = {
  _local: "local",
  _gateway: "gateway",
};

export interface AdapterDisplayInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  acpx_local: {
    label: "ACPX",
    description: "Experimental local ACPX multi-agent adapter",
    icon: Bot,
    experimental: true,
  },
  claude_local: {
    label: "Claude Code",
    description: "Local Claude agent",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Local Codex agent",
    icon: Code,
    recommended: true,
  },
  opencode_local: {
    label: "OpenCode",
    description: "Local multi-provider agent",
    icon: OpenCodeLogoIcon,
  },
  cursor: {
    label: "Cursor",
    description: "Local Cursor agent",
    icon: MousePointer2,
  },
  openclaw: {
    label: "OpenClaw",
    description: "OpenClaw webhook/SSE adapter",
    icon: Bot,
  },
  hermes_local: {
    label: "Hermes",
    description: "Local Hermes CLI agent",
    icon: Terminal,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Local Gemini agent",
    icon: Gem,
  },
  grok_local: {
    label: "Grok Build",
    description: "Local Grok Build agent",
    icon: Bot,
  },
  pi_local: {
    label: "Pi",
    description: "Local Pi agent",
    icon: Terminal,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    description: "Managed remote Cursor agent",
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    description: "External gateway adapter",
    icon: Bot,
  },
  process: {
    label: "Process",
    description: "Advanced spawned-process adapter",
    icon: Cpu,
    experimental: true,
  },
  http: {
    label: "HTTP",
    description: "Advanced HTTP webhook adapter",
    icon: Cpu,
    experimental: true,
  },
};

function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(TYPE_SUFFIXES)) {
    if (type.endsWith(suffix)) return mode;
  }
  return null;
}

function withSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label} (${suffix})` : label;
}

function humanizeType(type: string): string {
  let base = type;
  for (const suffix of Object.keys(TYPE_SUFFIXES)) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  const base = adapterDisplayMap[type]?.label ?? humanizeType(type);
  return withSuffix(base, getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const type of Object.keys(adapterDisplayMap)) {
    labels[type] = getAdapterLabel(type);
  }
  return labels;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;
  const suffix = getTypeSuffix(type);
  return {
    label: withSuffix(humanizeType(type), suffix),
    description: suffix ? `External ${suffix} adapter` : "External adapter",
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
