/**
 * Stateless, composable detector functions for memory feedback patterns.
 * These are pure functions with no database dependencies — they operate on
 * pre-fetched EditRecord arrays and return DetectedPattern arrays.
 */
import type { MemoryFeedbackPatternType } from "@armyofagents/shared";

// ── Types ───────────────────────────────────────────────────────────────

export interface DetectedPattern {
  patternType: MemoryFeedbackPatternType;
  sourceAgentId: string | null;
  occurrenceCount: number;
  evidence: Record<string, unknown>[];
}

export interface EditRecord {
  briefItemId: string;
  briefId: string;
  originalTitle: string;
  originalDescription: string | null;
  editedTitle: string;
  editedDescription: string | null;
  agentId: string | null;
  editedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Normalize text for comparison: trim, collapse whitespace, lowercase */
function normalize(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function groupByAgent(
  edits: EditRecord[],
): Map<string | null, EditRecord[]> {
  const map = new Map<string | null, EditRecord[]>();
  for (const edit of edits) {
    const key = edit.agentId;
    const arr = map.get(key) ?? [];
    arr.push(edit);
    map.set(key, arr);
  }
  return map;
}

function buildPatterns(
  patternType: MemoryFeedbackPatternType,
  grouped: Map<string | null, EditRecord[]>,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  for (const [agentId, edits] of grouped) {
    patterns.push({
      patternType,
      sourceAgentId: agentId,
      occurrenceCount: edits.length,
      evidence: edits.map((e) => ({
        briefItemId: e.briefItemId,
        briefId: e.briefId,
        originalTitle: e.originalTitle,
        editedTitle: e.editedTitle,
        originalDescription: e.originalDescription,
        editedDescription: e.editedDescription,
        editedAt: e.editedAt,
      })),
    });
  }
  return patterns;
}

// ── Individual Detectors (stateless, composable) ───────────────────────

/**
 * Detect tone corrections: founder changed the wording/phrasing but kept
 * roughly the same meaning. Heuristic: title changed but word overlap is high.
 */
export function detectToneCorrections(edits: EditRecord[]): DetectedPattern[] {
  const grouped = groupByAgent(
    edits.filter((e) => {
      const origTitle = normalize(e.originalTitle);
      const editTitle = normalize(e.editedTitle);
      if (origTitle === editTitle) return false;
      // High word overlap but different phrasing → tone correction
      const origWords = new Set(origTitle.split(" "));
      const editWords = new Set(editTitle.split(" "));
      const overlap = [...origWords].filter((w) => editWords.has(w)).length;
      const maxLen = Math.max(origWords.size, editWords.size);
      return maxLen > 0 && overlap / maxLen >= 0.3 && overlap / maxLen < 1;
    }),
  );

  return buildPatterns("tone_correction", grouped);
}

/**
 * Detect format changes: structural/markdown edits in description.
 * Heuristic: description changed, and formatting markers differ
 * (list markers, headers, line breaks).
 */
export function detectFormatChanges(edits: EditRecord[]): DetectedPattern[] {
  const grouped = groupByAgent(
    edits.filter((e) => {
      const origDesc = e.originalDescription ?? "";
      const editDesc = e.editedDescription ?? "";
      if (origDesc === editDesc) return false;
      // Check if formatting markers changed
      const formatPattern = /[-*#>\d+.]\s|```|\n\n/g;
      const origFormats = origDesc.match(formatPattern)?.join("") ?? "";
      const editFormats = editDesc.match(formatPattern)?.join("") ?? "";
      return origFormats !== editFormats && normalize(origDesc) !== normalize(editDesc);
    }),
  );

  return buildPatterns("format_change", grouped);
}

/**
 * Detect content additions: founder consistently adds content that was missing.
 * Heuristic: edited version is substantially longer than original.
 */
export function detectContentAdditions(edits: EditRecord[]): DetectedPattern[] {
  const grouped = groupByAgent(
    edits.filter((e) => {
      const origLen =
        (e.originalTitle?.length ?? 0) + (e.originalDescription?.length ?? 0);
      const editLen =
        (e.editedTitle?.length ?? 0) + (e.editedDescription?.length ?? 0);
      // Edited version is at least 30% longer
      return origLen > 0 && editLen > origLen * 1.3;
    }),
  );

  return buildPatterns("content_addition", grouped);
}

/**
 * Detect terminology changes: founder changes specific words/phrases consistently.
 * Heuristic: title words were replaced but sentence length is similar.
 */
export function detectTerminologyChanges(
  edits: EditRecord[],
): DetectedPattern[] {
  const grouped = groupByAgent(
    edits.filter((e) => {
      const origTitle = normalize(e.originalTitle);
      const editTitle = normalize(e.editedTitle);
      if (origTitle === editTitle) return false;
      const origWords = origTitle.split(" ");
      const editWords = editTitle.split(" ");
      // Similar length but different words → terminology change
      const lenDiff = Math.abs(origWords.length - editWords.length);
      if (lenDiff > 2) return false;
      const changedWords = origWords.filter(
        (w, i) => editWords[i] !== undefined && editWords[i] !== w,
      );
      return changedWords.length > 0 && changedWords.length <= 3;
    }),
  );

  return buildPatterns("terminology_change", grouped);
}
