import { useEffect, useState, useMemo } from "react";
import { Link, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { goalsApi, type GoalTreeNode } from "../api/goals";
import { companiesApi } from "../api/companies";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { GoalFields, type GoalScope } from "../components/goals/GoalFields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Target,
  Plus,
  AlertTriangle,
  Pencil,
  CornerDownRight,
  GitBranch,
} from "lucide-react";
import { cn } from "../lib/utils";

type Tab = "goals" | "vision";

/* ── Tree helpers ──────────────────────────────────────────────────── */

function buildChildrenMap(nodes: GoalTreeNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const childrenOf = new Map<string, GoalTreeNode[]>();
  for (const n of nodes) {
    for (const pid of n.parentIds) {
      if (!byId.has(pid)) continue;
      const arr = childrenOf.get(pid) ?? [];
      arr.push(n);
      childrenOf.set(pid, arr);
    }
  }
  return { byId, childrenOf };
}

function descendantIds(
  rootId: string,
  childrenOf: Map<string, GoalTreeNode[]>,
): Set<string> {
  const seen = new Set<string>();
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const child of childrenOf.get(cur) ?? []) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          next.push(child.id);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Pre-order flatten with depth; multi-parent nodes appear under each parent.
 *  Cycle-guarded: a node already on the current path renders once, no recursion. */
function flattenTree(nodes: GoalTreeNode[]) {
  const { byId, childrenOf } = buildChildrenMap(nodes);
  const roots = nodes.filter(
    (n) => n.parentIds.filter((p) => byId.has(p)).length === 0,
  );
  const out: { node: GoalTreeNode; depth: number; key: string }[] = [];
  function walk(
    node: GoalTreeNode,
    depth: number,
    path: Set<string>,
    keyPrefix: string,
  ) {
    const key = `${keyPrefix}${node.id}`;
    out.push({ node, depth, key });
    if (path.has(node.id)) return; // cycle guard
    const nextPath = new Set(path);
    nextPath.add(node.id);
    for (const child of childrenOf.get(node.id) ?? []) {
      walk(child, depth + 1, nextPath, `${key}/`);
    }
  }
  for (const r of roots) walk(r, 0, new Set(), "");
  return { rows: out, childrenOf };
}

/* ── Goal tree row ─────────────────────────────────────────────────── */

function GoalTreeRow({
  node,
  depth,
  onEditParents,
  onAcceptSuggestion,
  busy,
}: {
  node: GoalTreeNode;
  depth: number;
  onEditParents: (node: GoalTreeNode) => void;
  onAcceptSuggestion: (node: GoalTreeNode) => void;
  busy: boolean;
}) {
  const { done, total, percent } = node.progress;
  return (
    <div
      className="flex items-center gap-3 py-2 border-b border-border/60"
      style={{ paddingLeft: depth * 20 }}
    >
      {depth > 0 && (
        <CornerDownRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
      )}
      <Link
        to={`/goals/${node.id}`}
        className="text-sm font-medium hover:underline truncate min-w-0 flex-1 no-underline text-inherit"
      >
        {node.title}
      </Link>

      {/* Scope */}
      <div className="hidden sm:flex items-center gap-1 shrink-0">
        {node.projects.length === 0 ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Company-wide
          </span>
        ) : (
          <>
            {node.projects.slice(0, 2).map((p) => (
              <span
                key={p.id}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  p.type === "department"
                    ? "bg-blue-500/15 text-blue-600"
                    : "bg-purple-500/15 text-purple-600",
                )}
              >
                {p.name}
              </span>
            ))}
            {node.projects.length > 2 && (
              <span className="text-[10px] text-muted-foreground">
                +{node.projects.length - 2}
              </span>
            )}
          </>
        )}
      </div>

      <StatusBadge status={node.status} />

      {/* Progress */}
      <div className="w-24 shrink-0" title={`${done} of ${total} tasks done`}>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground">
          {total === 0 ? "no tasks" : `${done}/${total} · ${percent}%`}
        </span>
      </div>

      {node.atRisk > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 shrink-0"
          title={`${node.atRisk} blocked or overdue`}
        >
          <AlertTriangle className="h-3 w-3" />
          {node.atRisk}
        </span>
      )}

      {/* Non-binding status nudge */}
      {node.statusSuggestion && (
        <button
          type="button"
          onClick={() => onAcceptSuggestion(node)}
          disabled={busy}
          className="shrink-0 rounded border border-primary/40 text-primary px-1.5 py-0.5 text-[10px] font-medium hover:bg-primary/10 disabled:opacity-50"
        >
          {node.statusSuggestion === "achieved"
            ? "Mark achieved?"
            : "Flag at risk?"}
        </button>
      )}

      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => onEditParents(node)}
        aria-label="Edit parent goals"
        title="Edit parent goals"
      >
        <GitBranch className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/* ── Edit-parents dialog ───────────────────────────────────────────── */

