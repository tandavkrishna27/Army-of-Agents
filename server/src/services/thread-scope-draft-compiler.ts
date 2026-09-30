export type ScopeCompilerEntry = {
  id: string;
  seq: number;
  inputType: string;
  rawContent: string | null;
  /** Set when a crew/org agent authored the entry — excluded from the derived-title
   *  pool (titles derive from what HUMANS wrote; agent text is agent-authored elsewhere).
   *  Optional: callers passing full discussion_entries rows carry it automatically. */
  authorAgentId?: string | null;
};

export type ScopeCompilerExtractedItem = {
  id: string;
  discussionEntryId: string;
  type: string;
  title: string;
  description?: string | null;
  suggestedPriority?: string | null;
  suggestedAssigneeId?: string | null;
  suggestedDepartmentId?: string | null;
  suggestedProjectId?: string | null;
  suggestedLayer?: string | null;
  suggestedGoalId?: string | null;
  payload?: Record<string, unknown> | null;
  status?: string | null;
};

export type ScopeCompilerAttachment = {
  entryId: string;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  assetId?: string | null;
  title?: string | null;
  contentType?: string | null;
  storageKind?: string | null;
  filename?: string | null;
  byteSize?: number | null;
  sha256?: string | null;
  kind: "artifact" | "asset";
};

export type CompiledScopeItem = {
  kind:
    | "task_proposal"
    | "task_change"
    | "memory_candidate"
    | "artifact_link"
    | "decision"
    | "assumption"
    | "open_question"
    | "source_signal";
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  sourceEntryIds: string[];
  extractedItemId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
};

export type CompiledThreadScopeDraft = {
  summary: string;
  assumptions: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  openQuestions: Array<Record<string, unknown>>;
  items: CompiledScopeItem[];
};

