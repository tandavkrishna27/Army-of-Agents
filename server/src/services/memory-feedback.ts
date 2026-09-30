import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  memoryFeedbackPatterns,
  suggestions,
  activityLog,
  briefs,
  debriefs,
  agents,
} from "@armyofagents/db";
import {
  detectToneCorrections,
  detectFormatChanges,
  detectContentAdditions,
  detectTerminologyChanges,
  type DetectedPattern,
  type EditRecord,
} from "./memory-feedback-detectors.js";

// Re-export detectors for external use
export {
  detectToneCorrections,
  detectFormatChanges,
  detectContentAdditions,
  detectTerminologyChanges,
  type DetectedPattern,
  type EditRecord,
} from "./memory-feedback-detectors.js";

export interface MemoryFeedbackFilters {
  status?: string;
  patternType?: string;
}

const MIN_OCCURRENCE_THRESHOLD = 3;

// ── Data fetching ───────────────────────────────────────────────────────

/**
 * Fetch all brief item edits within a time window from the activity log.
 * Only returns edits that have both original and new content captured.
 */
async function fetchEdits(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<EditRecord[]> {
  const rows = await db
    .select({
      entityId: activityLog.entityId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "brief_item.updated"),
        eq(activityLog.entityType, "brief_item"),
        sql`${activityLog.createdAt} >= ${windowStart.toISOString()}`,
      ),
    );

  const edits: EditRecord[] = [];

  for (const row of rows) {
    const d = row.details as Record<string, unknown> | null;
    if (!d) continue;

    // Skip edits without original content (edge case #4)
    if (!d.originalTitle && d.originalDescription === undefined) continue;

    // Skip if status wasn't "edited" (status-only changes aren't content edits)
    if (d.status !== "edited") continue;

    edits.push({
      briefItemId: row.entityId,
      briefId: d.briefId as string,
      originalTitle: (d.originalTitle as string) ?? "",
      originalDescription: (d.originalDescription as string | null) ?? null,
      editedTitle: (d.title as string) ?? "",
      editedDescription: (d.description as string | null) ?? null,
      agentId: null, // Will be resolved via brief → debrief chain
      editedAt: row.createdAt.toISOString(),
    });
  }

  // Resolve agent IDs: brief_item → brief → debrief → sourceInfo.agentId
  if (edits.length > 0) {
    const briefIds = [...new Set(edits.map((e) => e.briefId))];
    const briefAgentMap = new Map<string, string | null>();

    for (const bId of briefIds) {
      const brief = await db
        .select({ debriefId: briefs.debriefId })
        .from(briefs)
        .where(eq(briefs.id, bId))
        .then((r) => r[0] ?? null);

      if (!brief) continue;

      const debrief = await db
        .select({ sourceInfo: debriefs.sourceInfo })
        .from(debriefs)
        .where(eq(debriefs.id, brief.debriefId))
        .then((r) => r[0] ?? null);

      const info = debrief?.sourceInfo as Record<string, unknown> | null;
      briefAgentMap.set(bId, (info?.agentId as string) ?? null);
    }

    for (const edit of edits) {
      edit.agentId = briefAgentMap.get(edit.briefId) ?? null;
    }
  }

  return edits;
}

// ── Suggestion helpers ──────────────────────────────────────────────────

function buildSuggestionTitle(
  pattern: DetectedPattern,
  agentName: string | null,
): string {
  const agent = agentName ?? "An agent";
  switch (pattern.patternType) {
    case "tone_correction":
      return `${agent}'s tone is consistently corrected — create a preference?`;
    case "format_change":
      return `${agent}'s output format is regularly restructured — create a guideline?`;
    case "content_addition":
      return `${agent} consistently misses content — create a checklist?`;
    case "content_removal":
      return `${agent}'s output is regularly trimmed — create a brevity preference?`;
    case "structure_change":
      return `${agent}'s output structure is consistently reorganized — create a template?`;
    case "terminology_change":
      return `${agent} uses different terminology than preferred — create a glossary entry?`;
    default:
      return `Recurring edit pattern detected for ${agent} — create a memory item?`;
  }
}

function buildSuggestedContent(pattern: DetectedPattern): string {
  switch (pattern.patternType) {
    case "tone_correction":
      return "Prefer a specific tone in communications (review the edits for the preferred style)";
    case "format_change":
      return "Use a specific format for deliverables (review the edits for the preferred structure)";
    case "content_addition":
      return "Always include additional context or details (review the edits for what was added)";
    case "content_removal":
      return "Keep output concise (review the edits for what was removed)";
    case "structure_change":
      return "Follow a specific organizational structure (review the edits for the preferred layout)";
    case "terminology_change":
      return "Use preferred terminology (review the edits for the correct terms)";
    default:
      return "Review recurring edits and create a preference";
  }
}

