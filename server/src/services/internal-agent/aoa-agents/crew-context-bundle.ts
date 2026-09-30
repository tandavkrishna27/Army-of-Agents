/**
 * crew-context-bundle.ts — Phase 4 (Tasks 4.1 + 4.2).
 *
 * Assembles the dynamic context a crew agent arrives with so it NEVER "starts
 * blind". Before this, the trigger prompt's dynamic block was IDs only
 * (`Thread: <id>`, `Inviting entry: <id>`, `Mention: @Scout`), forcing an
 * @mentioned agent to fetch everything via tools — and it often answered
 * "no precedent found". This module fetches the conversation + the thread
 * summary + relevant memory (and, for tasks, the task body + the upstream
 * artifact) and renders them into one markdown string that the runner injects
 * as a `## Context` section in the trigger prompt.
 *
 * Single responsibility: "what should this agent know going in." DB in,
 * string out. It is BEST-EFFORT by contract — the runner wraps the call in
 * try/catch, and the memory pathway here degrades to nothing (never throws)
 * when embeddings/pgvector are absent (this instance has no `embedding`
 * column). See `memoryService(db).searchMultiPath` (memory.ts:378): its
 * semantic path is guarded behind `getDbCapabilities().hasVectorSupport` and
 * its keyword/temporal paths never touch the absent column → graceful degrade.
 *
 * Token budget mirrors `context-assembly.ts`: estimate = ceil(len / 4). When
 * over budget we drop the OLDEST thread entries first (recency is the most
 * useful signal for "what is being discussed right now"), then trim memory.
 */

import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  discussionEntries,
  discussions,
  agents,
  issues,
  projects,
  artifacts,
  artifactVersions,
  issueContextBundleItems,
  issueContextBundles,
} from "@armyofagents/db";
import { memoryService } from "../../memory.js";
import { filterMemoryForActor, type MemoryActor } from "../../memory-access.js";
import { actorForAgentRun, memoryAccessConditions } from "../../memory-access-sql.js";
import { recordMemoryRetrievals } from "../../memory-retrieval-audit.js";
import { buildAlwaysOnCore } from "../../memory-core-block.js";
import { isContextBundleItemIncluded } from "../../issue-context-bundles.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "crew-context-bundle" });

/** Default number of most-recent thread entries to include. */
const DEFAULT_ENTRY_LIMIT = 20;
/** Default token budget for the whole bundle (~2500 tokens ≈ 10k chars). */
const DEFAULT_TOKEN_BUDGET = 2500;
/** Memory items pulled per run. */
const MEMORY_LIMIT = 5;
/** Upstream artifact body cap (chars). */
const ARTIFACT_BODY_CAP = 2000;
/** Cap a single entry's rendered text so one huge paste can't eat the budget. */
const ENTRY_TEXT_CAP = 1200;
/** Cap the query text handed to memory search. */
const QUERY_TEXT_CAP = 600;

export interface BuildCrewContextBundleArgs {
  companyId: string;
  /** Thread (discussion) id — drives the THREAD branch. */
  threadId?: string;
  /** Issue id — drives the TASK branch. */
  issueId?: string;
  /** The agent receiving the context — drives per-agent RBAC + retrieval audit (P1-T4). */
  agentId: string;
  /**
   * Run id for retrieval auditing (P1-T4, scenario O4). The runner already holds it
   * for the loopback/summary comments. Null/undefined ⇒ the audit row carries no run
   * linkage (companyId + agentId still identify the retrieval).
   */
  runId?: string | null;
  /**
   * Agent role label for the always-on core (P1-T6). Caller-supplied (the runner
   * already holds the agent record) so the bundle needs no extra query. Falls back
   * to "agent" inside buildAlwaysOnCore when null/empty.
   */
  agentRole?: string | null;
  /**
   * Current goal title for the always-on core (P1-T6). Optional — omitted today on
   * the crew path (the bundle does not load the goal), so the crew core is role +
   * memory pointer. Wired as an arg so a future caller can supply it without a
   * signature change.
   */
  goalTitle?: string | null;
  /** Token budget (ceil(len/4)). Default ~2500. */
  tokenBudget?: number;
}

