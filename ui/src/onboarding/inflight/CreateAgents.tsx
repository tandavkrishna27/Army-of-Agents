import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogItem } from "@armyofagents/shared";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { marketplaceApi, filterByType, isAoaCrewItem } from "../../api/marketplace";
import { listAdapterOptions } from "@/adapters";
import { Button } from "@/components/ui/button";
import { SnapshotInstallModal } from "@/components/marketplace/install/SnapshotInstallModal";
import { cn } from "@/lib/utils";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "../steps/shared";

type DeptRow = { id: string; name: string; type?: string };
type AgentRow = { id: string; kind?: string; name?: string };

type DeptStatus = "idle" | "creating" | "created" | "error";
type DeptMode = "form" | "marketplace";

type DeptAgentState = {
  name: string;
  purpose: string;
  adapterType: string;
  mode: DeptMode;
  status: DeptStatus;
  error: string | null;
  selectedCatalogItem: CatalogItem | null;
  marketplaceOpen: boolean;
};

const DEFAULT_ADAPTER = "claude_local";

function makeDeptAgentState(dept: DeptRow): DeptAgentState {
  return {
    name: `${dept.name.trim()} Lead`,
    purpose: `Coordinate work in ${dept.name.trim()} and hire the team as needed.`,
    adapterType: DEFAULT_ADAPTER,
    mode: "form",
    status: "idle",
    error: null,
    selectedCatalogItem: null,
    marketplaceOpen: false,
  };
}

export type CreateAgentsProps = {
  companyId: string;
  deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  onDone: () => void;
};

/**
 * WS7 — the In-flight "Create agent" surface. Standalone, like
 * `DefineDepartments` (WS4) and `IntegrationsStep` (WS5): domain-only, no
 * `advanceOnboarding` call — WS9 wires this onto Home later.
 *
 * For each of the company's departments, the founder can EITHER:
 *  - "Create your own" — a compact form (name/purpose/adapter) that creates
 *    (or reuses, by name) an org agent and assigns it to that department via
 *    `projectsApi.assignAgent` (mirrors the old wizard `AgentStep`'s
 *    create+assign logic, minus the illegal `advanceOnboarding` call).
 *  - "Pick from marketplace" — an inline catalog picker (agent/team items
 *    only) followed by the extended `SnapshotInstallModal`, opened with BOTH
 *    `lockedCompanyId` and `lockedDeptId` set to this department (Codex P1:
 *    the modal is not itself a picker and locking only the department would
 *    be a cross-company risk — see SnapshotInstallModal's prop doc).
 *
 * `onDone` fires once every department has a status of "created" (the
 * marketplace path counts as "created" once the install POST is confirmed
 * via `onInstalled` — the actual install then finishes async, surfaced by
 * the existing marketplace install toast, same as everywhere else installs
 * are triggered from). Skippable at any time.
 */
