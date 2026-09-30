/**
 * GitPipelineView — tabular "pipeline" view for the Git Command Centre.
 *
 * One row per branch. Linked-task branches show full detail.
 * Unlinked git-only branches collapse to a secondary strip with a
 * "View all in Map →" shortcut.
 * Done rows are dimmed and hidden behind a toggle.
 */

import React, { useState, useMemo } from "react";
import { cn, relativeTime } from "@/lib/utils";
import { issueStatusText, issueStatusTextDefault } from "@/lib/status-colors";
import type { GitBranchInfo, GitPrReviewState, GitCIStatus } from "@armyofagents/shared";
import { sortBranches, DEFAULT_DIR, type SortKey, type SortDir } from "./git-pipeline-sort";
import { pipelineStageRank } from "./git-tooltip-data";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = ["Changes", "Committed", "Pushed", "PR", "Merged"] as const;

function PipelineDots({ branch }: { branch: GitBranchInfo }) {
  const activeIdx = pipelineStageRank(branch);

  return (
    <div className="flex items-center gap-1" title={PIPELINE_STAGES[activeIdx]}>
      {PIPELINE_STAGES.map((stage, idx) => (
        <div
          key={stage}
          className={cn(
            "w-2 h-2 rounded-full",
            idx < activeIdx
              ? "bg-[#4FB67E]"
              : idx === activeIdx
                ? "bg-[#6470DC]"
                : "bg-[#7E8AA8]/30",
          )}
          title={stage}
        />
      ))}
    </div>
  );
}

function PrBadge({ reviewState }: { reviewState: GitPrReviewState }) {
  const cls: Record<GitPrReviewState, string> = {
    draft: "bg-muted text-muted-foreground",
    open: "bg-blue-500/20 text-blue-400",
    changes_requested: "bg-amber-500/20 text-amber-400",
    approved: "bg-green-500/20 text-green-400",
    merged: "bg-indigo-500/20 text-indigo-400",
    closed: "bg-muted text-muted-foreground",
  };
  const labels: Record<GitPrReviewState, string> = {
    draft: "Draft",
    open: "Open",
    changes_requested: "Changes",
    approved: "Approved",
    merged: "Merged",
    closed: "Closed",
  };
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", cls[reviewState])}>
      {labels[reviewState]}
    </span>
  );
}