/** ceil(len / 4) — same estimate as context-assembly.ts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

interface ThreadContext {
  /** Chronological "<author>: <text>" lines, OLDEST first. */
  entryLines: string[];
  /** "Thread summary:" line(s) — summary text + routing terms. */
  summaryLines: string[];
  /** Best query text for memory search (latest entry text or the summary). */
  queryText: string;
  memoryFilters: MemoryScopeFilters;
}

interface MemoryScopeFilters {
  departmentId?: string;
  projectId?: string;
  goalId?: string;
}

function discussionScopeFilters(input: {
  scopeType?: string | null;
  scopeId?: string | null;
  goalId?: string | null;
}): MemoryScopeFilters {
  const filters: MemoryScopeFilters = {};
  if (input.scopeType === "department" && input.scopeId) {
    filters.departmentId = input.scopeId;
  }
  if (input.scopeType === "project" && input.scopeId) {
    filters.projectId = input.scopeId;
  }
  if (input.scopeType === "goal" && input.scopeId) {
    filters.goalId = input.scopeId;
  }
  if (input.goalId && !filters.goalId) {
    filters.goalId = input.goalId;
  }
  return filters;
}

/**
 * THREAD branch — fetch the last N entries (chronological) + the Chronicler
 * summary. Author label: the agent's display name when authored by an agent,
 * else "founder".
 */
