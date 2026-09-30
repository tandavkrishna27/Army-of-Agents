import type { AggregatedGroup, DisplayBlock, TranscriptBlock } from "./types";

export interface LiveRunState {
  phaseLabel: string;
  currentStepText: string | null;
  summaryItems: string[];
}

interface LiveRunStateOptions {
  isRunning: boolean;
}

interface RunCounts {
  reads: number;
  searches: number;
  commands: number;
  editedFiles: number;
  diagnostics: number;
  errors: number;
}

export function deriveLiveRunState(
  blocks: DisplayBlock[],
  options: LiveRunStateOptions,
): LiveRunState {
  const counts = countBlocks(blocks);
  const phaseLabel = derivePhaseLabel(blocks, counts, options.isRunning);
  const currentStepText = options.isRunning
    ? deriveCurrentStepText(blocks, phaseLabel)
    : null;

  return {
    phaseLabel,
    currentStepText,
    summaryItems: buildSummaryItems(counts),
  };
}

function countBlocks(blocks: DisplayBlock[]): RunCounts {
  const counts: RunCounts = {
    reads: 0,
    searches: 0,
    commands: 0,
    editedFiles: 0,
    diagnostics: 0,
    errors: 0,
  };

  for (const block of blocks) {
    switch (block.type) {
      case "read_group":
        counts.reads += block.count;
        break;
      case "search_group":
        counts.searches += block.count;
        break;
      case "command_group_agg":
      case "command_group":
        counts.commands += block.items.length || ("count" in block ? block.count : 0);
        break;
      case "edit_group":
        counts.editedFiles += 1;
        break;
      case "multi_edit_group":
        counts.editedFiles += block.fileCount;
        break;
      case "diagnostic_group":
        counts.diagnostics += block.lines.length;
        break;
      case "stderr_group":
        counts.errors += block.lines.length;
        break;
      case "tool":
        countTool(block, counts);
        break;
      case "tool_group":
      case "generic_group":
      case "web_group":
        countToolGroup(block, counts);
        break;
    }
  }

  return counts;
}

function countTool(block: Extract<TranscriptBlock, { type: "tool" }>, counts: RunCounts) {
  const lowerName = block.name.toLowerCase();
  if (isCommandName(lowerName, block.input)) {
    counts.commands += 1;
    return;
  }
  if (isEditName(lowerName)) {
    counts.editedFiles += 1;
    return;
  }
  if (isReadName(lowerName)) {
    counts.reads += 1;
    return;
  }
  if (isSearchName(lowerName)) {
    counts.searches += 1;
  }
}

function countToolGroup(
  block: Extract<TranscriptBlock, { type: "tool_group" }> | Extract<AggregatedGroup, { type: "generic_group" | "web_group" }>,
  counts: RunCounts,
) {
  for (const item of block.items) {
    countTool(item as Extract<TranscriptBlock, { type: "tool" }>, counts);
  }
}

function derivePhaseLabel(blocks: DisplayBlock[], counts: RunCounts, isRunning: boolean): string {
  if (!isRunning && counts.errors > 0) return "Failed";
  const latest = [...blocks].reverse().find((block) => block.type !== "diagnostic_group");
  if (!latest) return isRunning ? "Starting" : "Completed";

  if (hasRunningTool(latest)) {
    return phaseForBlock(latest);
  }
  if (isRunning) {
    return phaseForBlock(latest);
  }
  return "Completed";
}