function CIBadge({ status, ciUrl }: { status: GitCIStatus; ciUrl: string | null }) {
  if (!status) return null;
  const cls: Record<Exclude<GitCIStatus, null>, string> = {
    pending: "text-amber-400",
    passing: "text-green-400",
    failing: "text-red-400",
  };
  const dots: Record<Exclude<GitCIStatus, null>, string> = {
    pending: "●",
    passing: "✓",
    failing: "✗",
  };
  const inner = (
    <span className={cn("text-[11px] font-mono", cls[status])}>
      {dots[status]}
    </span>
  );
  if (ciUrl && status === "failing") {
    return (
      <a href={ciUrl} target="_blank" rel="noopener noreferrer" className="hover:opacity-80">
        {inner}
      </a>
    );
  }
  return inner;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function BranchRow({
  branch,
  dimmed,
  onOpenIssue,
}: {
  branch: GitBranchInfo;
  dimmed: boolean;
  onOpenIssue?: (id: string) => void;
}) {
  const statusClass = issueStatusText[branch.linkedIssueStatus ?? ""] ?? issueStatusTextDefault;

  return (
    <tr
      className={cn(
        "border-b border-white/5 hover:bg-white/5 transition-colors text-sm",
        dimmed && "opacity-40",
      )}
    >
      {/* Color bar */}
      <td className="w-1 p-0">
        <div
          className="w-1 h-8 rounded-r"
          style={{
            backgroundColor:
              branch.pr?.reviewState === "merged"
                ? "#4FB67E"
                : branch.linkedIssueStatus === "blocked"
                  ? "#ef4444"
                  : "#6470DC",
          }}
        />
      </td>

      {/* Task ID */}
      <td className="px-3 py-2 whitespace-nowrap">
        {branch.linkedIssueIdentifier ? (
          <span className="text-[11px] font-mono text-muted-foreground">
            {branch.linkedIssueIdentifier}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/40">—</span>
        )}
      </td>

      {/* Title */}
      <td className="px-3 py-2 max-w-[220px]">
        <div className="truncate">
          {branch.linkedIssueTitle ?? (
            <span className="text-muted-foreground italic text-xs">No linked task</span>
          )}
        </div>
      </td>

      {/* Branch name */}
      <td className="px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[120px] block">
          {branch.name}
        </span>
      </td>

      {/* Status */}
      <td className="px-3 py-2 whitespace-nowrap">
        {branch.linkedIssueStatus ? (
          <span className={cn("text-xs capitalize", statusClass)}>
            {branch.linkedIssueStatus.replace(/_/g, " ")}
          </span>
        ) : null}
      </td>

      {/* Pipeline dots */}
      <td className="px-3 py-2">
        <PipelineDots branch={branch} />
      </td>

      {/* Ahead/behind */}
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="flex gap-1 text-[11px]">
          {branch.aheadCount > 0 && (
            <span className="text-green-400">↑{branch.aheadCount}</span>
          )}
          {branch.behindCount > 0 && (
            <span className="text-amber-400">↓{branch.behindCount}</span>
          )}
        </div>
      </td>

      {/* Who (git author) */}
      <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">{branch.lastCommitAuthor || "—"}</td>

      {/* Last activity */}
      <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">
        {branch.lastCommitAt ? relativeTime(branch.lastCommitAt) : "—"}
      </td>

      {/* PR badge */}
      <td className="px-3 py-2">
        {branch.pr && <PrBadge reviewState={branch.pr.reviewState} />}
      </td>

      {/* CI badge */}
      <td className="px-3 py-2 text-center">
        {branch.pr && (
          <CIBadge status={branch.pr.ciStatus} ciUrl={branch.pr.ciUrl} />
        )}
      </td>

      {/* Open button */}
      <td className="px-3 py-2">
        {branch.linkedIssueId && onOpenIssue && (
          <button
            className="text-[11px] text-[#6470DC] hover:text-[#8490e8] whitespace-nowrap"
            onClick={() => onOpenIssue(branch.linkedIssueId!)}
          >
            Open →
          </button>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Sort header helper
// ---------------------------------------------------------------------------

function SortHeader({
  label, col, sortKey, sortDir, onSort, align = "left",
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void; align?: "left" | "center";
}) {
  const active = sortKey === col;
  return (
    <th
      className={cn("px-3 py-2 font-normal cursor-pointer select-none hover:text-foreground transition-colors",
        align === "center" ? "text-center" : "text-left", active && "text-foreground")}
      onClick={() => onSort(col)}
    >
      {label}{active && <span className="ml-1 text-[#6470DC]">{sortDir === "asc" ? "▴" : "▾"}</span>}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GitPipelineView({
  branches,
  onOpenIssue,
  onSwitchToMap,
}: {
  branches: GitBranchInfo[];
  onOpenIssue?: (issueId: string) => void;
  onSwitchToMap?: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR.status);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const { active, done, unlinkedSorted } = useMemo(() => {
    const linked = branches.filter((b) => b.linkedIssueId);
    const unlinked = branches.filter((b) => !b.linkedIssueId);
    const activeRaw = linked.filter(
      (b) => b.linkedIssueStatus !== "done" && b.linkedIssueStatus !== "cancelled",
    );
    return {
      active: sortBranches(activeRaw, sortKey, sortDir),
      done: sortBranches(
        linked.filter((b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled"),
        "activity", "desc",
      ),
      unlinkedSorted: sortBranches(unlinked, "activity", "desc"),
    };
  }, [branches, sortKey, sortDir]);

  // Summary counts
  const runningCount = branches.filter((b) => b.linkedIssueStatus === "in_progress").length;
  const reviewCount = branches.filter((b) => b.linkedIssueStatus === "in_review").length;
  const blockedCount = branches.filter((b) => b.linkedIssueStatus === "blocked").length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Summary header */}
      <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
        <span>
          {branches.length} {branches.length === 1 ? "branch" : "branches"}
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FB67E] inline-block" />
            {runningCount} running
          </span>
        )}
        {reviewCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D9A938] inline-block" />
            {reviewCount} in review
          </span>
        )}
        {blockedCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] inline-block" />
            {blockedCount} blocked
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-auto flex-1">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-white/10 text-[11px] text-muted-foreground uppercase tracking-wider">
              <th className="w-1" />
              <SortHeader label="ID" col="id" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-3 py-2 text-left font-normal">Task</th>
              <th className="px-3 py-2 text-left font-normal">Branch</th>
              <SortHeader label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Pipeline" col="pipeline" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="±" col="ahead" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Who" col="who" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <SortHeader label="Last activity" col="activity" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-3 py-2 text-left font-normal">PR</th>
              <th className="px-3 py-2 text-center font-normal">CI</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {active.map((b) => (
              <BranchRow key={b.name} branch={b} dimmed={false} onOpenIssue={onOpenIssue} />
            ))}

            {/* Done rows toggle */}
            {done.length > 0 && (
              <>
                <tr>
                  <td colSpan={12} className="px-3 py-1.5">
                    <button
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowDone((v) => !v)}
                    >
                      {showDone ? "▾" : "▸"} Show done ({done.length})
                    </button>
                  </td>
                </tr>
                {showDone &&
                  done.map((b) => (
                    <BranchRow key={b.name} branch={b} dimmed onOpenIssue={onOpenIssue} />
                  ))}
              </>
            )}

            {/* Unlinked git-only branches */}
            {unlinkedSorted.length > 0 && (
              <>
                <tr>
                  <td colSpan={12} className="px-3 py-1.5 border-t border-white/10">
                    <div className="flex items-center justify-between">
                      <button
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowUnlinked((v) => !v)}
                      >
                        {showUnlinked ? "▾" : "▸"} Git-only branches ({unlinkedSorted.length})
                      </button>
                      {onSwitchToMap && (
                        <button
                          className="text-[11px] text-[#6470DC] hover:text-[#8490e8] transition-colors"
                          onClick={onSwitchToMap}
                        >
                          View all in Map →
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {showUnlinked &&
                  unlinkedSorted.map((b) => (
                    <BranchRow key={b.name} branch={b} dimmed />
                  ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
