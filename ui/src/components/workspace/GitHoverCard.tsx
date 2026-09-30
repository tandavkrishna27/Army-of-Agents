/**
 * GitHoverCard — tooltip overlay for the Git Command Centre canvas.
 *
 * Rendered via createPortal into document.body so it escapes the canvas
 * overflow boundary. Position is clamped to viewport edges to prevent
 * off-screen rendering.
 *
 * Supports 6 node types:
 *   task        — linked task branch tip (card marker)
 *   commit      — regular commit circle
 *   merge       — merge commit diamond
 *   tag         — version tag pill
 *   plain_tip   — branch tip with no linked task
 *   remote_marker — remote tracking ref
 */

import React from "react";
import { createPortal } from "react-dom";
import { cn, relativeTime } from "@/lib/utils";
import { issueStatusText, issueStatusTextDefault } from "@/lib/status-colors";
import { pipelineStageRank, parseMergeMessage, commitBranchContext, type TrunkSummary } from "./git-tooltip-data";
import type {
  GitBranchInfo,
  GitCommitNode,
  GitCIStatus,
  GitPrReviewState,
  GitPipelineStage,
} from "@armyofagents/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HoveredNode =
  | { type: "task"; branch: GitBranchInfo }
  | { type: "commit"; commit: GitCommitNode }
  | { type: "merge"; commit: GitCommitNode; defaultBranch?: string }
  | { type: "tag"; name: string; sha: string; date: string }
  | { type: "plain_tip"; branch: GitBranchInfo }
  | { type: "remote_marker"; branch: GitBranchInfo }
  | { type: "trunk"; branch: GitBranchInfo | null; summary: TrunkSummary }
  | { type: "cluster"; branches: GitBranchInfo[]; total: number };

