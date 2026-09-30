import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import type { Issue, IssueAttachment } from "@armyofagents/shared";
import type { IssueContextBundle } from "../../api/issues";
import { TimelineAttachments } from "./TimelineAttachments";

interface TimelineTaskBriefProps {
  issue: Issue;
  attachments: IssueAttachment[];
  contextBundles: IssueContextBundle[];
  agentName?: string | null;
  onOpenAttachment?: (att: IssueAttachment) => void;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

export function TimelineTaskBrief({
  issue,
  attachments,
  contextBundles,
  agentName,
  onOpenAttachment,
}: TimelineTaskBriefProps) {
  const contextItemCount = contextBundles.reduce((count, bundle) => count + (bundle.items?.length ?? 0), 0);
  const hasContext = contextBundles.length > 0;

  return (
    <article
      className="mr-auto w-full max-w-none min-w-0 px-1 py-1 text-sm text-foreground"
      data-testid="timeline-task-brief"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Task</span>
        {issue.identifier && <span className="font-mono">{issue.identifier}</span>}
        <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] capitalize">
          {statusLabel(issue.status)}
        </Badge>
      </div>

      <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-pre:my-1">
        <p className="font-medium text-foreground">{issue.title}</p>
        {issue.description ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.description}</ReactMarkdown>
        ) : (
          <p className="text-muted-foreground">No task description provided.</p>
        )}
      </div>

      <TimelineAttachments attachments={attachments} testId="timeline-task-attachments" onOpen={onOpenAttachment} />

      {(agentName || hasContext) && (
        <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          {agentName && <div>Assigned to {agentName}</div>}
          {hasContext && (
            <details className="group rounded-lg border border-border/60 bg-background/40 px-2 py-1.5">
              <summary className="cursor-pointer list-none text-muted-foreground">
                Inherited context · {contextItemCount} selected item{contextItemCount === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 space-y-1">
                {contextBundles.map((bundle) => (
                  <div key={bundle.id} className="space-y-1">
                    {bundle.brief && <p className="text-foreground/80">{bundle.brief}</p>}
                    {(bundle.items ?? []).map((item) => (
                      <div key={item.id} className="truncate">
                        {item.itemType}: {item.label ?? item.sourceId ?? item.id}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  );
}