async function loadThreadContext(
  db: Db,
  companyId: string,
  threadId: string,
  entryLimit: number,
): Promise<ThreadContext> {
  const empty: ThreadContext = {
    entryLines: [],
    summaryLines: [],
    queryText: "",
    memoryFilters: {},
  };

  // ── Tenant gate (cross-tenant read fix) ──────────────────────────────────
  // Company-scope the thread lookup, and do it FIRST — before any entries are
  // read. `discussion_entries` has NO companyId column; its only tenant
  // boundary is the parent `discussions` row. `threadId` reaches here from a
  // wakeup payload (see runner.ts / dispatcher.ts → agent.dispatch), which can
  // carry a caller-supplied id, so a thread belonging to another company must
  // be rejected HERE. Mirrors crew-workspace.ts's
  // `and(eq(discussions.id, threadId), eq(discussions.companyId, ...))`.
  // A miss — wrong company or a since-deleted thread — yields an empty context
  // so the bundle simply omits the thread section (fail closed, never throws:
  // the caller already treats the bundle as best-effort). Reading the
  // discussion first also means a foreign thread's entries are never fetched.
  const summaryRows = (await db
    .select({
      summaryText: discussions.summaryText,
      routingTerms: discussions.routingTerms,
      scopeType: discussions.scopeType,
      scopeId: discussions.scopeId,
      goalId: discussions.goalId,
    })
    .from(discussions)
    .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
    .limit(1)) as Array<{
    summaryText: string | null;
    routingTerms: unknown;
    scopeType: string | null;
    scopeId: string | null;
    goalId: string | null;
  }>;
  const summaryRow = Array.isArray(summaryRows) ? summaryRows[0] : null;
  if (!summaryRow) return empty;

  // Newest first + LIMIT keeps the index scan on (discussion_id, created_at)
  // efficient; reverse to chronological for rendering (mirrors thread-list-entries.ts).
  // Safe now: the parent discussion is confirmed to belong to `companyId`.
  const rowsDesc = (await db
    .select({
      id: discussionEntries.id,
      rawContent: discussionEntries.rawContent,
      authorAgentId: discussionEntries.authorAgentId,
      createdBy: discussionEntries.createdBy,
      createdAt: discussionEntries.createdAt,
    })
    .from(discussionEntries)
    .where(eq(discussionEntries.discussionId, threadId))
    .orderBy(desc(discussionEntries.createdAt))
    .limit(entryLimit)) as Array<{
    id: string;
    rawContent: string | null;
    authorAgentId: string | null;
    createdBy: string | null;
    createdAt: Date | null;
  }>;

  const chronological = Array.isArray(rowsDesc) ? [...rowsDesc].reverse() : [];

  const summaryLines: string[] = [];
  if (summaryRow?.summaryText && summaryRow.summaryText.trim().length > 0) {
    summaryLines.push(`Thread summary: ${summaryRow.summaryText.trim()}`);
  }
  const routingTerms = Array.isArray(summaryRow?.routingTerms)
    ? (summaryRow!.routingTerms as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : [];
  if (routingTerms.length > 0) {
    summaryLines.push(`Key terms: ${routingTerms.join(", ")}`);
  }

  // Resolve agent display names in ONE query (no N+1) when any entry is
  // agent-authored.
  const agentIds = Array.from(
    new Set(
      chronological
        .map((e) => e.authorAgentId)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );
  const nameById = new Map<string, string>();
  if (agentIds.length > 0) {
    const nameRows = (await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(inArray(agents.id, agentIds), eq(agents.companyId, companyId)))) as Array<{ id: string; name: string | null }>;
    for (const r of Array.isArray(nameRows) ? nameRows : []) {
      if (r?.id) nameById.set(r.id, r.name ?? "agent");
    }
  }

  const entryLines = chronological.map((e) => {
    const author = e.authorAgentId
      ? nameById.get(e.authorAgentId) ?? "agent"
      : "founder";
    const text = truncate((e.rawContent ?? "").trim(), ENTRY_TEXT_CAP);
    return `${author}: ${text}`;
  });

  // queryText for memory: prefer the latest entry text (what's being discussed
  // right now), fall back to the summary.
  const latest = chronological.length > 0
    ? (chronological[chronological.length - 1].rawContent ?? "").trim()
    : "";
  const queryText = truncate(
    latest || (summaryRow?.summaryText ?? "").trim(),
    QUERY_TEXT_CAP,
  );

  return { entryLines, summaryLines, queryText, memoryFilters: discussionScopeFilters(summaryRow ?? {}) };
}

interface TaskContext {
  lines: string[];
  queryText: string;
  memoryFilters: MemoryScopeFilters;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function loadScopeHandoffLines(db: Db, companyId: string, issueId: string): Promise<string[]> {
  const bundles = (await db
    .select({
      id: issueContextBundles.id,
      sourceKind: issueContextBundles.sourceKind,
      brief: issueContextBundles.brief,
    })
    .from(issueContextBundles)
    .where(and(
      eq(issueContextBundles.companyId, companyId),
      eq(issueContextBundles.targetIssueId, issueId),
    ))) as Array<{ id: string; sourceKind: string | null; brief: string | null }>;

  const scopeBundles = bundles.filter((bundle) => bundle.sourceKind === "discussion_scope");
  if (scopeBundles.length === 0) return [];

  const lines = ["Scope handoff:"];
  for (const bundle of scopeBundles) {
    if (bundle.brief && bundle.brief.trim().length > 0) {
      lines.push(bundle.brief.trim());
    }

    const items = (await db
      .select({
        itemType: issueContextBundleItems.itemType,
        label: issueContextBundleItems.label,
        metadata: issueContextBundleItems.metadata,
      })
      .from(issueContextBundleItems)
      .where(and(
        eq(issueContextBundleItems.companyId, companyId),
        eq(issueContextBundleItems.bundleId, bundle.id),
      ))) as Array<{ itemType: string; label: string | null; metadata: Record<string, unknown> | null }>;

    for (const item of items) {
      if (!isContextBundleItemIncluded(item)) continue;
      const label = item.label?.trim() || item.itemType;
      const bits = [
        metadataString(item.metadata, "artifactType"),
        metadataString(item.metadata, "contentType"),
        metadataString(item.metadata, "url"),
      ].filter((value): value is string => Boolean(value));
      const suffix = bits.length > 0 ? ` (${bits.join(" · ")})` : "";
      const excerpt = metadataString(item.metadata, "excerpt") ?? metadataString(item.metadata, "body");
      lines.push(`- ${label}${suffix}${excerpt ? `: ${truncate(excerpt, 300)}` : ""}`);
    }
  }

  return lines.length > 1 ? lines : [];
}

/**
 * TASK branch — fetch the issue (title/description/status/priority) and, when
 * it points at an artifact, the artifact's current-version body (truncated).
 */
async function loadTaskContext(db: Db, companyId: string, issueId: string): Promise<TaskContext> {
  const issueRows = (await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
      artifactId: issues.artifactId,
      projectId: issues.projectId,
      projectType: projects.type,
      goalId: issues.goalId,
    })
    .from(issues)
    .leftJoin(projects, eq(projects.id, issues.projectId))
    // Company-scope the task lookup (issueId can arrive caller-supplied via a
    // wakeup payload, same as threadId). Mirrors the discussions gate above and
    // crew-workspace.ts. A cross-company miss returns no issue → empty task
    // context (the `if (!issue)` guard below already fails closed).
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1)) as Array<{
    id: string;
    companyId: string;
    title: string | null;
    description: string | null;
    status: string | null;
    priority: string | null;
    artifactId: string | null;
    projectId: string | null;
    projectType: string | null;
    goalId: string | null;
  }>;
  const issue = Array.isArray(issueRows) ? issueRows[0] : null;
  if (!issue) return { lines: [], queryText: "", memoryFilters: {} };

  const lines: string[] = [];
  if (issue.title) lines.push(`Task: ${issue.title}`);
  const meta = [
    issue.status ? `status ${issue.status}` : null,
    issue.priority ? `priority ${issue.priority}` : null,
  ].filter((v): v is string => v !== null);
  if (meta.length > 0) lines.push(`(${meta.join(", ")})`);
  if (issue.description && issue.description.trim().length > 0) {
    lines.push(issue.description.trim());
  }

  // Upstream deliverable — the artifact's current-version body.
  if (issue.artifactId) {
    const versionRows = (await db
      .select({ content: artifactVersions.content })
      .from(artifacts)
      .innerJoin(
        artifactVersions,
        eq(artifacts.currentVersionId, artifactVersions.id),
      )
      .where(eq(artifacts.id, issue.artifactId))
      .limit(1)) as Array<{ content: string | null }>;
    const body = Array.isArray(versionRows) ? versionRows[0]?.content : null;
    if (body && body.trim().length > 0) {
      lines.push(`Upstream deliverable:\n${truncate(body.trim(), ARTIFACT_BODY_CAP)}`);
    }
  }

  const handoffLines = await loadScopeHandoffLines(db, companyId, issue.id);
  if (handoffLines.length > 0) {
    lines.push(handoffLines.join("\n"));
  }

  const queryText = truncate(
    [issue.title ?? "", issue.description ?? ""].join(" ").trim(),
    QUERY_TEXT_CAP,
  );
  const projectScope =
    issue.projectId && issue.projectType === "department"
      ? { departmentId: issue.projectId }
      : issue.projectId
        ? { projectId: issue.projectId }
        : {};
  return {
    lines,
    queryText,
    memoryFilters: {
      ...projectScope,
      ...(issue.goalId ? { goalId: issue.goalId } : {}),
    },
  };
}

