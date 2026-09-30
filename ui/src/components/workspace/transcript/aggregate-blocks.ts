// ui/src/components/workspace/transcript/aggregate-blocks.ts

import type {
  TranscriptBlock,
  AggregatedGroup,
  DisplayBlock,
  DepartmentType,
  EntryCategory,
} from "./types";
import { AGGREGATABLE_CATEGORIES } from "./types";
import { classifyToolEntry } from "./classify-entry";

/** Extract file path from tool input for edit grouping */
export function extractFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/** Parse +/- stats from tool result text */
export function parseEditStats(result: string | undefined): { additions: number; deletions: number } {
  if (!result) return { additions: 0, deletions: 0 };
  const addMatch = result.match(/\+(\d+)/);
  const delMatch = result.match(/-(\d+)/);
  return {
    additions: addMatch ? parseInt(addMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

type ToolBlock = Extract<TranscriptBlock, { type: "tool" }>;
type ThinkingBlock = Extract<TranscriptBlock, { type: "thinking" }>;

interface PendingGroup {
  category: EntryCategory;
  items: ToolBlock[];
  /** For file_edit: tracks all distinct file paths */
  filePaths: Set<string>;
}

function flushToolGroup(pending: PendingGroup): DisplayBlock[] {
  const { category, items, filePaths } = pending;
  if (items.length < 2) return items;

  switch (category) {
    case "file_read":
      return [{ type: "read_group", items, count: items.length }];

    case "file_edit": {
      if (filePaths.size === 1) {
        const filePath = [...filePaths][0]!;
        let totalAdditions = 0;
        let totalDeletions = 0;
        for (const item of items) {
          const stats = parseEditStats(item.result);
          totalAdditions += stats.additions;
          totalDeletions += stats.deletions;
        }
        return [{ type: "edit_group", filePath, items, totalAdditions, totalDeletions }];
      }
      return [{ type: "multi_edit_group", items, fileCount: filePaths.size }];
    }

    case "search":
      return [{ type: "search_group", items, count: items.length }];

    case "web":
      return [{ type: "web_group", items, count: items.length }];

    case "command":
      return [{ type: "command_group_agg", items, count: items.length }];

    default:
      return [{ type: "generic_group", category, items, count: items.length }];
  }
}

function flushThinkingGroup(items: ThinkingBlock[]): DisplayBlock[] {
  if (items.length < 2) return items;
  return [{ type: "thinking_group", items, isPreviousTurn: false }];
}

export function aggregateBlocks(
  blocks: TranscriptBlock[],
  departmentType: DepartmentType,
): DisplayBlock[] {
  const result: DisplayBlock[] = [];
  let pendingTool: PendingGroup | null = null;
  let pendingThinking: ThinkingBlock[] = [];

  const flushAllPending = () => {
    if (pendingThinking.length > 0) {
      result.push(...flushThinkingGroup(pendingThinking));
      pendingThinking = [];
    }
    if (pendingTool) {
      result.push(...flushToolGroup(pendingTool));
      pendingTool = null;
    }
  };

  for (const block of blocks) {
    // Thinking blocks — accumulate separately
    if (block.type === "thinking") {
      // Flush any pending tool group first
      if (pendingTool) {
        result.push(...flushToolGroup(pendingTool));
        pendingTool = null;
      }
      pendingThinking.push(block);
      continue;
    }

    // Non-thinking block — flush any pending thinking
    if (pendingThinking.length > 0) {
      result.push(...flushThinkingGroup(pendingThinking));
      pendingThinking = [];
    }

    // Non-tool blocks pass through
    if (block.type !== "tool") {
      if (pendingTool) {
        result.push(...flushToolGroup(pendingTool));
        pendingTool = null;
      }
      result.push(block);
      continue;
    }

    const category = classifyToolEntry(block.name, block.input, departmentType);

    // Only aggregate categories in the AGGREGATABLE set
    if (!AGGREGATABLE_CATEGORIES.has(category)) {
      if (pendingTool) {
        result.push(...flushToolGroup(pendingTool));
        pendingTool = null;
      }
      result.push(block);
      continue;
    }

    // Start or continue a tool group
    if (pendingTool && pendingTool.category === category) {
      pendingTool.items.push(block);
      if (category === "file_edit") {
        const fp = extractFilePath(block.input);
        if (fp) pendingTool.filePaths.add(fp);
      }
    } else {
      if (pendingTool) {
        result.push(...flushToolGroup(pendingTool));
      }
      const filePaths = new Set<string>();
      if (category === "file_edit") {
        const fp = extractFilePath(block.input);
        if (fp) filePaths.add(fp);
      }
      pendingTool = { category, items: [block], filePaths };
    }
  }

  // Flush remaining
  flushAllPending();

  // Post-pass: mark all thinking_groups as isPreviousTurn except the last one
  let lastThinkingGroupFound = false;
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i];
    if (block.type === "thinking_group") {
      if (!lastThinkingGroupFound) {
        lastThinkingGroupFound = true;
        // Last thinking_group stays isPreviousTurn: false (current turn)
      } else {
        // Earlier thinking_groups are previous turns
        (block as Extract<AggregatedGroup, { type: "thinking_group" }>).isPreviousTurn = true;
      }
    }
  }

  return result;
}
