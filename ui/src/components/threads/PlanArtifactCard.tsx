/**
 * PlanArtifactCard — special render for plan-type artifacts (markdown content).
 *
 * Distinguished from InlineArtifactCard by:
 *  - Border accent on the left edge
 *  - "Plan" eyebrow label + version pill ("v2 of 5")
 *  - Markdown body rendered via MarkdownBody
 *  - Approve / Request changes CTAs
 */
import { CheckCircle2, FileText, MessageSquareWarning } from "lucide-react";
import { MarkdownBody } from "../MarkdownBody";

interface PlanArtifactCardProps {
  planContent: string;
  currentVersion: number;
  versionCount: number;
  onApprove: () => void;
  onComment: () => void;
  /** Optional plan title (e.g. "Onboarding rewrite plan"). */
  title?: string | null;
}

export function PlanArtifactCard({
  planContent,
  currentVersion,
  versionCount,
  onApprove,
  onComment,
  title,
}: PlanArtifactCardProps) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4 border-l-4 border-l-indigo-500/60"
      data-testid="plan-artifact-card"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <FileText className="h-4 w-4 text-indigo-300" />
        <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-300">
          Plan
        </span>
        {title && (
          <span className="text-sm font-semibold text-foreground truncate">
            {title}
          </span>
        )}
        <span
          className="ml-auto inline-flex items-center rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-300"
          data-testid="plan-artifact-version-pill"
        >
          v{currentVersion} of {versionCount}
        </span>
      </div>

      <div
        className="rounded-md border border-border/60 bg-background/40 p-3 max-h-72 overflow-y-auto"
        data-testid="plan-artifact-body"
      >
        <MarkdownBody className="prose-sm">{planContent}</MarkdownBody>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 transition-colors"
          data-testid="plan-artifact-approve"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Approve plan
        </button>
        <button
          type="button"
          onClick={onComment}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          data-testid="plan-artifact-comment"
        >
          <MessageSquareWarning className="h-3.5 w-3.5" />
          Request changes
        </button>
      </div>
    </div>
  );
}