/**
 * MEMORY (both branches) — relevant items via multi-path search, now RBAC-gated
 * and AUDITED (enterprise memory model, P1-T4).
 *
 *   - `accessConditions` (from `memoryAccessConditions(db, actor)`) gate the fetch
 *     INSIDE searchMultiPath, so an unreadable row is never returned — nor ranked.
 *   - `filterMemoryForActor` is the post-fetch safety net mirroring that SQL gate;
 *     even if the gate is bypassed (no actor), a null actor simply leaves the fetch
 *     unfiltered, exactly as before this task.
 *   - every SERVED row is written to `memory_retrievals` (CREW was UNAUDITED before
 *     P1-T4 — scenario O4), mirroring the ORG heartbeat: one row per served item,
 *     `triggeredBy: "auto"`, `shownToAgent: true`. Fire-and-forget.
 *
 * Auditing (and filtering) are gated on a resolved `actor`: with no agent the fetch
 * stays unfiltered AND unaudited — the "no actor ⇒ retain today's behavior" guard.
 *
 * BEST-EFFORT: returns [] (never throws) when the search fails (embeddings/pgvector
 * absent) or finds nothing, so the caller simply omits the section.
 */
export async function loadScopedMemoryLines(
  db: Db,
  companyId: string,
  queryText: string,
  filters: MemoryScopeFilters,
  actor: MemoryActor | null,
  accessConditions: SQL[],
  audit: { agentId?: string | null; runId?: string | null; taskId?: string | null },
): Promise<string[]> {
  // A missing actor means we cannot prove which durable rows this run may see.
  // Keep the non-memory crew context, but fail closed for memory retrieval.
  if (!actor) return [];
  const q = queryText.trim();
  if (q.length === 0) return [];
  try {
    const raw = await memoryService(db).searchMultiPath(companyId, q, {
      limit: MEMORY_LIMIT,
      ...filters,
      ...(accessConditions.length > 0 ? { accessConditions } : {}),
    });
    if (!Array.isArray(raw) || raw.length === 0) return [];
    // Post-fetch safety net (P0): never render — nor audit as shown — a row the
    // actor can't see. A null actor keeps today's unfiltered behavior.
    const served = filterMemoryForActor(raw, actor);
    // Audit the served rows (O4) — mirror the ORG heartbeat. Skipped when no actor
    // resolved (retain today's unaudited behavior) or nothing was served.
    if (served.length > 0) {
      recordMemoryRetrievals(db, {
        companyId,
        agentId: audit.agentId ?? null,
        runId: audit.runId ?? null,
        taskId: audit.taskId ?? null,
        triggeredBy: "auto",
        query: q,
        items: served.map((m, i) => ({
          id: m.id,
          rank: i + 1,
          similarityScore: m.similarity,
          shownToAgent: true,
        })),
      }).catch(() => {});
    }
    return served.map((m) => {
      const t = typeof m.title === "string" && m.title.length > 0 ? m.title : "Memory";
      const c = typeof m.content === "string" ? m.content : "";
      return `- ${t}: ${truncate(c.trim(), 400)}`;
    });
  } catch (err) {
    // Embeddings/pgvector absent (no `embedding` column) or any search failure:
    // degrade to no memory rather than crash the bundle. This is the key
    // robustness point — a crew run must still arrive with thread/task context.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "crew-context-bundle: memory search failed; omitting memory section (best-effort)",
    );
    return [];
  }
}

