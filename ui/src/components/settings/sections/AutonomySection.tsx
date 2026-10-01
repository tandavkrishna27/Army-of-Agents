import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { companiesApi } from "@/api/companies";
import { internalAgentApi } from "@/api/internal-agent";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";

const AUTONOMY = [
  ["0", "Manual", "A human moves every task forward."],
  ["1", "Assist", "Agents can send finished work to review."],
  ["2", "Drive", "Agents can work autonomously."],
] as const;

export function AutonomySection() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: queryKeys.agentConfig(selectedCompanyId!),
    queryFn: () => internalAgentApi.getConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const companyQuery = useQuery({
    queryKey: queryKeys.companies.detail(selectedCompanyId!),
    queryFn: () => companiesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const [autonomy, setAutonomy] = useState("1");
  const [completion, setCompletion] = useState<"review_required" | "agent_can_complete">("review_required");
  const [guardrail, setGuardrail] = useState(true);

  useEffect(() => {
    if (configQuery.data?.crewAutonomyLevel != null) setAutonomy(String(configQuery.data.crewAutonomyLevel));
    if (companyQuery.data?.agentCompletionPolicyDefault) setCompletion(companyQuery.data.agentCompletionPolicyDefault);
    if (companyQuery.data?.agentCompletionReviewGuardrail != null) setGuardrail(companyQuery.data.agentCompletionReviewGuardrail);
  }, [configQuery.data, companyQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      await internalAgentApi.updateConfig(selectedCompanyId!, { crewAutonomyLevel: Number(autonomy) as 0 | 1 | 2 });
      return companiesApi.update(selectedCompanyId!, {
        agentCompletionPolicyDefault: completion,
        agentCompletionReviewGuardrail: guardrail,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentConfig(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
    },
  });

  if (configQuery.isLoading || companyQuery.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading autonomy settings…</div>;
  if (!selectedCompanyId || configQuery.isError || companyQuery.isError) return <div className="p-8 text-sm text-destructive">Unable to load autonomy settings.</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Settings · Autonomy</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Autonomy and approvals</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">These controls are separate on purpose: autonomy determines how far agents may work, while completion policy determines whether they may close a task.</p>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div><h2 className="font-medium">Company agent autonomy</h2><p className="text-xs text-muted-foreground mt-1">Default for crew agents, organization-agent heartbeats, and agent work. A thread or task override may take precedence.</p></div>
        <Select value={autonomy} onValueChange={setAutonomy}><SelectTrigger aria-label="Company agent autonomy" className="max-w-sm"><SelectValue /></SelectTrigger><SelectContent>{AUTONOMY.map(([value, label, help]) => <SelectItem key={value} value={value}>{label} — {help}</SelectItem>)}</SelectContent></Select>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div><h2 className="font-medium">Task completion</h2><p className="text-xs text-muted-foreground mt-1">Drive + Review required is the recommended default: agents work independently, then a human reviews the result.</p></div>
        <Select value={completion} onValueChange={(v) => setCompletion(v as typeof completion)}><SelectTrigger aria-label="Task completion policy" className="max-w-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="review_required">Review required — agent sends work for review</SelectItem><SelectItem value="agent_can_complete">Agent can complete — when guardrails and acceptance criteria pass</SelectItem></SelectContent></Select>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={guardrail} onChange={(e) => setGuardrail(e.target.checked)} className="mt-0.5" aria-label="Keep review guardrail enabled" /><span><span className="font-medium">Keep review guardrail enabled</span><span className="block text-xs text-muted-foreground">Unsafe or incomplete completion falls back to human review.</span></span></label>
      </section>

      <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-medium">Commander approvals</h2><p className="mt-1 text-xs text-muted-foreground">Commander does not use the agent autonomy dial. Its governed actions are controlled by runtime approvals and trust rules in Settings → Commander.</p></section>

      <section className="rounded-xl border border-border bg-muted/20 p-4"><h2 className="text-sm font-medium">Behavior summary</h2><p className="mt-1 text-xs text-muted-foreground">{AUTONOMY.find(([value]) => value === autonomy)?.[1]} + {completion === "review_required" ? "Review required" : "Agent can complete"}. {autonomy === "2" && completion === "review_required" ? "The agent can run autonomously but the task still enters review." : completion === "agent_can_complete" ? "The agent may close the task only when the existing completion guards pass." : "A human remains responsible for advancing the task."}</p></section>

      <div className="flex items-center gap-3"><Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Save autonomy settings</Button>{save.isSuccess && <span className="text-sm text-emerald-600">Settings saved</span>}{save.isError && <span className="text-sm text-destructive">{(save.error as Error).message || "Save failed"}</span>}</div>
    </div>
  );
}