interface GitHoverCardProps {
  node: HoveredNode | null;
  position: { x: number; y: number };
  onOpenTask?: (issueId: string) => void;
  /** Called when the cluster card's "Open Pipeline" button is clicked. */
  onOpenPipeline?: () => void;
  /** Called when the cursor enters the card — used to cancel dismiss timer. */
  onMouseEnter?: () => void;
  /** Called when the cursor leaves the card — used to restart dismiss timer. */
  onMouseLeave?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CARD_WIDTH = 320;
const CARD_HEIGHT_APPROX = 240;

const PR_REVIEW_LABELS: Record<GitPrReviewState, string> = {
  draft: "Draft",
  open: "Open",
  changes_requested: "Changes requested",
  approved: "Approved",
  merged: "Merged",
  closed: "Closed",
};

const PR_REVIEW_COLORS: Record<GitPrReviewState, string> = {
  draft: "text-muted-foreground",
  open: "text-blue-400",
  changes_requested: "text-amber-400",
  approved: "text-green-400",
  merged: "text-indigo-400",
  closed: "text-muted-foreground",
};

const CI_LABELS: Record<Exclude<GitCIStatus, null>, string> = {
  pending: "CI pending",
  passing: "CI passing",
  failing: "CI failing",
};

const CI_COLORS: Record<Exclude<GitCIStatus, null>, string> = {
  pending: "text-amber-400",
  passing: "text-green-400",
  failing: "text-red-400",
};

const STAGE_NAMES: GitPipelineStage[] = ["dirty", "committed", "pushed", "pr_open", "merged"];

/** Map branch → pipeline stage using the single-source pipelineStageRank. */
function deriveStage(branch: GitBranchInfo): GitPipelineStage {
  return STAGE_NAMES[pipelineStageRank(branch)]!;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PIPELINE_STAGES: Array<{ key: GitPipelineStage; label: string }> = [
  { key: "dirty", label: "Changes" },
  { key: "committed", label: "Committed" },
  { key: "pushed", label: "Pushed" },
  { key: "pr_open", label: "PR" },
  { key: "merged", label: "Merged" },
];

const STAGE_ORDER: Record<GitPipelineStage, number> = {
  dirty: 0,
  committed: 1,
  pushed: 2,
  pr_open: 3,
  merged: 4,
};

function PipelineSteps({ stage }: { stage: GitPipelineStage }) {
  const currentIdx = STAGE_ORDER[stage];
  return (
    <div className="flex items-center gap-1 mt-1">
      {PIPELINE_STAGES.map((s, idx) => (
        <React.Fragment key={s.key}>
          <div className="flex flex-col items-center gap-0.5">
            <div
              className={cn(
                "w-2 h-2 rounded-full border",
                idx < currentIdx
                  ? "bg-[#4FB67E] border-[#4FB67E]"
                  : idx === currentIdx
                    ? "bg-[#6470DC] border-[#6470DC] ring-2 ring-[#6470DC]/30"
                    : "bg-transparent border-[#7E8AA8]",
              )}
            />
            <span className="text-[9px] text-muted-foreground leading-none">{s.label}</span>
          </div>
          {idx < PIPELINE_STAGES.length - 1 && (
            <div
              className={cn(
                "flex-1 h-px mb-3",
                idx < currentIdx ? "bg-[#4FB67E]/60" : "bg-[#7E8AA8]/40",
              )}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function IssueStatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize",
        issueStatusText[status] ?? issueStatusTextDefault,
        "bg-current/10",
      )}
    >
      {label}
    </span>
  );
}

function PrRow({ pr }: { pr: GitBranchInfo["pr"] }) {
  if (!pr) return null;
  return (
    <div className="flex items-center justify-between text-xs mt-1 pt-1 border-t border-white/10">
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:underline font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>
      <div className="flex items-center gap-2">
        <span className={PR_REVIEW_COLORS[pr.reviewState]}>
          {PR_REVIEW_LABELS[pr.reviewState]}
        </span>
        {pr.ciStatus && (
          <span className={CI_COLORS[pr.ciStatus]}>{CI_LABELS[pr.ciStatus]}</span>
        )}
        {pr.commentCount > 0 && (
          <span className="text-muted-foreground">{pr.commentCount} comments</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card variants
// ---------------------------------------------------------------------------

function TaskCard({
  branch,
  onOpenTask,
}: {
  branch: GitBranchInfo;
  onOpenTask?: (id: string) => void;
}) {
  const stage = deriveStage(branch);

  return (
    <div className="space-y-1.5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {branch.linkedIssueIdentifier && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {branch.linkedIssueIdentifier}
            </span>
          )}
          <p className="text-sm font-medium leading-tight truncate">
            {branch.linkedIssueTitle ?? branch.name}
          </p>
        </div>
        <IssueStatusPill status={branch.linkedIssueStatus} />
      </div>

      {/* Branch name */}
      <p className="text-[11px] font-mono text-muted-foreground truncate">{branch.name}</p>

      {/* Who (git author) + relative time */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{branch.lastCommitAuthor || "unknown"}</span>
        {branch.lastCommitAt && <span>· last commit {relativeTime(branch.lastCommitAt)}</span>}
      </div>

      {/* Pipeline progress */}
      <PipelineSteps stage={stage} />

      {/* Ahead/behind */}
      {(branch.aheadCount > 0 || branch.behindCount > 0) && (
        <div className="flex gap-3 text-[11px]">
          {branch.aheadCount > 0 && (
            <span className="text-green-400">↑{branch.aheadCount} ahead</span>
          )}
          {branch.behindCount > 0 && (
            <span className="text-amber-400">↓{branch.behindCount} behind</span>
          )}
        </div>
      )}

      {/* Overlays */}
      {(branch.overlays.isDiverged || branch.overlays.hasConflicts) && (
        <div className="text-[11px] text-red-400">
          {branch.overlays.hasConflicts ? "⚠ Merge conflicts" : "⚠ Diverged from remote"}
        </div>
      )}

      {/* Planning mode */}
      {branch.linkedIssueWorkMode === "planning" && (
        <div className="text-[11px] text-amber-400">Planning mode — auto-dispatch paused</div>
      )}

      {/* PR row */}
      <PrRow pr={branch.pr} />

      {/* Tags */}
      {branch.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {branch.tags.map((tag) => (
            <span
              key={tag}
              className="px-1 py-0.5 rounded bg-[#6470DC]/20 text-[#6470DC] text-[10px] font-mono"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Open task button */}
      {branch.linkedIssueId && onOpenTask && (
        <button
          className="w-full mt-1 py-1 rounded text-xs bg-[#6470DC]/20 hover:bg-[#6470DC]/30 text-[#6470DC] transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTask(branch.linkedIssueId!);
          }}
        >
          Open task →
        </button>
      )}

      {/* Open PR (separate from Open task) */}
      {branch.pr && (
        <a
          href={branch.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full mt-1.5 py-1 rounded text-xs text-center border border-white/10 text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          Open PR ↗
        </a>
      )}
    </div>
  );
}

function CommitCard({ commit }: { commit: GitCommitNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-mono text-muted-foreground">{commit.shortSha}</p>
      <p className="text-sm font-medium leading-snug">{commit.message}</p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{commit.author}</span>
        <span>{commit.committedAt ? relativeTime(commit.committedAt) : ""}</span>
      </div>
      {commitBranchContext(commit) && (
        <p className="text-[11px] text-muted-foreground">on <span className="font-mono text-foreground/70">{commitBranchContext(commit)}</span></p>
      )}
      {commit.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {commit.tags.map((tag) => (
            <span
              key={tag}
              className="px-1 py-0.5 rounded bg-[#D9A938]/20 text-[#D9A938] text-[10px] font-mono"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PlainTipCard({ branch }: { branch: GitBranchInfo }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-mono font-medium">{branch.name}</p>
      <p className="text-[11px] text-muted-foreground leading-snug truncate">
        {branch.lastCommitMessage}
      </p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{branch.lastCommitAuthor}</span>
        <span>{new Date(branch.lastCommitAt).toLocaleDateString()}</span>
      </div>
      {(branch.aheadCount > 0 || branch.behindCount > 0) && (
        <div className="flex gap-3 text-[11px]">
          {branch.aheadCount > 0 && (
            <span className="text-green-400">↑{branch.aheadCount} ahead</span>
          )}
          {branch.behindCount > 0 && (
            <span className="text-amber-400">↓{branch.behindCount} behind</span>
          )}
        </div>
      )}
      <PrRow pr={branch.pr} />
    </div>
  );
}

function TagCard({ name, sha, date }: { name: string; sha: string; date: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-[#D9A938]/20 text-[#D9A938] text-xs font-mono">
          {name}
        </span>
        <span className="text-[11px] text-muted-foreground font-mono">{sha.slice(0, 8)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {new Date(date).toLocaleDateString()}
      </p>
    </div>
  );
}

function MergeCard({ commit, defaultBranch }: { commit: GitCommitNode; defaultBranch: string }) {
  const m = parseMergeMessage(commit.message, defaultBranch);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#6470DC]">⑃ Merge</div>
      {m.source && (
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-foreground/80">{m.source}</span>
          <span className="text-muted-foreground">→</span>
          <span className="text-[#4FB67E]">{m.target}</span>
        </div>
      )}
      <p className="text-sm font-medium leading-snug">{commit.message}</p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>
          {m.prNumber != null && <span className="text-blue-400 font-mono">PR #{m.prNumber} · </span>}
          <span className="font-mono">{commit.shortSha}</span>
        </span>
        <span>{commit.committedAt ? relativeTime(commit.committedAt) : ""}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">by {commit.author || "unknown"}</p>
    </div>
  );
}

function RemoteCard({ branch }: { branch: GitBranchInfo }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-mono font-medium">{branch.name}</p>
      <span className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-dashed border-[#5a6172] text-muted-foreground">
        remote only · not checked out
      </span>
      <p className="text-[11px] text-muted-foreground leading-snug truncate mt-1">{branch.lastCommitMessage}</p>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{branch.lastCommitAuthor || "unknown"}</span>
        <span>{branch.lastCommitAt ? relativeTime(branch.lastCommitAt) : ""}</span>
      </div>
      <p className="text-[11px] text-muted-foreground/70 pt-1">Pull to work on it locally</p>
    </div>
  );
}

function TrunkCard({ branch, summary }: { branch: GitBranchInfo | null; summary: TrunkSummary }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium text-sm text-[#4FB67E]">{branch?.name ?? "main"}</span>
        <span className="text-[10px] text-muted-foreground">default</span>
      </div>
      {summary.latestCommit && (
        <>
          <p className="text-[13px] font-medium leading-snug truncate">{summary.latestCommit.message}</p>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span className="font-mono">{summary.latestCommit.shortSha}</span>
            <span>{summary.latestCommit.committedAt ? `updated ${relativeTime(summary.latestCommit.committedAt)}` : ""}</span>
          </div>
        </>
      )}
      <div className="pt-1 mt-1 border-t border-white/10 text-[11px] text-muted-foreground">
        {summary.commitCount} commits · {summary.contributorCount} contributors · {summary.activeBranchCount} active branches
      </div>
    </div>
  );
}

function ClusterCard({ branches, total, onOpenPipeline }: { branches: GitBranchInfo[]; total: number; onOpenPipeline?: () => void }) {
  const shown = branches.slice(0, 8);
  const dotColor = (s: string | null) =>
    s === "blocked" ? "#ef4444" : s === "in_review" ? "#D9A938" : s === "in_progress" ? "#4FB67E" : "#5a6172";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{total} more branches</span>
        <span className="text-[10px] text-muted-foreground">at this commit</span>
      </div>
      <div className="mt-1 max-h-[150px] overflow-auto border-t border-white/10 pt-1.5 space-y-0.5">
        {shown.map((b) => (
          <div key={b.name} className="flex items-center gap-2 text-xs py-0.5">
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: dotColor(b.linkedIssueStatus) }} />
            <span className="font-mono text-[11px] truncate">{b.linkedIssueIdentifier ?? b.name}</span>
            {b.lastCommitAt && <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(b.lastCommitAt)}</span>}
          </div>
        ))}
        {branches.length > shown.length && (
          <div className="text-[10px] text-muted-foreground pl-3">…and {branches.length - shown.length} more</div>
        )}
      </div>
      {onOpenPipeline && (
        <button
          className="w-full mt-1 py-1 rounded text-xs bg-[#6470DC]/20 hover:bg-[#6470DC]/30 text-[#6470DC] transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpenPipeline(); }}
        >
          Open all {total} in Pipeline →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GitHoverCard({ node, position, onOpenTask, onOpenPipeline, onMouseEnter, onMouseLeave }: GitHoverCardProps) {
  if (!node) return null;

  // Clamp to viewport
  const clampedX = Math.min(position.x, window.innerWidth - CARD_WIDTH - 12);
  const clampedY = Math.min(position.y + 12, window.innerHeight - CARD_HEIGHT_APPROX - 12);

  const content = (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{ left: clampedX, top: clampedY, width: CARD_WIDTH }}
    >
      <div
        className={cn(
          "rounded-lg border border-white/10 bg-[#1a1917] shadow-xl shadow-black/40",
          "p-3 text-foreground pointer-events-auto",
        )}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {node.type === "task" && <TaskCard branch={node.branch} onOpenTask={onOpenTask} />}
        {node.type === "commit" && <CommitCard commit={node.commit} />}
        {node.type === "merge" && <MergeCard commit={node.commit} defaultBranch={node.defaultBranch ?? "main"} />}
        {node.type === "tag" && <TagCard name={node.name} sha={node.sha} date={node.date} />}
        {node.type === "plain_tip" && <PlainTipCard branch={node.branch} />}
        {node.type === "remote_marker" && <RemoteCard branch={node.branch} />}
        {node.type === "trunk" && <TrunkCard branch={node.branch} summary={node.summary} />}
        {node.type === "cluster" && <ClusterCard branches={node.branches} total={node.total} onOpenPipeline={onOpenPipeline} />}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
