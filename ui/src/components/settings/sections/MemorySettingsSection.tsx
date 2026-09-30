import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import {
  memorySettingsApi,
  type MemoryActiveContextTier,
  type MemoryAutonomyLevel,
  type MemorySettingsPatch,
} from "@/api/memorySettings";
import { projectsApi } from "@/api/projects";
import { LLMProvidersSectionWrapper } from "./LLMProvidersSectionWrapper";

const AUTONOMY: readonly MemoryAutonomyLevel[] = ["manual", "supervised", "trusted", "policy"];
const TIERS: readonly MemoryActiveContextTier[] = ["ephemeral", "durable", "protected"];

const AUTONOMY_LABEL: Record<MemoryAutonomyLevel, string> = {
  manual: "Manual — founder approves every write",
  supervised: "Supervised — write proposed for review",
  trusted: "Trusted — auto for promoted classes",
  policy: "Policy — auto within policy",
};
const TIER_LABEL: Record<MemoryActiveContextTier, string> = {
  ephemeral: "Ephemeral",
  durable: "Durable",
  protected: "Protected",
};

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-60";

export function MemorySettingsSection() {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  const settingsQuery = useQuery({
    queryKey: ["memory-settings", companyId],
    queryFn: () => memorySettingsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", companyId],
    queryFn: () => projectsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const rows = settingsQuery.data;
  const projects = projectsQuery.data;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["memory-settings", companyId] });
  const save = useMutation({
    mutationFn: (patch: MemorySettingsPatch) => memorySettingsApi.update(companyId, patch),
    onSuccess: invalidate,
  });
  const clearOverride = useMutation({
    mutationFn: (departmentId: string) => memorySettingsApi.deleteOverride(companyId, departmentId),
    onSuccess: invalidate,
  });

  const companyDefault = rows?.find((r) => r.departmentId === null);
  const departments = (projects ?? []).filter((p) => p.type === "department");
  const busy =
    save.isPending ||
    clearOverride.isPending ||
    settingsQuery.isPending ||
    projectsQuery.isPending ||
    !companyId;
  const error = settingsQuery.error ?? projectsQuery.error ?? save.error ?? clearOverride.error;

  return (
    <section data-testid="memory-settings-section">
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Memory<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Governance for the company brain — how memory writes are handled and the embeddings
          key that powers semantic search.
        </p>
      </div>

      <div className="p-8 space-y-8">
        <div className="max-w-xl rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
          These governance preferences are saved for the upcoming P5 write-policy runtime. They do
          not change memory-write behavior in the current release.
        </div>
        {error && (
          <div role="alert" className="max-w-xl rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error instanceof Error ? error.message : "Memory settings could not be loaded or saved."}
          </div>
        )}
        {/* Governance dials */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Autonomy
          </div>
          <div className="space-y-5 rounded-md border border-border px-4 py-4 max-w-xl">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="memory-autonomy" className="text-sm font-medium">
                Autonomy
              </label>
              <select
                id="memory-autonomy"
                className={SELECT_CLASS}
                disabled={busy}
                value={companyDefault?.autonomyLevel ?? "supervised"}
                onChange={(e) =>
                  save.mutate({ autonomyLevel: e.target.value as MemoryAutonomyLevel })
                }
              >
                {AUTONOMY.map((a) => (
                  <option key={a} value={a}>
                    {AUTONOMY_LABEL[a]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Company default for how memory writes are gated — auto, proposed for review, or
                founder-only. Distinct from the crew work-autonomy dial in Commander settings.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="memory-tier" className="text-sm font-medium">
                Active context tier
              </label>
              <select
                id="memory-tier"
                className={SELECT_CLASS}
                disabled={busy}
                value={companyDefault?.activeContextTier ?? "durable"}
                onChange={(e) =>
                  save.mutate({ activeContextTier: e.target.value as MemoryActiveContextTier })
                }
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABEL[t]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Risk tier applied to goal/project-scoped (active_context) memory. Higher tiers
                require more review before a write is auto-applied.
              </p>
            </div>
          </div>
        </div>

        {/* Department overrides */}
        {departments.length > 0 && (
          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Department overrides
            </div>
            <div className="space-y-4 rounded-md border border-border px-4 py-4 max-w-xl">
              <p className="text-xs text-muted-foreground">
                Set a per-department autonomy level. &ldquo;Company default&rdquo; inherits the
                value above.
              </p>
              {departments.map((dept) => {
                const override = rows?.find((r) => r.departmentId === dept.id);
                return (
                  <div key={dept.id} className="flex flex-col gap-1.5">
                    <label htmlFor={`memory-dept-${dept.id}`} className="text-sm font-medium">
                      {dept.name}
                    </label>
                    <select
                      id={`memory-dept-${dept.id}`}
                      className={SELECT_CLASS}
                      disabled={busy}
                      value={override?.autonomyLevel ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") clearOverride.mutate(dept.id);
                        else
                          save.mutate({
                            departmentId: dept.id,
                            autonomyLevel: v as MemoryAutonomyLevel,
                          });
                      }}
                    >
                      <option value="">Company default</option>
                      {AUTONOMY.map((a) => (
                        <option key={a} value={a}>
                          {AUTONOMY_LABEL[a]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Embeddings/OpenAI-key config keeps living under Settings → Memory (CLAUDE.md Rule #11). */}
      <div className="border-t border-border">
        <LLMProvidersSectionWrapper embedded />
      </div>
    </section>
  );
}