export function CreateAgents({ companyId, deploymentMode, onDone }: CreateAgentsProps) {
  const cloudMode = deploymentMode === "cloud_auth";
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [deptState, setDeptState] = useState<Record<string, DeptAgentState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  const doneFiredRef = useRef(false);
  const fireOnDoneOnce = useCallback(() => {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const projects = await projectsApi.list(companyId);
        const depts = (projects as DeptRow[]).filter((p) => p.type === "department");
        if (cancelled) return;
        setDepartments(depts);
        setDeptState((prev) => {
          const next = { ...prev };
          for (const d of depts) {
            if (!next[d.id]) next[d.id] = makeDeptAgentState(d);
          }
          return next;
        });
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Couldn't load your departments.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (cloudMode) {
      setCatalogItems([]);
      return;
    }
    let cancelled = false;
    marketplaceApi
      .getCatalog()
      .then((catalog) => {
        if (cancelled) return;
        // Show marketplace agents + teams, but hide AoA's own auto-seeded crew
        // (the aoa-* crew agents + the standard-crew team) — re-offering the
        // already-seeded crew in the picker is just noise.
        const agentsAndTeams = [
          ...filterByType(catalog.items, "agent"),
          ...filterByType(catalog.items, "team"),
        ].filter((item) => !isAoaCrewItem(item));
        setCatalogItems(agentsAndTeams);
      })
      .catch(() => {
        // Best-effort — the marketplace path just shows an empty picker; the
        // create-your-own form is always available.
      });
    return () => {
      cancelled = true;
    };
  }, [cloudMode]);

  function updateDept(deptId: string, patch: Partial<DeptAgentState>) {
    setDeptState((prev) => (prev[deptId] ? { ...prev, [deptId]: { ...prev[deptId], ...patch } } : prev));
  }

  function markCreated(deptId: string) {
    setDeptState((prev) => {
      if (!prev[deptId] || prev[deptId].status === "created") return prev;
      return { ...prev, [deptId]: { ...prev[deptId], status: "created" as const, error: null } };
    });
  }

  // Fire onDone once every department is created. This MUST live in an effect,
  // not inside the setDeptState updater — the updater runs during React's
  // render phase, and onDone() is the parent InFlightFlow's setState, so calling
  // it there triggers "Cannot update a component while rendering a different
  // component." The doneFiredRef guard keeps it single-shot.
  useEffect(() => {
    if (departments.length > 0 && departments.every((d) => deptState[d.id]?.status === "created")) {
      fireOnDoneOnce();
    }
  }, [departments, deptState, fireOnDoneOnce]);

  async function createAndAssign(dept: DeptRow) {
    const state = deptState[dept.id];
    if (!state || !state.name.trim()) return;
    updateDept(dept.id, { status: "creating", error: null });
    try {
      // Do NOT swallow a list failure into an empty list: if the request fails
      // transiently while a same-named agent already exists, that would create a
      // duplicate. Let it throw → the outer catch marks this dept errored + the
      // founder retries.
      const existing = (await agentsApi.list(companyId)) as AgentRow[];
      let agentId = existing.find((a) => a.kind === "org" && a.name === state.name.trim())?.id ?? null;

      if (!agentId) {
        const agent = await agentsApi.create(companyId, {
          name: state.name.trim(),
          role: "lead",
          capabilities: state.purpose.trim() || undefined,
          adapterType: state.adapterType,
          adapterConfig: {},
          runtimeConfig: {
            heartbeat: {
              enabled: !cloudMode,
              intervalSec: 3600,
              wakeOnDemand: !cloudMode,
              cooldownSec: 10,
              maxConcurrentRuns: 1,
            },
          },
        });
        agentId = (agent as AgentRow).id;
      }

      // The create endpoint intentionally starts agents idle. In cloud, pause
      // before assignment so an assignment wake cannot race E2B setup.
      if (cloudMode) {
        await agentsApi.pause(agentId!, companyId);
      }
      await projectsApi.assignAgent(dept.id, agentId!, companyId);
      markCreated(dept.id);
    } catch (e) {
      updateDept(dept.id, {
        status: "error",
        error: e instanceof Error ? e.message : "Failed to create this agent.",
      });
    }
  }

  const adapterOptions = useMemo(() => listAdapterOptions().filter((o) => !o.hidden), []);

  return (
    <StepShell className="max-w-lg">
      <Reveal>
        <StepHeading
          title={
            <>
              Staff your <GradientText>departments</GradientText>
            </>
          }
          subtitle={cloudMode
            ? "Create department agents in a paused state. Attach an E2B environment before enabling them on AoA Cloud."
            : "Give each department a worker agent — create your own, or pick one from the marketplace."}
        />
      </Reveal>

      {loadError && <p className="text-center text-xs text-destructive">{loadError}</p>}

      {!loading && departments.length === 0 && !loadError && (
        <p className="text-center text-xs text-dim">No departments yet — you can add agents once you have one.</p>
      )}

      <div className="flex flex-col gap-3">
        {departments.map((dept, i) => {
          const state = deptState[dept.id];
          if (!state) return null;
          return (
            <Reveal key={dept.id} delay={0.09 + i * 0.09}>
              <StepCard>
                <div data-testid={`dept-card-${dept.id}`} className="flex flex-col gap-0">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-text">{dept.name}</h3>
                    {state.status === "created" && (
                      <span className="text-xs" style={{ color: "var(--done)" }}>
                        Created
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs",
                        state.mode === "form"
                          ? "border-brand bg-card-2 text-text"
                          : "border-border-strong text-dim hover:bg-card-2/60",
                      )}
                      disabled={state.status === "creating"}
                      onClick={() => updateDept(dept.id, { mode: "form" })}
                    >
                      Create your own
                    </button>
                    {!cloudMode && (
                      <button
                        type="button"
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs",
                          state.mode === "marketplace"
                            ? "border-brand bg-card-2 text-text"
                            : "border-border-strong text-dim hover:bg-card-2/60",
                        )}
                        disabled={state.status === "creating"}
                        onClick={() => updateDept(dept.id, { mode: "marketplace" })}
                      >
                        Pick from marketplace
                      </button>
                    )}
                  </div>

                  {state.mode === "form" && (
                    <div className="mt-3 space-y-2">
                      <label className="sr-only" htmlFor={`agent-name-${dept.id}`}>
                        Agent name for {dept.name}
                      </label>
                      <input
                        id={`agent-name-${dept.id}`}
                        className={FIELD}
                        placeholder="Agent name"
                        value={state.name}
                        disabled={state.status === "creating" || state.status === "created"}
                        onChange={(e) => updateDept(dept.id, { name: e.target.value })}
                      />
                      <label className="sr-only" htmlFor={`agent-purpose-${dept.id}`}>
                        Purpose for {dept.name}'s agent
                      </label>
                      <textarea
                        id={`agent-purpose-${dept.id}`}
                        className={cn(FIELD, "min-h-[64px] resize-none")}
                        placeholder="What should this agent do?"
                        value={state.purpose}
                        disabled={state.status === "creating" || state.status === "created"}
                        onChange={(e) => updateDept(dept.id, { purpose: e.target.value })}
                      />
                      <div>
                        <p className={LABEL}>Adapter</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {adapterOptions.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              className={cn(
                                "rounded-md border px-2 py-1.5 text-left text-xs",
                                opt.value === state.adapterType
                                  ? "border-brand bg-card-2 text-text"
                                  : "border-border-strong text-dim hover:bg-card-2/60",
                                opt.comingSoon && "cursor-not-allowed opacity-40",
                              )}
                              disabled={opt.comingSoon || state.status === "creating" || state.status === "created"}
                              onClick={() => updateDept(dept.id, { adapterType: opt.value })}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {state.status === "error" && (
                        <p className="text-xs text-destructive">{state.error}</p>
                      )}
                      <Button
                        type="button"
                        className="w-full"
                        disabled={
                          !state.name.trim() || state.status === "creating" || state.status === "created"
                        }
                        onClick={() => void createAndAssign(dept)}
                      >
                        {state.status === "creating"
                          ? "Creating…"
                          : state.status === "created"
                            ? "Created"
                            : state.status === "error"
                              ? "Retry"
                              : "Create & assign"}
                      </Button>
                    </div>
                  )}

                  {!cloudMode && state.mode === "marketplace" && (
                    <div className="mt-3 space-y-2">
                      {catalogItems.length === 0 && (
                        <p className="text-xs text-dim">No agents or teams available in the catalog.</p>
                      )}
                      <div className="flex flex-col gap-1.5">
                        {catalogItems.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={cn(
                              "flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs",
                              state.selectedCatalogItem?.id === item.id
                                ? "border-brand bg-card-2 text-text"
                                : "border-border-strong text-dim hover:bg-card-2/60",
                            )}
                            disabled={state.status === "created"}
                            onClick={() => updateDept(dept.id, { selectedCatalogItem: item })}
                          >
                            <span>{item.name}</span>
                            <span className="text-[10px] uppercase text-very-dim">{item.type}</span>
                          </button>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        className="w-full"
                        disabled={!state.selectedCatalogItem || state.status === "created"}
                        onClick={() => updateDept(dept.id, { marketplaceOpen: true })}
                      >
                        {state.status === "created" ? "Installed" : "Install selected"}
                      </Button>

                      {state.selectedCatalogItem && (
                        <SnapshotInstallModal
                          item={state.selectedCatalogItem}
                          open={state.marketplaceOpen}
                          onOpenChange={(open) => updateDept(dept.id, { marketplaceOpen: open })}
                          lockedCompanyId={companyId}
                          lockedDeptId={dept.id}
                          onInstalled={() => markCreated(dept.id)}
                        />
                      )}
                    </div>
                  )}
                </div>
              </StepCard>
            </Reveal>
          );
        })}
      </div>

      <Reveal delay={0.18 + departments.length * 0.09}>
        <Button type="button" variant="ghost" className="w-full" onClick={fireOnDoneOnce}>
          Skip for now
        </Button>
      </Reveal>
    </StepShell>
  );
}
