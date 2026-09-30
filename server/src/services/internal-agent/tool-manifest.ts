import { createToolRegistry } from "./tool-registry.js";
import type { AgentTool, ToolCategory } from "./types.js";
// Build MCP-surface entries from the EXPORTED TOOL_DEFINITIONS (the authoritative
// schema list). Category is derived from the EXPORTED family handler maps.
// NOTE: askFounderToolHandlers is NOT re-exported from mcp/tools/index.ts — do not
// import it (it won't compile). The single ask_founder tool is categorized by name.
import {
  TOOL_DEFINITIONS,
  readToolHandlers,
  writeToolHandlers,
  documentToolHandlers,
  approvalToolHandlers,
  skillToolHandlers,
} from "../../mcp/tools/index.js";

export type ToolSurface = "commander" | "mcp";
export type ReadWrite = "read" | "write";

export interface ToolManifestEntry {
  name: string;
  surface: ToolSurface;
  category: string;
  readWrite: ReadWrite;
  requiredRole: "founder" | "team_lead" | "team_member" | null;
  description: string;
  /** Reserved for cross-surface mapping (scope §5 WS-0). Always null in R1. */
  mcpAlias: string | null;
}

// Commander read/write signal (advisory metadata for the cheat-sheet; real
// gating is in authorize-tool.ts). Biased safe: a tool is READ only when we are
// confident it does not mutate — pure-read categories, or an explicit read set
// within otherwise-mixed categories. Everything else is WRITE, so a mutating
// tool is never mislabeled "freely callable".
const READ_ONLY_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  "query",
  "file",
  "analysis",
]);
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  // memory reads
  "query_memory", "find_similar_memory", "detect_conflicts", "find_similar_memory_hnsw",
  "extract_memory_candidates", "extract_decisions", "extract_insights", "extract_references",
  // discussion reads
  "search_discussions", "extract_from_content",
  // coordination reads
  "query_dependency_chain", "hub.readCurationContext",
]);

function commanderReadWrite(tool: AgentTool): ReadWrite {
  if (READ_ONLY_CATEGORIES.has(tool.category)) return "read";
  if (READ_TOOL_NAMES.has(tool.name)) return "read";
  return "write";
}

function mcpCategory(name: string): string {
  if (name in readToolHandlers) return "read";
  if (name in writeToolHandlers) return "write";
  if (name in documentToolHandlers) return "document";
  if (name in approvalToolHandlers) return "approval";
  if (name in skillToolHandlers) return "skill";
  if (name === "ask_human" || name === "ask_founder") return "ask";
  return "other";
}

// MCP write-signal heuristic (advisory; scope §5 WS-0 marks MCP fields
// "reserved"). read iff family=read OR name is a getter/list; else write.
function mcpReadWrite(name: string, category: string): ReadWrite {
  if (category === "read") return "read";
  if (/^(list-|get-)/.test(name) || name === "me") return "read";
  return "write";
}

export function buildToolManifest(): ToolManifestEntry[] {
  const commander: ToolManifestEntry[] = createToolRegistry().map((tool) => ({
    name: tool.name,
    surface: "commander",
    category: tool.category,
    readWrite: commanderReadWrite(tool),
    requiredRole: tool.requiredRole ?? null,
    description: tool.description,
    mcpAlias: null,
  }));

  const mcp: ToolManifestEntry[] = TOOL_DEFINITIONS.map((def) => {
    const category = mcpCategory(def.name);
    return {
      name: def.name,
      surface: "mcp",
      category,
      readWrite: mcpReadWrite(def.name, category),
      requiredRole: null,
      description: def.description,
      mcpAlias: null,
    };
  });

  // Stable ordering so serialization is deterministic (drift gate depends on it).
  return [...commander, ...mcp].sort((a, b) =>
    a.surface === b.surface
      ? a.name.localeCompare(b.name)
      : a.surface.localeCompare(b.surface),
  );
}

const CATEGORY_ORDER: readonly string[] = [
  "query",
  "action",
  "memory",
  "discussion",
  "workflow",
  "file",
  "coordination",
  "analysis",
];

const CATEGORY_HEADING: Record<string, string> = {
  query: "Query Tools (read-only, call freely)",
  action: "Action Tools (confirm before calling)",
  memory: "Memory Tools",
  discussion: "Discussion Tools",
  workflow: "Workflow Tools",
  file: "File Tools",
  coordination: "Coordination Tools",
  analysis: "Analysis Tools",
};

export function renderCommanderToolsMd(entries: ToolManifestEntry[]): string {
  const commander = entries.filter((t) => t.surface === "commander");
  for (const t of commander) {
    if (!t.name.trim() || !t.description.trim()) {
      throw new Error(`renderCommanderToolsMd: empty name/description for ${t.name}`);
    }
  }
  const byCat = new Map<string, ToolManifestEntry[]>();
  for (const t of commander) {
    (byCat.get(t.category) ?? byCat.set(t.category, []).get(t.category)!).push(t);
  }
  // Any category not in CATEGORY_ORDER is appended (alpha) so a new category
  // can never be silently dropped.
  const cats = [
    ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];

  const lines: string[] = [];
  lines.push("# Commander — Tool Reference");
  lines.push("");
  lines.push(
    "<!-- GENERATED — DO NOT EDIT. Run `pnpm gen:tools:md`. Source: packages/shared/src/generated/tools.json -->",
  );
  lines.push("");
  lines.push(
    `The ${commander.length} tools below are your complete set, generated from the live tool registry. Only call tools in this list; no other tool names exist.`,
  );
  lines.push("");
  lines.push(
    "**Tool naming convention.** Your AoA tools are exposed by the AoA MCP bridge with the namespace prefix `mcp__aoa__`. Inside this file the tools are written without the prefix for readability (e.g. `query_tasks`); when you invoke a tool call the prefixed form (`mcp__aoa__query_tasks`).",
  );
  lines.push("");
  for (const cat of cats) {
    lines.push(`## ${CATEGORY_HEADING[cat] ?? cat}`);
    lines.push("");
    lines.push("| Tool | R/W | Min role | What it does |");
    lines.push("|------|-----|----------|--------------|");
    for (const t of byCat.get(cat)!.sort((a, b) => a.name.localeCompare(b.name))) {
      const role = t.requiredRole ?? "any";
      const desc = t.description.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
      lines.push(`| \`${t.name}\` | ${t.readWrite} | ${role} | ${desc} |`);
    }
    lines.push("");
  }
  lines.push("## Usage Rules");
  lines.push("");
  lines.push(
    "1. **Never guess a tool name.** The tools above are your complete set. If a skill references a tool not on this list, flag it — don't attempt the call.",
  );
  lines.push("2. **Query before action.** Call read tools to gather current state before any write.");
  lines.push(
    "3. **Confirm before write.** All write tools require confirmation via ⚡OPTIONS⚡ unless a loaded skill grants auto-execute for the step.",
  );
  lines.push(
    "4. **Memory governance.** `suggest_memory` → PENDING. Use `detect_conflicts` before proposing memory that might contradict existing items.",
  );
  lines.push("");
  return lines.join("\n");
}

export function serializeToolManifest(entries: ToolManifestEntry[]): string {
  return (
    JSON.stringify(
      {
        $generated:
          "DO NOT EDIT — run `pnpm gen:tools`. Source: createToolRegistry() + mcp TOOL_DEFINITIONS.",
        version: 1,
        tools: entries,
      },
      null,
      2,
    ) + "\n"
  );
}
