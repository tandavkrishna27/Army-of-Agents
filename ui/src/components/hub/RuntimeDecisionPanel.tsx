import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RuntimeDecisionDetail } from "@armyofagents/shared";
import { agentRuntimeDecisionsApi } from "@/api/agent-runtime-decisions";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

type RuntimeDecisionOption = NonNullable<RuntimeDecisionDetail["options"]>[number] & {
  description?: string | null;
  rationale?: string | null;
};

export function RuntimeDecisionPanel({ item }: { item: HubItemListRow }) {
  const queryClient = useQueryClient();
  const [answerText, setAnswerText] = useState("");
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const decisionId = item.sourceId;
  const detailQuery = useQuery({
    queryKey: decisionId
      ? queryKeys.agentRuntimeDecisions.detail(item.companyId, decisionId)
      : ["agent-runtime-decisions", item.companyId, "missing"],
    queryFn: () => agentRuntimeDecisionsApi.detail(item.companyId, decisionId!),
    enabled: Boolean(decisionId),
  });
  const detail = detailQuery.data;
  useEffect(() => {
    setAnswerText("");
    setSelectedValue(null);
  }, [detail?.id, detail?.sourceRevision]);
  const answerMutation = useMutation({
    mutationFn: (payload: Parameters<typeof agentRuntimeDecisionsApi.answer>[2]) =>
      agentRuntimeDecisionsApi.answer(item.companyId, decisionId!, payload),
    onSuccess: async () => {
      await Promise.all([
        decisionId
          ? queryClient.invalidateQueries({
              queryKey: queryKeys.agentRuntimeDecisions.detail(item.companyId, decisionId),
            })
          : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["hub-items", item.companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(item.companyId) }),
      ]);
    },
  });

  if (!decisionId) {
    return (
      <section className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
        Runtime decision source is unavailable.
      </section>
    );
  }
  if (detailQuery.isLoading) {
    return <section className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">Loading decision...</section>;
  }
  if (detailQuery.isError || !detail) {
    return <section className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">Decision details unavailable.</section>;
  }

  const disabled =
    answerMutation.isPending ||
    (detail.status !== "created" && detail.status !== "shown" && detail.status !== "relay_failed");
  const options = (detail.options ?? []) as RuntimeDecisionOption[];
  const canSubmitQuestion = Boolean(answerText.trim() || selectedValue);
  const submitPermission = (decision: "allow_once" | "allow_run" | "deny") => {
    answerMutation.mutate({
      kind: "permission",
      decision,
      expectedSourceRevision: detail.sourceRevision,
      nonce: detail.nonce,
    });
  };
  const submitQuestionAnswer = () => {
    const trimmedAnswer = answerText.trim();
    if (!trimmedAnswer && !selectedValue) return;
    answerMutation.mutate({
      kind: "work_question",
      answer: trimmedAnswer ? { text: trimmedAnswer } : { value: selectedValue! },
      expectedSourceRevision: detail.sourceRevision,
      nonce: detail.nonce,
    });
  };

  return (
    <section className="mt-5 border-t border-border pt-4" aria-label="Runtime decision">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {detail.kind === "permission" ? "Permission" : "Question"}
        </h3>
        <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {runtimeDecisionStatusLabel(detail.status)}
        </span>
      </div>
      {detail.summary ? (
        <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm leading-6 text-text">
          {detail.summary}
        </div>
      ) : null}
      {detail.promptText ? (
        <p className="mt-4 whitespace-pre-wrap text-base leading-7 text-text">{detail.promptText}</p>
      ) : null}
      <RuntimeDecisionFacts detail={detail} />
      {detail.kind === "permission" ? (
        <div className="mt-4 grid gap-2">
          <Button type="button" size="sm" disabled={disabled} onClick={() => submitPermission("allow_once")}>
            Allow once
          </Button>
          {detail.allowRunEligible ? (
            <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => submitPermission("allow_run")}>
              Allow equivalent actions for this run
            </Button>
          ) : detail.allowRunReason ? (
            <p className="text-xs leading-5 text-muted-foreground">{detail.allowRunReason}</p>
          ) : null}
          <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => submitPermission("deny")}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="mt-4 grid gap-4">
          {options.length > 0 ? (
            <fieldset className="grid gap-2" disabled={disabled}>
              <legend className="sr-only">Work question options</legend>
              {options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer gap-3 rounded-md border border-border bg-bg p-3 text-sm transition-colors hover:bg-muted/30 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                >
                  <input
                    type="radio"
                    name={`runtime-decision-${detail.id}-option`}
                    value={opt.value}
                    checked={selectedValue === opt.value}
                    disabled={disabled}
                    onChange={() => {
                      setSelectedValue(opt.value);
                      setAnswerText("");
                    }}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span className="grid gap-1">
                    <span className="font-semibold text-text">{opt.label}</span>
                    {opt.description ? (
                      <span className="leading-6 text-muted-foreground">{opt.description}</span>
                    ) : null}
                    {opt.rationale ? (
                      <span className="leading-6 text-muted-foreground">Rationale: {opt.rationale}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <label className="grid gap-2 text-sm font-medium text-text">
            <span>{options.length > 0 ? "Or write your own answer" : "Your answer"}</span>
            <textarea
              aria-label="Work question answer"
              value={answerText}
              disabled={disabled}
              onChange={(event) => {
                setAnswerText(event.target.value);
                if (event.target.value.trim()) {
                  setSelectedValue(null);
                }
              }}
              className="min-h-24 resize-y rounded border border-border bg-bg p-2 text-sm"
            />
          </label>
          <Button type="button" size="sm" disabled={disabled || !canSubmitQuestion} onClick={submitQuestionAnswer}>
            Send answer
          </Button>
        </div>
      )}
      {answerMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Failed to answer decision.
        </p>
      ) : null}
    </section>
  );
}

function RuntimeDecisionFacts({ detail }: { detail: RuntimeDecisionDetail }) {
  const rows = [
    ["Tool", detail.toolName],
    ["Command", detail.command],
    ["Path", detail.path],
    ["Network", detail.networkTarget],
    ["Risk", detail.riskClass],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  if (rows.length === 0) return null;
  return (
    <dl className="mt-4 grid gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function runtimeDecisionStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}
