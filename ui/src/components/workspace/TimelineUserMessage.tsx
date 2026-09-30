import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Identity } from "../Identity";
import { cn, relativeTime } from "@/lib/utils";
import type { IssueAttachment, IssueComment } from "@armyofagents/shared";
import { TimelineAttachments } from "./TimelineAttachments";

interface TimelineUserMessageProps {
  comment: IssueComment;
  authorName: string;
  isAgent?: boolean;
  attachments?: IssueAttachment[];
  onOpenAttachment?: (att: IssueAttachment) => void;
}

export function TimelineUserMessage({
  comment,
  authorName,
  isAgent = false,
  attachments = [],
  onOpenAttachment,
}: TimelineUserMessageProps) {
  return (
    <div
      className={cn("min-w-0", isAgent ? "mr-auto w-full max-w-none" : "ml-auto max-w-[80%]")}
      data-testid={`timeline-comment-${comment.id}`}
    >
      <div
        className={cn(
          "overflow-x-auto text-sm prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-1",
          isAgent
            ? "bg-transparent px-1 py-1 text-foreground"
            : "rounded-2xl bg-card px-3 py-2 text-card-foreground shadow-sm",
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
        <TimelineAttachments
          attachments={attachments}
          testId={`timeline-comment-attachments-${comment.id}`}
          onOpen={onOpenAttachment}
        />
        <div className={cn("flex items-center gap-1.5 mt-1 not-prose", isAgent ? "justify-start" : "justify-end")}>
          <Identity name={authorName} size="xs" />
          <span className="text-[10px] text-muted-foreground">/</span>
          <span className="text-[10px] text-muted-foreground">{relativeTime(comment.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}
