import type { IssueComment } from "@armyofagents/shared";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn, formatDateTime } from "../lib/utils";
import { formatNoticeKey, formatNoticeValue } from "../lib/system-notice-comment";

const toneStyles = {
  info: {
    icon: Info,
    className: "border-border bg-muted/35 text-muted-foreground",
    iconClassName: "text-muted-foreground",
  },
  success: {
    icon: CheckCircle2,
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
  danger: {
    icon: XCircle,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    iconClassName: "text-destructive",
  },
} as const;

export function SystemNotice({ comment }: { comment: IssueComment }) {
  const tone = comment.presentation?.tone ?? "info";
  const style = toneStyles[tone] ?? toneStyles.info;
  const Icon = style.icon;
  const title = comment.presentation?.title ?? "System notice";
  const sections = comment.metadata?.version === 1 ? comment.metadata.sections : [];
  const hasDetails = sections.length > 0;

  return (
    <section
      id={`comment-${comment.id}`}
      data-testid="system-notice-comment"
      className={cn("rounded-md border px-3 py-2 text-sm", style.className)}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", style.iconClassName)} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-5 text-foreground">{title}</p>
            <a
              href={`#comment-${comment.id}`}
              className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            >
              {formatDateTime(comment.createdAt)}
            </a>
          </div>
          {comment.body ? <p className="text-xs leading-5 text-muted-foreground">{comment.body}</p> : null}
          {hasDetails ? (
            <details open={comment.presentation?.detailsDefaultOpen} className="group pt-1">
              <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                Details
              </summary>
              <div className="mt-2 space-y-2">
                {sections.map((section, sectionIndex) => (
                  <div key={`${section.title}-${sectionIndex}`} className="space-y-1">
                    <p className="text-xs font-medium text-foreground">{section.title}</p>
                    <div className="space-y-1">
                      {section.rows.map((row, rowIndex) => (
                        <dl
                          key={rowIndex}
                          className="grid gap-x-3 gap-y-1 rounded-sm border border-border/60 bg-background/45 px-2 py-1.5 text-xs sm:grid-cols-[max-content_1fr]"
                        >
                          {Object.entries(row).map(([key, value]) => (
                            <div key={key} className="contents">
                              <dt className="text-muted-foreground">{formatNoticeKey(key)}</dt>
                              <dd className="min-w-0 break-words text-foreground">{formatNoticeValue(value)}</dd>
                            </div>
                          ))}
                        </dl>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
