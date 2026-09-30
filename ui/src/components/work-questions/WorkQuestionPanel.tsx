import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, RotateCcw, UserRoundCheck } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { workQuestionsApi } from "@/api/work-questions";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import type { WorkQuestionDetail } from "@armyofagents/shared";

export interface WorkQuestionPanelProps {
  companyId: string;
  questionId: string;
  embedded?: boolean;
  initialDetail?: WorkQuestionDetail;
}

export function WorkQuestionPanel({ companyId, questionId, embedded = false, initialDetail }: WorkQuestionPanelProps) {
  const queryClient = useQueryClient();
  const [answerText, setAnswerText] = useState("");
  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  const answerAttemptRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const detailQuery = useQuery({
    queryKey: queryKeys.workQuestions.detail(companyId, questionId),
    queryFn: () => workQuestionsApi.detail(companyId, questionId),
    enabled: !initialDetail,
    refetchInterval: (query) => {
      const current = query.state.data?.question;
      if (!current) return 5_000;
      return current.status === "open"
        || current.continuationStatus === "pending"
        || current.continuationStatus === "dispatched"
        ? 5_000
        : false;
    },
  });
  const detail = initialDetail ?? detailQuery.data;
  const question = detail?.question;

  useEffect(() => {
    setAnswerText("");
    setSelectedValues([]);
    answerAttemptRef.current = null;
  }, [question?.id]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.workQuestions.detail(companyId, questionId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workQuestions.all(companyId) }),
      queryClient.invalidateQueries({ queryKey: ["hub-items", companyId] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(companyId) }),
    ]);
  };
  const answerMutation = useMutation({
    mutationFn: () => {
      const answer = {
        ...(answerText.trim() ? { text: answerText.trim() } : {}),
        ...(selectedValues.length ? { selectedValues } : {}),
      };
      const fingerprint = JSON.stringify({ answer, expectedVersion: question!.version });
      if (answerAttemptRef.current?.fingerprint !== fingerprint) {
        answerAttemptRef.current = {
          fingerprint,
          idempotencyKey: `work-question:${questionId}:${crypto.randomUUID()}`,
        };
      }
      return workQuestionsApi.answer(companyId, questionId, {
        answer,
        expectedVersion: question!.version,
        idempotencyKey: answerAttemptRef.current.idempotencyKey,
      });
    },
    onSuccess: async () => {
      answerAttemptRef.current = null;
      await refresh();
    },
  });
  const takeOverMutation = useMutation({
    mutationFn: () => workQuestionsApi.takeOver(companyId, questionId, question!.version),
    onSuccess: refresh,
  });
  const retryMutation = useMutation({
    mutationFn: () => workQuestionsApi.retryContinuation(companyId, questionId, question!.version),
    onSuccess: refresh,
  });

  if (!initialDetail && detailQuery.isLoading) {
    return <div className="p-5 text-sm text-muted-foreground">Loading question...</div>;
  }
  if ((!initialDetail && detailQuery.isError) || !detail || !question) {
    return <div className="p-5 text-sm text-destructive">Question details are unavailable.</div>;
  }

  const open = question.status === "open";
  const canSubmit = detail.capabilities.answer && Boolean(answerText.trim() || selectedValues.length);
  const options = question.options ?? [];
  const optionLabels = new Map(options.map((option) => [option.value, option.label]));
  const pending = answerMutation.isPending || takeOverMutation.isPending || retryMutation.isPending;
  const dueAt = new Date(question.dueAt);
  const hasDeadline = Number.isFinite(dueAt.getTime());
  const overdue = question.slaBreachedAt != null || (hasDeadline && dueAt.getTime() <= Date.now());

  return (
    <section
      className={embedded ? "h-full overflow-auto p-5" : "border-y border-border px-4 py-4"}
      aria-label="Work question"
      data-testid="work-question-panel"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
            <span>{question.askingAgentNameSnapshot ?? "Agent"}</span>
            {question.issueIdentifierSnapshot ? <span>{question.issueIdentifierSnapshot}</span> : null}
          </div>
          <h2 className="mt-2 text-base font-semibold text-text">{question.title}</h2>
          {question.issueTitleSnapshot ? (
            <p className="mt-1 text-sm text-muted-foreground">Task: {question.issueTitleSnapshot}</p>
          ) : null}
          {open ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Waiting since {formatDistanceToNowStrict(new Date(question.createdAt), { addSuffix: true })}</span>
              {hasDeadline ? (
                <span className={overdue ? "font-medium text-destructive" : ""}>
                  {overdue ? "Overdue by " : "Due in "}
                  {formatDistanceToNowStrict(dueAt)}
                </span>
              ) : null}
              {question.slaSource ? (
                <span>{question.slaSource === "project" ? "Project policy" : "Company policy"}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 border border-border px-2 py-1 text-xs text-muted-foreground">
          {question.status.replace(/_/g, " ")}
        </span>
      </header>

      {question.context && typeof question.context.summary === "string" ? (
        <div className="mt-4 border-l-2 border-border bg-muted/30 px-3 py-2 text-sm leading-6 text-muted-foreground">
          {question.context.summary}
        </div>
      ) : null}
      <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-text">{question.question}</p>

      {open ? (
        <div className="mt-5 grid gap-4">
          {options.length ? (
            <fieldset className="grid gap-2" disabled={!detail.capabilities.answer || pending}>
              <legend className="sr-only">Answer options</legend>
              {options.map((option) => {
                const selected = selectedValues.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className="flex cursor-pointer gap-3 border border-border bg-bg p-3 text-sm transition-colors hover:bg-muted/30 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                  >
                    <input
                      type="radio"
                      name={`work-question-${question.id}`}
                      checked={selected}
                      onChange={() => {
                        setSelectedValues([option.value]);
                        setAnswerText("");
                      }}
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                    <span className="grid gap-1">
                      <span className="font-medium text-text">{option.label}</span>
                      {option.description ? <span className="leading-5 text-muted-foreground">{option.description}</span> : null}
                      {option.rationale ? <span className="leading-5 text-muted-foreground">Rationale: {option.rationale}</span> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <label className="grid gap-2 text-sm font-medium text-text">
            <span>{options.length ? "Or write an answer" : "Your answer"}</span>
            <textarea
              aria-label="Work question answer"
              value={answerText}
              disabled={!detail.capabilities.answer || pending}
              onChange={(event) => {
                setAnswerText(event.target.value);
                if (event.target.value.trim()) setSelectedValues([]);
              }}
              className="min-h-24 resize-y border border-border bg-bg p-2 text-sm"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {detail.capabilities.answer ? (
              <Button type="button" size="sm" disabled={!canSubmit || pending} onClick={() => answerMutation.mutate()}>
                Send answer
              </Button>
            ) : null}
            {detail.capabilities.takeOver ? (
              <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => takeOverMutation.mutate()}>
                <UserRoundCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                Take over
              </Button>
            ) : null}
          </div>
        </div>
      ) : question.status === "answered" ? (
        <div className="mt-5 border border-border bg-muted/20 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
            Answered
          </div>
          {question.answer?.text ? <p className="mt-2 whitespace-pre-wrap text-sm text-text">{question.answer.text}</p> : null}
          {question.answer?.selectedValues?.length ? (
            <p className="mt-2 text-sm text-text">
              {question.answer.selectedValues.map((value) => optionLabels.get(value) ?? value).join(", ")}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Continuation: {question.continuationStatus.replace(/_/g, " ")}
          </p>
          {detail.capabilities.retryContinuation && question.continuationStatus === "failed" ? (
            <Button type="button" size="sm" variant="secondary" className="mt-3" disabled={pending} onClick={() => retryMutation.mutate()}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry continuation
            </Button>
          ) : null}
        </div>
      ) : null}

      {answerMutation.isError || takeOverMutation.isError || retryMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">The question changed or the action was not permitted. Refresh and try again.</p>
      ) : null}
    </section>
  );
}