function deriveCurrentStepText(blocks: DisplayBlock[], phaseLabel: string): string | null {
  const latest = [...blocks].reverse().find((block) => block.type !== "diagnostic_group");
  if (!latest) return "Starting agent";

  switch (latest.type) {
    case "tool_group":
    case "generic_group": {
      const groupCounts = countToolItems(latest.items);
      if (groupCounts.editedFiles > 0) return `Editing ${pluralize(groupCounts.editedFiles, "file")}`;
      if (groupCounts.commands > 0) return groupCounts.commands > 1 ? `Running ${pluralize(groupCounts.commands, "command")}` : "Running command";
      if (groupCounts.reads > 0) return `Reading ${pluralize(groupCounts.reads, "file")}`;
      if (groupCounts.searches > 0) return `Searching ${pluralize(groupCounts.searches, "place")}`;
      return phaseLabel;
    }
    case "multi_edit_group":
      return `Editing ${pluralize(latest.fileCount, "file")}`;
    case "edit_group":
      return `Editing ${latest.filePath}`;
    case "read_group":
      return `Reading ${pluralize(latest.count, "file")}`;
    case "search_group":
      return `Searching ${pluralize(latest.count, "place")}`;
    case "command_group":
    case "command_group_agg":
      return latest.items.length > 1 ? `Running ${pluralize(latest.items.length, "command")}` : "Running command";
    case "thinking":
    case "thinking_group":
      return "Thinking";
    case "message":
      return latest.streaming ? "Writing response" : null;
    case "tool":
      return phaseLabel;
    case "stderr_group":
      return "Handling error";
    default:
      return phaseLabel === "Starting" ? "Starting agent" : phaseLabel;
  }
}

function phaseForBlock(block: DisplayBlock): string {
  switch (block.type) {
    case "tool_group":
    case "generic_group": {
      const groupCounts = countToolItems(block.items);
      if (groupCounts.editedFiles > 0) return "Editing";
      if (groupCounts.commands > 0) return "Running command";
      if (groupCounts.reads > 0) return "Reading";
      if (groupCounts.searches > 0) return "Searching";
      return "Using tool";
    }
    case "multi_edit_group":
    case "edit_group":
      return "Editing";
    case "read_group":
      return "Reading";
    case "search_group":
      return "Searching";
    case "command_group":
    case "command_group_agg":
      return "Running command";
    case "thinking":
    case "thinking_group":
      return "Thinking";
    case "message":
      return "Writing";
    case "stderr_group":
      return "Error";
    case "tool":
      return phaseForTool(block);
    default:
      return "Working";
  }
}

function countToolItems(items: Array<Extract<TranscriptBlock, { type: "tool" }> | Extract<TranscriptBlock, { type: "tool_group" }>["items"][number]>): RunCounts {
  const counts: RunCounts = {
    reads: 0,
    searches: 0,
    commands: 0,
    editedFiles: 0,
    diagnostics: 0,
    errors: 0,
  };
  for (const item of items) {
    countTool(item as Extract<TranscriptBlock, { type: "tool" }>, counts);
  }
  return counts;
}

function phaseForTool(block: Extract<TranscriptBlock, { type: "tool" }>): string {
  const lowerName = block.name.toLowerCase();
  if (isEditName(lowerName)) return "Editing";
  if (isReadName(lowerName)) return "Reading";
  if (isSearchName(lowerName)) return "Searching";
  if (isCommandName(lowerName, block.input)) return "Running command";
  return "Using tool";
}

function hasRunningTool(block: DisplayBlock): boolean {
  if (block.type === "tool") return block.status === "running";
  if ("items" in block && Array.isArray(block.items)) {
    return block.items.some((item) => "status" in item && item.status === "running");
  }
  return false;
}

function buildSummaryItems(counts: RunCounts): string[] {
  const items: string[] = [];
  if (counts.editedFiles > 0) items.push(`${pluralize(counts.editedFiles, "file")} edited`);
  if (counts.commands > 0) items.push(pluralize(counts.commands, "command"));
  if (counts.reads > 0) items.push(`${pluralize(counts.reads, "file")} read`);
  if (counts.searches > 0) items.push(pluralize(counts.searches, "search", "searches"));
  if (counts.diagnostics > 0) items.push(pluralize(counts.diagnostics, "diagnostic"));
  if (counts.errors > 0) items.push(pluralize(counts.errors, "error"));
  return items;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isCommandName(lowerName: string, input: unknown): boolean {
  if (lowerName.includes("command") || lowerName.includes("shell") || lowerName === "bash") return true;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    return typeof record.command === "string" || typeof record.cmd === "string";
  }
  return false;
}

function isEditName(lowerName: string): boolean {
  return lowerName.includes("edit") || lowerName.includes("write") || lowerName.includes("patch");
}

function isReadName(lowerName: string): boolean {
  return lowerName.includes("read") || lowerName.includes("open");
}

function isSearchName(lowerName: string): boolean {
  return lowerName.includes("search") || lowerName.includes("grep");
}
