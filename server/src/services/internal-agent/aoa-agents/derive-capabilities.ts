// T1.3 — per-agent capability derivation (per eng-review D4).
//
// Why this exists:
//   Before T1.3, runner.ts hardcoded `SUBAGENT_ENABLED_CAPABILITIES =
//   ["discussion_processing"]` for ALL crew agents. That broke any tool whose
//   category required a different capability:
//     - create_artifact (category 'action')  → needs 'system_actions'
//     - advance_phase   (category 'action')  → needs 'system_actions'
//     - notify_owner    (category 'action')  → needs 'system_actions'
//     - create_task / assign_task / add_task_dependency (category 'action')
//     - suggest_memory  (category 'memory')  → needs 'memory_management'
//   Every call to one of these tools failed closed with CAPABILITY_DISABLED
//   (see authorize-tool.ts CAPABILITY_TO_CATEGORY at lines 18-22). Net effect:
//   Maker couldn't create artifacts, Memory Keeper couldn't suggest memory,
//   Adjutant couldn't advance phase, Dispatcher couldn't create tasks.
//
// Why per-agent (not "just enable all three for everyone"):
//   The first instinct — broaden SUBAGENT_ENABLED_CAPABILITIES to include all
//   three — loses defense-in-depth. Router (post_entry only) would suddenly
//   have system_actions it never needs; if its allowlist was ever broadened
//   (or compromised), the capability gate would no longer be a second line of
//   defense. Per-agent derivation keeps the capability set tight: Maker gets
//   system_actions because its allowlist contains create_artifact; Scribe
//   doesn't because its allowlist doesn't.
//
// Why category-based (not tool-name-based):
//   We already have a per-tool allowlist in runtimeConfig.aoa.toolAllowlist
//   (the FINE gate). The capability set is the COARSE gate — one notch up the
//   stack. Mapping category → capability is the cleanest expression of "what
//   class of work is this agent licensed to do." authorize-tool.ts's
//   CAPABILITY_TO_CATEGORY is the single source of truth for that mapping;
//   this derivation reads from it (don't duplicate the table — drift would
//   silently re-introduce the original bug).

import { CAPABILITY_TO_CATEGORY } from "../authorize-tool.js";
import type { AgentTool } from "../types.js";

/**
 * The capability every AoA crew agent always gets. The runner extends this
 * with category-derived grants from the agent's toolAllowlist.
 *
 * Why always-on: every crew agent reads/writes discussion entries
 * (submit_extracted_items, post_entry, query_thread, ...). Dropping the
 * baseline would force per-role configuration of something that's universally
 * needed — pure friction for no security gain.
 */
const BASELINE_CAPABILITIES: readonly string[] = ["discussion_processing"];

/**
 * Given an agent's toolAllowlist (from runtimeConfig.aoa.toolAllowlist) and
 * the full tool registry, derive which capability strings the runner should
 * enable for this agent's subagent session.
 *
 * - Pure function. No DB reads, no side effects. Exhaustively unit-tested
 *   in derive-capabilities.test.ts.
 * - Unknown tool names in the allowlist are IGNORED (fail closed — never
 *   silently grant a capability for a tool that doesn't exist).
 * - Categories not in CAPABILITY_TO_CATEGORY (query/file/workflow/coordination
 *   /analysis) confer NO capability — those categories are always-allowed and
 *   the authorize gate skips them entirely.
 *
 * Returns capabilities in a stable order (baseline first, then added grants
 * sorted alphabetically) so two runs of the same agent produce byte-identical
 * bridge configs — incident-response log diffing actually works.
 */
export function deriveEnabledCapabilities(
  toolAllowlist: readonly string[],
  registry: readonly AgentTool[],
): readonly string[] {
  // Invert CAPABILITY_TO_CATEGORY into a category → capability lookup. Build
  // once per call; this is microseconds on a Partial<Record> with 3 entries
  // — not worth a module-level cache.
  const categoryToCapability = new Map<string, string>();
  for (const [cap, category] of Object.entries(CAPABILITY_TO_CATEGORY)) {
    if (category) categoryToCapability.set(category, cap);
  }

  // Build a name → category lookup over the registry once so the inner loop
  // is O(1) per tool name instead of O(registry.length).
  const toolCategoryByName = new Map<string, string>();
  for (const tool of registry) {
    toolCategoryByName.set(tool.name, tool.category);
  }

  const granted = new Set<string>(BASELINE_CAPABILITIES);
  for (const toolName of toolAllowlist) {
    const category = toolCategoryByName.get(toolName);
    if (!category) continue; // unknown tool → ignore (fail closed)
    const cap = categoryToCapability.get(category);
    if (cap) granted.add(cap);
  }

  // Stable order: baseline first, then any added grants sorted. This makes
  // log diffs noiseless across runs of the same agent.
  const baseline = [...BASELINE_CAPABILITIES];
  const added = [...granted].filter((c) => !BASELINE_CAPABILITIES.includes(c)).sort();
  return [...baseline, ...added];
}
