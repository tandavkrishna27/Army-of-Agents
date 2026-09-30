/**
 * @fileoverview Snapshot merge algorithm for skill/agent/team updates.
 * Strategy: split markdown by ## headers → compare section by section →
 * produce SectionDiff[] → UI shows per-section Accept mine / Accept theirs.
 */
import { diffWords } from "diff";

export interface Section {
  header: string; // '## Section Name' or '__preamble__' for content before first heading
  content: string;
}

export interface SectionDiff {
  header: string;
  state: "unchanged" | "changed" | "added" | "removed";
  mine: string;   // content from current version (empty if added)
  theirs: string; // content from upstream version (empty if removed)
  wordDiff?: ReturnType<typeof diffWords>; // only when state === "changed"
}

type Fence = { marker: "`" | "~"; length: number };

function dominantEol(markdown: string): "\n" | "\r\n" {
  const lineEndings = markdown.match(/\r\n|\n/g) ?? [];
  if (lineEndings.length === 0) return "\n";

  const crlfCount = lineEndings.filter((ending) => ending === "\r\n").length;
  const lfCount = lineEndings.length - crlfCount;
  if (crlfCount === lfCount) return lineEndings[0] === "\r\n" ? "\r\n" : "\n";
  return crlfCount > lfCount ? "\r\n" : "\n";
}