/**
 * Build the crew context bundle. Returns a single markdown string (clear
 * sub-headers), or "" when there is genuinely nothing to inject (no thread,
 * no task, no memory).
 *
 * Token budgeting: render thread entries NEWEST-survives-first — when the
 * assembled bundle exceeds `tokenBudget`, the OLDEST entries are dropped
 * first, then the memory section is trimmed.
 */
export async function buildCrewContextBundle(
  db: Db,
  args: BuildCrewContextBundleArgs,
): Promise<string> {
  const budget = typeof args.tokenBudget === "number" && args.tokenBudget > 0
    ? args.tokenBudget
    : DEFAULT_TOKEN_BUDGET;

  let thread: ThreadContext | null = null;
  let task: TaskContext | null = null;

  if (args.threadId) {
    thread = await loadThreadContext(db, args.companyId, args.threadId, DEFAULT_ENTRY_LIMIT);
  }
  if (args.issueId) {
    task = await loadTaskContext(db, args.companyId, args.issueId);
  }

  // Memory query: thread takes precedence (the live conversation), else task.
  const queryText = (thread?.queryText && thread.queryText.length > 0)
    ? thread.queryText
    : (task?.queryText ?? "");
  const memoryFilters = thread?.queryText && thread.queryText.length > 0
    ? thread.memoryFilters
    : (task?.memoryFilters ?? {});

  // RBAC + audit (enterprise memory model, P1-T4): resolve the crew agent's actor
  // so the fetch is gated INSIDE searchMultiPath and the served rows are audited.
  // `.catch(() => null)` (and the empty-agentId branch) degrade to today's
  // unfiltered, unaudited behavior — the "no actor ⇒ retain prior behavior" guard.
  const actor = args.agentId
    ? await actorForAgentRun(db, args.companyId, args.agentId).catch(() => null)
    : null;
  const accessConditions = actor ? memoryAccessConditions(db, actor) : [];
  const memoryLines = await loadScopedMemoryLines(
    db,
    args.companyId,
    queryText,
    memoryFilters,
    actor,
    accessConditions,
    { agentId: args.agentId, runId: args.runId ?? null, taskId: args.issueId ?? null },
  );

  // ── Assemble with the token budget ──────────────────────────────────────
  // Build the fixed (non-droppable) sections first: summary + task. Then add
  // thread entries newest-first until the budget is hit, then memory.
  const fixedBlocks: string[] = [];

  if (task && task.lines.length > 0) {
    fixedBlocks.push(task.lines.join("\n"));
  }
  if (thread && thread.summaryLines.length > 0) {
    fixedBlocks.push(thread.summaryLines.join("\n"));
  }

  const sections: string[] = [...fixedBlocks];
  let used = sections.length > 0 ? estimateTokens(sections.join("\n\n")) : 0;

  // Thread entries — add NEWEST first so, on a tight budget, the most recent
  // survive and the oldest are dropped. We collect them, then re-order to
  // chronological for the final render.
  const keptEntries: string[] = [];
  if (thread && thread.entryLines.length > 0) {
    const header = "Recent conversation:";
    const headerTokens = estimateTokens(header) + 1;
    // Walk newest → oldest.
    for (let i = thread.entryLines.length - 1; i >= 0; i--) {
      const line = thread.entryLines[i];
      const lineTokens = estimateTokens(line) + 1;
      const headerCost = keptEntries.length === 0 ? headerTokens : 0;
      if (used + lineTokens + headerCost > budget) break;
      keptEntries.push(line); // newest-first accumulation
      used += lineTokens + headerCost;
    }
    if (keptEntries.length > 0) {
      // Restore chronological order (oldest first) for readability.
      const chrono = [...keptEntries].reverse();
      sections.push(`${header}\n${chrono.join("\n")}`);
    }
  }

  // Memory last (lowest priority; trimmed item-by-item to fit).
  if (memoryLines.length > 0) {
    const header = "Relevant memory:";
    const kept: string[] = [];
    let memUsed = estimateTokens(header) + 1;
    for (const line of memoryLines) {
      const t = estimateTokens(line) + 1;
      if (used + memUsed + t > budget) break;
      kept.push(line);
      memUsed += t;
    }
    if (kept.length > 0) {
      sections.push(`${header}\n${kept.join("\n")}`);
      used += memUsed;
    }
  }

  if (sections.length === 0) return "";

  // Always-on core (P1-T6, scenario O5): a tiny deterministic block — role + (when
  // supplied) current goal + a "call memory.search" pointer — PREPENDED as the first
  // thing the agent reads, independent of retrieval ranking. It is added AFTER token
  // budgeting on purpose: the plan requires it "never dropped by the token budget",
  // and it is exempt from (not merely first in) the budget so trimming a tight run
  // can never evict it. A genuinely-empty or cross-tenant-denied bundle still returns
  // "" above (no legitimate context ⇒ no `## Context` section, and no core manufactured
  // for a denied read).
  const core = buildAlwaysOnCore({
    agentRole: args.agentRole ?? null,
    goalTitle: args.goalTitle ?? null,
  });
  return [core, ...sections].join("\n\n");
}