async function createSuggestion(
  db: Db,
  companyId: string,
  pattern: DetectedPattern,
  patternId: string,
  agentName: string | null,
) {
  // Don't create duplicate suggestions for same pattern
  const existingSuggestion = await db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.companyId, companyId),
        eq(suggestions.category, "pattern_detected"),
        eq(suggestions.actionType, "suggest_memory"),
        sql`${suggestions.actionPayload}->>'patternId' = ${patternId}`,
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existingSuggestion) return;

  await db
    .insert(suggestions)
    .values({
      companyId,
      category: "pattern_detected",
      actionType: "suggest_memory",
      dedupeKey: `pattern_detected:${patternId}`,
      title: buildSuggestionTitle(pattern, agentName),
      evidence: JSON.stringify(pattern.evidence.slice(0, 5)),
      actionPayload: {
        patternId,
        patternType: pattern.patternType,
        suggestedContent: buildSuggestedContent(pattern),
        sourceAgentId: pattern.sourceAgentId,
      },
    })
    .onConflictDoNothing();
}

// ── Service ─────────────────────────────────────────────────────────────

export function memoryFeedbackService(db: Db) {
  return {
    /** List detected patterns for a company */
    list: async (companyId: string, filters: MemoryFeedbackFilters = {}) => {
      const conditions = [eq(memoryFeedbackPatterns.companyId, companyId)];

      if (filters.status) {
        conditions.push(eq(memoryFeedbackPatterns.status, filters.status));
      }
      if (filters.patternType) {
        conditions.push(
          eq(memoryFeedbackPatterns.patternType, filters.patternType),
        );
      }

      return db
        .select()
        .from(memoryFeedbackPatterns)
        .where(and(...conditions))
        .orderBy(sql`${memoryFeedbackPatterns.createdAt} DESC`);
    },

    /**
     * Run all detectors, persist results, and generate suggestions.
     * Default window: last 30 days.
     */
    runAllDetectors: async (companyId: string, windowDays = 30) => {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - windowDays);

      const edits = await fetchEdits(db, companyId, windowStart);
      if (edits.length === 0) return { patternsCreated: 0, suggestionsCreated: 0 };

      // Run all detectors (stateless — each returns DetectedPattern[])
      const allPatterns: DetectedPattern[] = [
        ...detectToneCorrections(edits),
        ...detectFormatChanges(edits),
        ...detectContentAdditions(edits),
        ...detectTerminologyChanges(edits),
      ];

      if (allPatterns.length === 0) return { patternsCreated: 0, suggestionsCreated: 0 };

      // Resolve agent names for suggestion titles
      const agentIds = [
        ...new Set(allPatterns.map((p) => p.sourceAgentId).filter(Boolean)),
      ] as string[];
      const agentNameMap = new Map<string, string>();
      if (agentIds.length > 0) {
        const agentRows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds));
        for (const a of agentRows) {
          agentNameMap.set(a.id, a.name);
        }
      }

      let patternsCreated = 0;
      let suggestionsCreated = 0;

      for (const pattern of allPatterns) {
        // Check if pattern already exists for this company + type + agent
        const conditions = [
          eq(memoryFeedbackPatterns.companyId, companyId),
          eq(memoryFeedbackPatterns.patternType, pattern.patternType),
        ];
        if (pattern.sourceAgentId) {
          conditions.push(
            eq(memoryFeedbackPatterns.sourceAgentId, pattern.sourceAgentId),
          );
        } else {
          conditions.push(
            sql`${memoryFeedbackPatterns.sourceAgentId} IS NULL`,
          );
        }

        const existing = await db
          .select()
          .from(memoryFeedbackPatterns)
          .where(and(...conditions))
          .then((rows) => rows[0] ?? null);

        if (existing) {
          // Update occurrence count and evidence
          await db
            .update(memoryFeedbackPatterns)
            .set({
              occurrenceCount: pattern.occurrenceCount,
              evidence: pattern.evidence,
              updatedAt: new Date(),
            })
            .where(eq(memoryFeedbackPatterns.id, existing.id));

          // Check if we need to create a suggestion (≥3 occurrences, not already suggested)
          if (
            pattern.occurrenceCount >= MIN_OCCURRENCE_THRESHOLD &&
            existing.status === "detected"
          ) {
            await createSuggestion(
              db,
              companyId,
              pattern,
              existing.id,
              agentNameMap.get(pattern.sourceAgentId ?? "") ?? null,
            );
            await db
              .update(memoryFeedbackPatterns)
              .set({ status: "suggested", updatedAt: new Date() })
              .where(eq(memoryFeedbackPatterns.id, existing.id));
            suggestionsCreated++;
          }
        } else {
          // Create new pattern
          const [created] = await db
            .insert(memoryFeedbackPatterns)
            .values({
              companyId,
              patternType: pattern.patternType,
              occurrenceCount: pattern.occurrenceCount,
              evidence: pattern.evidence,
              sourceAgentId: pattern.sourceAgentId,
              status:
                pattern.occurrenceCount >= MIN_OCCURRENCE_THRESHOLD
                  ? "suggested"
                  : "detected",
            })
            .returning();
          patternsCreated++;

          // Create suggestion if threshold met immediately
          if (pattern.occurrenceCount >= MIN_OCCURRENCE_THRESHOLD) {
            await createSuggestion(
              db,
              companyId,
              pattern,
              created.id,
              agentNameMap.get(pattern.sourceAgentId ?? "") ?? null,
            );
            suggestionsCreated++;
          }
        }
      }

      return { patternsCreated, suggestionsCreated };
    },
  };
}