function openingFence(line: string): Fence | null {
  // CommonMark allows at most three leading spaces before a fenced code block.
  // Four spaces is an indented code line and must not hide later real headings.
  const match = line.match(/^ {0,3}(`{3,}|~{3,}).*$/);
  if (!match) return null;
  const run = match[1];
  return { marker: run[0] as Fence["marker"], length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/);
  return Boolean(
    match &&
      match[1][0] === fence.marker &&
      match[1].length >= fence.length,
  );
}

/**
 * Split a markdown document into sections by ## (h2) headings.
 * Content before the first ## goes into a __preamble__ section.
 */
export function splitSections(markdown: string): Section[] {
  const eol = dominantEol(markdown);
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let currentHeader = "__preamble__";
  let currentLines: string[] = [];
  let fence: Fence | null = null;

  for (const line of lines) {
    if (fence) {
      currentLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const openedFence = openingFence(line);
    if (openedFence) {
      fence = openedFence;
      currentLines.push(line);
      continue;
    }

    if (line.startsWith("## ")) {
      // Flush previous section
      sections.push({ header: currentHeader, content: currentLines.join(eol) });
      currentHeader = line.slice(3).trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  sections.push({ header: currentHeader, content: currentLines.join(eol) });

  return sections;
}

/**
 * Split into the same logical sections while retaining every original byte,
 * including the line ending immediately before the next heading.
 */
function splitSectionsExact(markdown: string): Section[] {
  const sections: Section[] = [];
  let currentHeader = "__preamble__";
  let currentStart = 0;
  let fence: Fence | null = null;

  for (const match of markdown.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)) {
    const rawLine = match[0];
    if (rawLine.length === 0) continue;
    const line = rawLine.endsWith("\r\n")
      ? rawLine.slice(0, -2)
      : rawLine.endsWith("\n")
        ? rawLine.slice(0, -1)
        : rawLine;

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const openedFence = openingFence(line);
    if (openedFence) {
      fence = openedFence;
      continue;
    }

    if (line.startsWith("## ")) {
      const offset = match.index ?? 0;
      sections.push({
        header: currentHeader,
        content: markdown.slice(currentStart, offset),
      });
      currentHeader = line.slice(3).trim();
      currentStart = offset;
    }
  }

  sections.push({
    header: currentHeader,
    content: markdown.slice(currentStart),
  });
  return sections;
}

/**
 * Make section headers unique within an array by appending " [2]", " [3]", etc.
 * to repeated headers. This ensures duplicate ## headings in a markdown file
 * are each independently tracked in the diff Map, rather than the later one
 * silently overwriting the earlier one.
 *
 * The n-th occurrence of a header in mine is matched against the n-th occurrence
 * in theirs, which is the best-effort alignment for docs with repeated headings.
 */
export function deduplicateHeaders(sections: Section[]): Section[] {
  const counts = new Map<string, number>();
  return sections.map((s) => {
    const count = (counts.get(s.header) ?? 0) + 1;
    counts.set(s.header, count);
    return count === 1 ? s : { ...s, header: `${s.header} [${count}]` };
  });
}

/**
 * Compute a section-level diff between two markdown documents.
 *
 * Ordering: the diff is built in MINE (current/user) order for retained
 * (unchanged/changed) and removed sections, so user-authored ordering — and
 * user-retained sections upstream has dropped — is preserved. Upstream-only
 * ("added") sections are interleaved at their anchor: each lands immediately
 * before the surviving mine-section it precedes in theirs, and any added
 * sections trailing the last shared section are appended at the end.
 */
export function computeSectionDiff(mine: string, theirs: string): SectionDiff[] {
  const mineSections = deduplicateHeaders(splitSections(mine));
  const theirSectionList = deduplicateHeaders(splitSections(theirs));
  const theirSections = new Map(theirSectionList.map((s) => [s.header, s]));
  // Upstream index per header, used to anchor "added" sections relative to
  // surviving mine-sections.
  const theirIndex = new Map(theirSectionList.map((s, i) => [s.header, i]));

  const result: SectionDiff[] = [];

  // "Added" sections (in theirs, not in mine), kept in upstream order so they
  // are flushed at their correct anchor as we walk mine.
  const added = theirSectionList.filter((s) => !mineSections.some((m) => m.header === s.header));
  let addedCursor = 0;

  // Flush all added sections whose upstream index is < the given boundary.
  const flushAddedBefore = (boundary: number) => {
    while (addedCursor < added.length && (theirIndex.get(added[addedCursor].header) ?? 0) < boundary) {
      const s = added[addedCursor];
      result.push({ header: s.header, state: "added", mine: "", theirs: s.content });
      addedCursor += 1;
    }
  };

  // Walk mine in order; classify each section, interleaving added sections that
  // anchor before the current surviving section.
  for (const mySection of mineSections) {
    const theirSection = theirSections.get(mySection.header);

    if (theirSection) {
      // Shared section: flush any added sections anchored before it upstream.
      flushAddedBefore(theirIndex.get(mySection.header) ?? Number.MAX_SAFE_INTEGER);
      if (mySection.content.trim() === theirSection.content.trim()) {
        result.push({ header: mySection.header, state: "unchanged", mine: mySection.content, theirs: theirSection.content });
      } else {
        result.push({
          header: mySection.header,
          state: "changed",
          mine: mySection.content,
          theirs: theirSection.content,
          wordDiff: diffWords(mySection.content, theirSection.content),
        });
      }
    } else {
      // Removed section (in mine, not theirs): keep it in its original mine slot.
      result.push({ header: mySection.header, state: "removed", mine: mySection.content, theirs: "" });
    }
  }

  // Append any remaining added sections (anchored after the last shared section).
  flushAddedBefore(Number.MAX_SAFE_INTEGER);

  return result;
}

/**
 * Apply merge decisions to produce the final merged document.
 * decisions: map of header → 'mine' | 'theirs'
 */
export function applyMergeDecisions(
  diff: SectionDiff[],
  decisions: Record<string, "mine" | "theirs">,
): string {
  // Derive this before filtering. A merge that drops every section still needs
  // to retain the source document's line-ending convention.
  const eol = dominantEol(
    diff.flatMap((section) => [section.mine, section.theirs]).join(""),
  );
  const parts: string[] = [];
  for (const section of diff) {
    const decision = decisions[section.header] ?? (section.state === "added" ? "theirs" : "mine");
    if (section.state === "unchanged") {
      // "Unchanged" is semantic (trim-equal), not byte-identical. Bulk
      // "accept upstream" must still be able to select upstream whitespace.
      parts.push(decision === "theirs" ? section.theirs : section.mine);
    } else if (decision === "mine" && section.state !== "added") {
      parts.push(section.mine);
    } else if (decision === "theirs" && section.state !== "removed") {
      parts.push(section.theirs);
    }
    // If decision is "mine" and state is "added", section is dropped
    // If decision is "theirs" and state is "removed", section is dropped
  }
  return parts.join(eol + eol).trim() + eol;
}

/**
 * Merge a skill document and report whether the result is byte-identical to
 * the upstream document the founder reviewed.
 *
 * `computeSectionDiff` intentionally classifies trim-equal sections as
 * unchanged, so section state alone cannot prove upstream parity. When every
 * section resolves upstream, return the original upstream bytes verbatim
 * instead of the normalized output from `applyMergeDecisions`.
 */
export function mergeSkillDocument(
  diff: SectionDiff[],
  decisions: Record<string, "mine" | "theirs">,
  upstreamContent: string,
  mineContent: string,
): { content: string; pureUpstream: boolean } {
  // The diff is ordered to preserve founder section placement. When every
  // logical section resolves upstream, that order is deliberately irrelevant:
  // return the reviewed upstream document verbatim, including its ordering and
  // byte-only whitespace. This is what makes the bulk "accept all upstream"
  // control able to opt back into automatic updates.
  const everySectionResolvesUpstream = diff.every((section) => {
    const decision =
      decisions[section.header] ?? (section.state === "added" ? "theirs" : "mine");
    return decision === "theirs";
  });
  if (everySectionResolvesUpstream) {
    return { content: upstreamContent, pureUpstream: true };
  }

  const mineSections = new Map(
    deduplicateHeaders(splitSectionsExact(mineContent)).map((section) => [
      section.header,
      section,
    ]),
  );
  const upstreamSections = deduplicateHeaders(splitSectionsExact(upstreamContent));
  const upstreamByHeader = new Map(
    upstreamSections.map((section) => [section.header, section]),
  );
  const resolvedSections: Section[] = [];

  for (const section of diff) {
    const decision =
      decisions[section.header] ?? (section.state === "added" ? "theirs" : "mine");
    if (section.state === "unchanged") {
      resolvedSections.push(
        decision === "theirs"
          ? upstreamByHeader.get(section.header) ?? {
              header: section.header,
              content: section.theirs,
            }
          : mineSections.get(section.header) ?? {
              header: section.header,
              content: section.mine,
            },
      );
      continue;
    }
    if (decision === "mine" && section.state !== "added") {
      resolvedSections.push(
        mineSections.get(section.header) ?? {
          header: section.header,
          content: section.mine,
        },
      );
    } else if (decision === "theirs" && section.state !== "removed") {
      resolvedSections.push(
        upstreamByHeader.get(section.header) ?? {
          header: section.header,
          content: section.theirs,
        },
      );
    }
  }

  const pureUpstream =
    resolvedSections.length === upstreamSections.length &&
    resolvedSections.every(
      (section, index) =>
        section.header === upstreamSections[index].header &&
        section.content === upstreamSections[index].content,
    );

  if (pureUpstream) {
    return { content: upstreamContent, pureUpstream: true };
  }

  const content = applyMergeDecisions(diff, decisions);
  // `applyMergeDecisions` normalizes section separators and the final newline.
  // Even when the logical choices were "mine", those emitted bytes can become
  // exactly upstream. The persisted customized flag describes the bytes that
  // were actually written, not the pre-normalization section provenance.
  return content === upstreamContent
    ? { content: upstreamContent, pureUpstream: true }
    : { content, pureUpstream: false };
}
