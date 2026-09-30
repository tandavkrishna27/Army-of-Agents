/**
 * line-diff.ts
 *
 * Pure TypeScript utility for computing a line-level diff between two text strings.
 * Zero external dependencies. Uses a standard O(m×n) LCS DP algorithm.
 */

export type DiffLine =
  | { type: "context"; text: string }
  | { type: "added"; text: string }
  | { type: "removed"; text: string };

export type DiffHunk = {
  lines: DiffLine[];
};

/**
 * Compute the LCS (Longest Common Subsequence) table for two arrays of strings.
 * Returns a 2D DP table where dp[i][j] = LCS length of oldLines[0..i-1] and newLines[0..j-1].
 */
function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Walk the LCS table to produce a flat list of DiffLine entries.
 */
function buildFlatDiff(oldLines: string[], newLines: string[], dp: number[][]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;
  const ops: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "context", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "added", text: newLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "removed", text: oldLines[i - 1] });
      i--;
    }
  }

  // ops is in reverse order — reverse it
  for (let k = ops.length - 1; k >= 0; k--) {
    result.push(ops[k]);
  }

  return result;
}

/**
 * Group a flat list of DiffLine entries into hunks, each containing changed lines
 * plus `contextLines` lines of surrounding context. Adjacent changed regions within
 * `contextLines * 2` lines of each other are merged into a single hunk.
 */
function groupIntoHunks(flatDiff: DiffLine[], contextLines: number): DiffHunk[] {
  // Identify indices of changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < flatDiff.length; i++) {
    if (flatDiff[i].type !== "context") {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) {
    return [];
  }

  // Build hunk ranges [start, end] (inclusive) with context padding
  const ranges: Array<[number, number]> = [];
  let rangeStart = Math.max(0, changedIndices[0] - contextLines);
  let rangeEnd = Math.min(flatDiff.length - 1, changedIndices[0] + contextLines);

  for (let k = 1; k < changedIndices.length; k++) {
    const idx = changedIndices[k];
    const nextStart = Math.max(0, idx - contextLines);
    const nextEnd = Math.min(flatDiff.length - 1, idx + contextLines);

    // Merge if the gap between this range and the next is small enough
    if (nextStart <= rangeEnd + contextLines * 2 + 1) {
      rangeEnd = Math.max(rangeEnd, nextEnd);
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = nextStart;
      rangeEnd = nextEnd;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  return ranges.map(([start, end]) => ({
    lines: flatDiff.slice(start, end + 1),
  }));
}

/**
 * Compute a line-level diff between oldText and newText.
 * Returns an array of hunks (groups of changed lines with surrounding context).
 *
 * @param oldText - The original text
 * @param newText - The new text
 * @param contextLines - Number of unchanged context lines to include around each changed region (default: 2)
 */
export function diffLines(
  oldText: string,
  newText: string,
  contextLines = 2,
): DiffHunk[] {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  if (oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  const dp = buildLcsTable(oldLines, newLines);
  const flatDiff = buildFlatDiff(oldLines, newLines, dp);

  return groupIntoHunks(flatDiff, contextLines);
}

/**
 * Returns true if there are no hunks (texts are identical).
 */
export function isDiffEmpty(hunks: DiffHunk[]): boolean {
  return hunks.length === 0;
}