type CompileInput = {
  threadTitle: string | null;
  summaryText: string | null;
  entries: ScopeCompilerEntry[];
  extractedItems: ScopeCompilerExtractedItem[];
  attachments?: ScopeCompilerAttachment[];
  /** Adjutant-supplied tasks (already role-resolved). When present + non-empty,
   *  these become the task_proposal items and suppress the synthetic placeholder. */
  proposedTasks?: Array<{ title: string; assigneeAgentId?: string | null }>;
  /** W2 (D6): when the caller ran extraction first (Adjutant extract-then-scope) and
   *  there are still zero real actionable items, suppress the synthetic fallback task —
   *  an extracted-and-empty thread must never show a fake card. Default false: the human
   *  create-draft route (which does not run extraction synchronously) keeps ONE honest
   *  fallback card whose title derives from the actual content. */
  suppressFallbackTask?: boolean;
};

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstSentence(value: string): string {
  const match = value.match(/^(.{1,220}?)(?:[.!?]\s|$)/);
  return (match?.[1] ?? value.slice(0, 220)).trim();
}

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const slice = value.slice(0, maxLength + 1);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 80 ? lastSpace : maxLength).trim()}...`;
}

function compactRangeSummary(values: string[], maxLength = 420): string {
  const highlights = values.map(firstSentence).filter(Boolean).slice(0, 4);
  return truncateAtWord(highlights.join(" "), maxLength);
}

function entryIds(entries: ScopeCompilerEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

/** Word-boundary truncation where maxLength bounds the WHOLE result, ellipsis included.
 *  (truncateAtWord appends "..." AFTER cutting at maxLength — fine for summaries, but it
 *  overshoots the <= 80 title contract and hard-cuts mid-word at small maxLength.) */
function truncateTitleAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const room = maxLength - 3; // reserve space for "..."
  const slice = value.slice(0, room + 1);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > 0 ? slice.slice(0, lastSpace) : slice.slice(0, room);
  return `${head.replace(/[\s,;:]+$/g, "")}...`;
}

/** W2 (D6): titles derive from the actual discussion content — the hardcoded
 *  keyword-stub placeholder titles are dead. Eng-review D3: use the
 *  LONGEST non-empty entry (most content-bearing; greetings can't win), first sentence,
 *  word-truncated to 80 chars. Callers guarantee entries is non-empty (Place-2 requires
 *  scopedEntries.length > 0). Interim only — the locked end-state is agent-authored
 *  titles everywhere (human create-draft button → "Ask Adjutant to scope", queued). */
/** T6 review: the title pool is HUMAN prose only. Without this, a crew scope_proposal
 *  (raw JSON wire blob — routinely the longest entry) or a long agent reply would win
 *  the longest-entry contest and put JSON/agent text on the Tasks board. Mirrors the
 *  human-entry discriminator in crew-task-service.ts (authorAgentId null + inputType
 *  not agent/system/scope_proposal). */
function isHumanProseEntry(entry: ScopeCompilerEntry): boolean {
  if (entry.authorAgentId) return false;
  return entry.inputType !== "agent" && entry.inputType !== "system" && entry.inputType !== "scope_proposal";
}

function derivedTitleFromEntries(entries: ScopeCompilerEntry[], fallback: string): string {
  let longest = "";
  for (const entry of entries) {
    if (!isHumanProseEntry(entry)) continue;
    const text = cleanText(entry.rawContent);
    if (text.length > longest.length) longest = text;
  }
  const sentence = longest ? firstSentence(longest) : "";
  return sentence ? truncateTitleAtWord(sentence, 80) : fallback;
}

function titleForGeneratedTask(entries: ScopeCompilerEntry[]): string {
  return derivedTitleFromEntries(entries, "Scope work from this discussion");
}

function memoryCandidateTitle(entries: ScopeCompilerEntry[]): string {
  return derivedTitleFromEntries(entries, "Decision from this discussion");
}

function shouldSynthesizeMemoryCandidate(input: {
  lower: string;
  items: CompiledScopeItem[];
}): boolean {
  if (input.items.some((item) => item.kind === "memory_candidate")) return false;

  const mentionsMemoryCandidate = /memory candidate/.test(input.lower);
  const mentionsDurableMemory = /durable memory/.test(input.lower);
  const asksToSaveMemory = /\b(save|store|preserve|remember)\b.{0,80}\bmemory\b/.test(input.lower);
  const asksToScopeMemory = /\bscope\b.{0,120}\bmemory\b/.test(input.lower);
  const hasDecisionSignal = /\b(decision|rule|preference|policy|principle)\b/.test(input.lower);

  return (
    mentionsMemoryCandidate ||
    mentionsDurableMemory ||
    asksToSaveMemory ||
    asksToScopeMemory
  ) && hasDecisionSignal;
}

function makeSummary(input: CompileInput): string {
  const explicit = cleanText(input.summaryText);
  const entryText = input.entries.map((entry) => cleanText(entry.rawContent)).filter(Boolean);
  if (explicit && entryText.length > 0) {
    return truncateAtWord(`${explicit} ${compactRangeSummary(entryText, 320)}`, 520);
  }
  if (explicit) return truncateAtWord(explicit, 520);

  if (entryText.length > 0) {
    return compactRangeSummary(entryText);
  }

  return cleanText(input.threadTitle) || "Draft scope from this thread";
}

function mapExtractedItem(item: ScopeCompilerExtractedItem): CompiledScopeItem {
  const sourceEntryIds = [item.discussionEntryId];
  if (item.type === "task") {
    return {
      kind: "task_proposal",
      title: item.title,
      description: item.description ?? null,
      sourceEntryIds,
      extractedItemId: item.id,
      payload: {
        priority: item.suggestedPriority ?? "medium",
        assigneeAgentId: item.suggestedAssigneeId ?? null,
        departmentId: item.suggestedDepartmentId ?? null,
        projectId: item.suggestedProjectId ?? null,
        goalId: item.suggestedGoalId ?? null,
      },
    };
  }

  if (item.type === "artifact") {
    // Extraction does not emit artifact ids today, and discussion_extracted_items
    // has no `payload` column to read one from — so an artifact-typed extracted
    // item always degrades to an evidence source_signal. Concrete artifact links
    // still flow through the attachment join (compileAttachmentItem).
    return {
      kind: "source_signal",
      title: item.title,
      description: item.description ?? null,
      sourceEntryIds,
      extractedItemId: item.id,
      payload: { role: "evidence", category: "artifact" },
    };
  }

  if (item.type === "decision") {
    return {
      kind: "decision",
      title: item.title,
      description: item.description ?? null,
      sourceEntryIds,
      extractedItemId: item.id,
      payload: {},
    };
  }

  return {
    kind: "memory_candidate",
    title: item.title,
    description: item.description ?? null,
    sourceEntryIds,
    extractedItemId: item.id,
    payload: {
      layer: item.suggestedLayer ?? "domain",
      category: item.type,
      departmentId: item.suggestedDepartmentId ?? null,
      goalId: item.suggestedGoalId ?? null,
    },
  };
}

function proposedTaskItems(
  proposedTasks: Array<{ title: string; assigneeAgentId?: string | null }>,
  entries: ScopeCompilerEntry[],
): CompiledScopeItem[] {
  const sourceEntryIds = entryIds(entries);
  return proposedTasks.map((t) => ({
    kind: "task_proposal" as const,
    title: cleanText(t.title),
    description: null,
    sourceEntryIds,
    payload: { priority: "medium", assigneeAgentId: t.assigneeAgentId ?? null },
  }));
}

function compileAttachmentItem(attachment: ScopeCompilerAttachment): CompiledScopeItem {
  if (attachment.kind === "artifact" && attachment.artifactId) {
    const payload: Record<string, unknown> = {
      role: "reference",
      contentType: attachment.contentType ?? null,
    };
    if (attachment.storageKind === "asset" && attachment.assetId) {
      payload.storageKind = "asset";
      payload.assetId = attachment.assetId;
      payload.filename = attachment.filename ?? attachment.title ?? null;
      payload.byteSize = attachment.byteSize ?? null;
      payload.sha256 = attachment.sha256 ?? null;
    }

    return {
      kind: "artifact_link",
      title: cleanText(attachment.title) || "Attached artifact",
      description: attachment.contentType ? `Attached ${attachment.contentType} artifact.` : "Attached artifact.",
      payload,
      sourceEntryIds: [attachment.entryId],
      artifactId: attachment.artifactId,
      artifactVersionId: attachment.artifactVersionId ?? null,
    };
  }

  return {
    kind: "source_signal",
    title: cleanText(attachment.title) || "Attached evidence",
    description: attachment.contentType ? `Attached ${attachment.contentType} source.` : "Attached source evidence.",
    payload: {
      role: "evidence",
      assetId: attachment.assetId ?? null,
      contentType: attachment.contentType ?? null,
    },
    sourceEntryIds: [attachment.entryId],
  };
}

function compileUrlSignalItems(entries: ScopeCompilerEntry[]): CompiledScopeItem[] {
  const urlPattern = /https?:\/\/[^\s)]+/g;
  const byUrl = new Map<string, CompiledScopeItem>();

  for (const entry of entries) {
    const rawContent = entry.rawContent ?? "";
    const urls = rawContent.match(urlPattern) ?? [];
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[.,;:!?]+$/g, "");
      if (!url) continue;

      const existing = byUrl.get(url);
      if (existing) {
        if (!existing.sourceEntryIds.includes(entry.id)) {
          existing.sourceEntryIds.push(entry.id);
        }
        continue;
      }

      byUrl.set(url, {
        kind: "source_signal",
        title: `Source: ${url}`,
        description: "URL referenced in the scoped discussion.",
        payload: { role: "evidence", url },
        sourceEntryIds: [entry.id],
      });
    }
  }

  return [...byUrl.values()];
}

export function compileThreadScopeDraft(input: CompileInput): CompiledThreadScopeDraft {
  const scopedEntries = input.entries.filter((entry) => cleanText(entry.rawContent));
  const allEntryIds = entryIds(scopedEntries);
  const summary = makeSummary({ ...input, entries: scopedEntries });
  const combined = scopedEntries.map((entry) => cleanText(entry.rawContent)).join(" ");
  const lower = combined.toLowerCase();

  // D1: when proposedTasks are present + non-empty, they are the ONLY source of
  // task_proposal items — extracted task_proposals AND the placeholder are suppressed.
  const useProposedTasks = Boolean(input.proposedTasks && input.proposedTasks.length > 0);

  // Place 1: extracted-item mapping — skip items that would emit task_proposal when useProposedTasks.
  const extractedCompiled = input.extractedItems
    .map(mapExtractedItem)
    .filter((it) => !(useProposedTasks && it.kind === "task_proposal"));

  const items = [
    ...extractedCompiled,
    ...(input.attachments ?? []).map(compileAttachmentItem),
    ...compileUrlSignalItems(scopedEntries),
  ];

  const hasGeneratedWorkItem = items.some(
    (item) => item.kind !== "artifact_link" && item.kind !== "source_signal",
  );
  // Place 2: fallback-task synthesis — title derived from content (W2 killed the keyword
  // stubs). Suppressed when proposedTasks exist (W1a) OR when the caller ran extraction
  // first and found nothing actionable (W2 suppressFallbackTask — no fake card, D6).
  if (
    scopedEntries.length > 0 &&
    !hasGeneratedWorkItem &&
    !useProposedTasks &&
    !input.suppressFallbackTask
  ) {
    items.push({
      kind: "task_proposal",
      title: titleForGeneratedTask(scopedEntries),
      description: summary,
      payload: { priority: "medium" },
      sourceEntryIds: allEntryIds,
    });
  }

  // Place 3: emit proposed tasks when useProposedTasks.
  if (useProposedTasks) {
    items.push(...proposedTaskItems(input.proposedTasks!, scopedEntries));
  }

  if (scopedEntries.length > 0 && shouldSynthesizeMemoryCandidate({ lower, items })) {
    items.push({
      kind: "memory_candidate",
      title: memoryCandidateTitle(scopedEntries),
      description: summary,
      payload: {
        layer: "domain",
        category: "decision",
      },
      sourceEntryIds: allEntryIds,
    });
  }

  const decisions: Array<Record<string, unknown>> = [];
  if (lower.includes("accepted scope") || lower.includes("v2") || lower.includes("source of truth")) {
    const matchingEntryIds = scopedEntries
      .filter((entry) => {
        const text = cleanText(entry.rawContent).toLowerCase();
        return text.includes("accepted scope") || text.includes("v2") || text.includes("source of truth");
      })
      .map((entry) => entry.id);
    decisions.push({
      title: "Use versioned scope as the accepted handoff source of truth",
      description: "Accepted scope versions should anchor downstream tasks and later re-scope cycles.",
      sourceEntryIds: matchingEntryIds.length > 0 ? matchingEntryIds : allEntryIds,
    });
    if (!items.some((item) => item.kind === "memory_candidate" && /accepted scope/i.test(item.title))) {
      items.push({
        kind: "memory_candidate",
        title: "Accepted scope versions are handoff source of truth",
        description: "Store accepted scope versions as durable context for future agent work.",
        payload: { layer: "domain", category: "decision" },
        sourceEntryIds: matchingEntryIds.length > 0 ? matchingEntryIds : allEntryIds,
      });
    }
  }

  const openQuestions: Array<Record<string, unknown>> = [];
  if (lower.includes("memory") && (lower.includes("retrievable") || lower.includes("agent"))) {
    const matchingEntryIds = scopedEntries
      .filter((entry) => {
        const text = cleanText(entry.rawContent).toLowerCase();
        return text.includes("memory") || text.includes("retrievable") || text.includes("agent");
      })
      .map((entry) => entry.id);
    openQuestions.push({
      title: "How will memory retrieval be verified during agent task execution?",
      description: "Scope should not write memory that later agents cannot retrieve and use.",
      sourceEntryIds: matchingEntryIds.length > 0 ? matchingEntryIds : allEntryIds,
    });
  }

  if (decisions.length === 0 && input.extractedItems.some((item) => item.type === "decision")) {
    decisions.push(
      ...input.extractedItems
        .filter((item) => item.type === "decision")
        .map((item) => ({
          title: item.title,
          description: item.description ?? null,
          sourceEntryIds: [item.discussionEntryId],
        })),
    );
  }

  return {
    summary,
    assumptions: [],
    decisions,
    openQuestions,
    items,
  };
}