function EditParentsDialog({
  node,
  childrenOf,
  companyId,
  onClose,
}: {
  node: GoalTreeNode;
  childrenOf: Map<string, GoalTreeNode[]>;
  companyId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [parentIds, setParentIds] = useState<string[]>(node.parentIds);

  const scope: GoalScope =
    node.projectIds.length > 0
      ? { mode: "specific", projectIds: node.projectIds }
      : { mode: "company", projectIds: [] };

  // Hide self + descendants from the picker (server also rejects cycles).
  const excludeIds = useMemo(() => {
    const set = descendantIds(node.id, childrenOf);
    set.add(node.id);
    return [...set];
  }, [node.id, childrenOf]);

  const save = useMutation({
    mutationFn: () => goalsApi.setParents(node.id, parentIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.tree(companyId) });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit parent goals</DialogTitle>
          <DialogDescription>
            Choose which goals “{node.title}” nests under. Leave empty for a
            top-level goal.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 pt-2">
          <GoalFields
            parentsOnly
            companyId={companyId}
            scope={scope}
            onScopeChange={() => {}}
            parentIds={parentIds}
            onParentsChange={setParentIds}
            excludeIds={excludeIds}
          />
          {save.isError && (
            <p className="text-xs text-destructive">
              {save.error instanceof Error
                ? save.error.message
                : "Failed to update parents"}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/* ── Identity card (read-only with edit button) ────────────────────── */

function IdentityCard({
  label,
  hint,
  value,
  placeholder,
  onEdit,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {label}
          </div>
          <p className="text-[11px] text-muted-foreground mb-2">{hint}</p>
          {value ? (
            <p className="text-sm whitespace-pre-line">{value}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">{placeholder}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          aria-label={`Edit ${label}`}
          title={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ── Edit modal ────────────────────────────────────────────────────── */

function EditIdentityModal({
  open,
  onOpenChange,
  label,
  hint,
  value,
  onSave,
  saving,
  multiline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  hint: string;
  value: string;
  onSave: (value: string) => void;
  saving: boolean;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {label}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 pt-2">
          {multiline ? (
            <textarea
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none resize-none focus:ring-2 focus:ring-ring"
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          ) : (
            <input
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */

export function Objectives() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs, setSubtitle, setEntityColor } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const location = useLocation();

  const initialTab: Tab = (() => {
    const param = new URLSearchParams(location.search).get("tab");
    return param === "vision" ? "vision" : "goals";
  })();

  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [editingField, setEditingField] = useState<
    "vision" | "mission" | "values" | null
  >(null);
  const [editingParentsFor, setEditingParentsFor] = useState<GoalTreeNode | null>(
    null,
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Objectives" }]);
    return () => {
      setSubtitle(null);
      setEntityColor(null);
    };
  }, [setBreadcrumbs, setSubtitle, setEntityColor]);

  // ── Vision / Mission save ───────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (data: {
      vision?: string | null;
      mission?: string | null;
      values?: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setEditingField(null);
    },
  });

  function handleFieldSave(
    field: "vision" | "mission" | "values",
    value: string,
  ) {
    saveMutation.mutate({ [field]: value.trim() || null });
  }

  // ── Goals tree ──────────────────────────────────────────────────
  const {
    data: goals,
    isLoading: goalsLoading,
    error: goalsError,
  } = useQuery({
    queryKey: queryKeys.goals.tree(selectedCompanyId!),
    queryFn: () => goalsApi.tree(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { rows, childrenOf } = useMemo(
    () => (goals ? flattenTree(goals) : { rows: [], childrenOf: new Map() }),
    [goals],
  );

  const acceptSuggestion = useMutation({
    mutationFn: (node: GoalTreeNode) =>
      goalsApi.update(node.id, { status: node.statusSuggestion }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.tree(selectedCompanyId!),
      });
    },
  });

  // ── Render ──────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string }[] = [
    { key: "goals", label: "Goals" },
    { key: "vision", label: "Vision & Mission" },
  ];

  const fieldConfig = {
    vision: {
      label: "Vision",
      hint: "Where are we headed? A single-line statement describing the future you're building toward.",
      placeholder: "Not set yet — click edit to add your vision",
      multiline: false,
    },
    mission: {
      label: "Mission",
      hint: "How do we get there? A short statement describing your approach and strategy.",
      placeholder: "Not set yet — click edit to add your mission",
      multiline: true,
    },
    values: {
      label: "Values",
      hint: "What do we stand for? Core principles that guide decisions. One per line works well.",
      placeholder: "Not set yet — click edit to add your values",
      multiline: true,
    },
  } as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Objectives<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Vision, mission, values, and the goals that align everyone's work.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border -mt-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Goals tab */}
      {activeTab === "goals" && (
        <div className="space-y-4">
          {goalsError && (
            <p className="text-sm text-destructive">{goalsError.message}</p>
          )}

          {goalsLoading && <PageSkeleton variant="list" />}

          {!goalsLoading && goals && goals.length === 0 && (
            <EmptyState
              icon={Target}
              message="No goals yet"
              description="Goals help you track high-level objectives and align your agents' work toward measurable outcomes."
              action="Create your first goal"
              onAction={() => openNewGoal()}
              entityColor="var(--entity-goal)"
            />
          )}

          {rows.length > 0 && (
            <>
              <div className="flex items-center justify-end">
                <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  New Goal
                </Button>
              </div>
              <div className="rounded-lg border border-border divide-y divide-border/0">
                {rows.map(({ node, depth, key }) => (
                  <GoalTreeRow
                    key={key}
                    node={node}
                    depth={depth}
                    onEditParents={setEditingParentsFor}
                    onAcceptSuggestion={(n) => acceptSuggestion.mutate(n)}
                    busy={acceptSuggestion.isPending}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Vision & Mission tab */}
      {activeTab === "vision" && (
        <div className="max-w-2xl space-y-4">
          <IdentityCard
            label="Vision"
            hint="Where are we headed?"
            value={selectedCompany?.vision ?? ""}
            placeholder="Not set yet — click edit to add your vision"
            onEdit={() => setEditingField("vision")}
          />
          <IdentityCard
            label="Mission"
            hint="How do we get there?"
            value={selectedCompany?.mission ?? ""}
            placeholder="Not set yet — click edit to add your mission"
            onEdit={() => setEditingField("mission")}
          />
          <IdentityCard
            label="Values"
            hint="What do we stand for?"
            value={selectedCompany?.values ?? ""}
            placeholder="Not set yet — click edit to add your values"
            onEdit={() => setEditingField("values")}
          />
        </div>
      )}

      {/* Edit identity modal */}
      {editingField && (
        <EditIdentityModal
          open
          onOpenChange={(open) => {
            if (!open) setEditingField(null);
          }}
          label={fieldConfig[editingField].label}
          hint={fieldConfig[editingField].hint}
          value={
            editingField === "vision"
              ? selectedCompany?.vision ?? ""
              : editingField === "mission"
                ? selectedCompany?.mission ?? ""
                : selectedCompany?.values ?? ""
          }
          onSave={(v) => handleFieldSave(editingField, v)}
          saving={saveMutation.isPending}
          multiline={fieldConfig[editingField].multiline}
        />
      )}

      {/* Edit parents dialog */}
      {editingParentsFor && selectedCompanyId && (
        <EditParentsDialog
          node={editingParentsFor}
          childrenOf={childrenOf}
          companyId={selectedCompanyId}
          onClose={() => setEditingParentsFor(null)}
        />
      )}
    </div>
  );
}
