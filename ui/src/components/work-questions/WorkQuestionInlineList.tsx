import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { workQuestionsApi, type WorkQuestionListOptions } from "@/api/work-questions";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { WorkQuestionPanel } from "./WorkQuestionPanel";

export type WorkQuestionSource = Pick<
  WorkQuestionListOptions,
  "issueId" | "sourceDiscussionId" | "executionWorkspaceId" | "sourceCommanderConversationId"
>;

export interface WorkQuestionInlineListProps {
  companyId: string;
  source: WorkQuestionSource;
  className?: string;
}

function sourceKey(source: WorkQuestionSource) {
  return [
    source.issueId ?? null,
    source.sourceDiscussionId ?? null,
    source.executionWorkspaceId ?? null,
    source.sourceCommanderConversationId ?? null,
  ] as const;
}

export function useInlineWorkQuestions(companyId: string, source: WorkQuestionSource) {
  const hasSource = Object.values(source).some(Boolean);
  return useQuery({
    queryKey: [...queryKeys.workQuestions.all(companyId), "inline", ...sourceKey(source)],
    queryFn: async () => {
      const result = await workQuestionsApi.listInline(companyId, { ...source, scope: "all" });
      if (!Array.isArray(result)) throw new Error("Inline question response was not a list");
      return result;
    },
    enabled: Boolean(companyId && hasSource),
    refetchInterval: 5_000,
  });
}

export function WorkQuestionInlineError({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-y border-border px-4 py-3", className)} role="alert">
      <p className="text-sm text-destructive">Questions from this work could not be loaded.</p>
      <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

export function WorkQuestionInlineList({ companyId, source, className }: WorkQuestionInlineListProps) {
  const hasSource = Object.values(source).some(Boolean);
  const questionsQuery = useInlineWorkQuestions(companyId, source);

  if (!hasSource || questionsQuery.isLoading) {
    return null;
  }

  if (questionsQuery.isError) {
    return <WorkQuestionInlineError className={className} onRetry={() => void questionsQuery.refetch()} />;
  }

  const questions = Array.isArray(questionsQuery.data) ? questionsQuery.data : [];
  if (questions.length === 0) return null;

  return (
    <div
      className={cn("grid gap-3", className)}
      aria-label="Questions from this work"
      data-testid="work-question-inline-list"
    >
      {questions.map((detail) => (
        <WorkQuestionPanel
          key={detail.question.id}
          companyId={companyId}
          questionId={detail.question.id}
          initialDetail={detail}
        />
      ))}
    </div>
  );
}
