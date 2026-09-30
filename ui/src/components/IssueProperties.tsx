import { useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import type { Issue } from "@armyofagents/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { formatDateTime, cn, projectUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, Hexagon, ArrowUpRight, Tag, Plus, Trash2, ChevronDown, ClipboardList } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

interface IssuePropertiesProps {
  issue: Issue;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  hideStatus?: boolean;
  hidePriority?: boolean;
  hideHierarchy?: boolean;
  layout?: "default" | "compact";
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Renders a Popover on desktop, or an inline collapsible section on mobile (inline mode). */
function PropertyPicker({
  inline,
  label,
  open,
  onOpenChange,
  triggerContent,
  triggerClassName,
  triggerAriaLabel,
  popoverClassName,
  popoverAlign = "end",
  compact,
  contentTestId,
  extra,
  children,
}: {
  inline?: boolean;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContent: React.ReactNode;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  popoverClassName?: string;
  popoverAlign?: "start" | "center" | "end";
  compact?: boolean;
  contentTestId?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const btnCn = cn(
    compact
      ? "flex min-w-0 flex-1 cursor-pointer items-center justify-end gap-2 text-right"
      : "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors",
    triggerClassName,
  );

  if (inline) {
    return (
      <div>
        <PropertyRow label={label}>
          <button className={btnCn} onClick={() => onOpenChange(!open)}>
            {triggerContent}
          </button>
          {extra}
        </PropertyRow>
        {open && (
          <div className={cn("rounded-md border border-border bg-popover p-1 mb-2", popoverClassName)}>
            {children}
          </div>
        )}
      </div>
    );
  }

  const content = (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className={btnCn} aria-label={triggerAriaLabel}>
            {triggerContent}
            {compact && <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className={cn("p-1", popoverClassName)}
          align={popoverAlign}
          collisionPadding={16}
          data-testid={contentTestId}
        >
          {children}
        </PopoverContent>
      </Popover>
      {extra}
    </>
  );

  if (compact) {
    return <CompactPropertyCard label={label} editable>{content}</CompactPropertyCard>;
  }

  return (
    <PropertyRow label={label}>
      {content}
    </PropertyRow>
  );
}

function CompactPropertyCard({
  label,
  children,
  editable,
}: {
  label: string;
  children: React.ReactNode;
  editable?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isPointerActive, setIsPointerActive] = useState(false);
  const isActive = editable && isPointerActive;

  return (
    <div
      ref={cardRef}
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-2.5 py-1.5 transition-colors",
        editable
          ? "cursor-pointer hover:border-border hover:bg-accent/30 [&_*]:cursor-pointer"
          : "hover:border-border hover:bg-muted/25",
        isActive && "border-border bg-accent/50 shadow-sm ring-1 ring-border/80",
      )}
      data-testid="task-compact-property-card"
      onMouseEnter={() => {
        if (editable) setIsPointerActive(true);
      }}
      onMouseOver={() => {
        if (editable) setIsPointerActive(true);
      }}
      onMouseMove={() => {
        if (editable) setIsPointerActive(true);
      }}
      onMouseLeave={() => {
        if (editable) setIsPointerActive(false);
      }}
      onPointerEnter={() => {
        if (editable) setIsPointerActive(true);
      }}
      onPointerOver={() => {
        if (editable) setIsPointerActive(true);
      }}
      onPointerMove={() => {
        if (editable) setIsPointerActive(true);
      }}
      onPointerLeave={() => {
        if (editable) setIsPointerActive(false);
      }}
      onClick={(event) => {
        if (!editable) return;
        const target = event.target as HTMLElement;
        if (target.closest("button,a,input,textarea,select,[role='button']")) return;
        cardRef.current?.querySelector<HTMLButtonElement>("button")?.click();
      }}
    >
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div
        className="flex min-w-0 flex-1 items-center justify-end gap-1 text-right text-xs text-foreground"
        data-testid="task-compact-property-value"
      >
        {children}
      </div>
    </div>
  );
}

function CompactTimeValue({ value, title }: { value: string; title?: string }) {
  return (
    <span className="min-w-0 truncate text-xs text-foreground" title={title ?? value}>
      {value}
    </span>
  );
}

export function IssueProperties({ issue, onUpdate, inline, hideStatus, hidePriority, hideHierarchy, layout = "default" }: IssuePropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = issue.companyId ?? selectedCompanyId;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [responsibleOpen, setResponsibleOpen] = useState(false);
  const [responsibleSearch, setResponsibleSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [workModeOpen, setWorkModeOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId!),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId,
    userId: currentUserId,
  });

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(companyId!),
    queryFn: () => issuesApi.listLabels(companyId!),
    enabled: !!companyId,
  });
  const { permissions, summary: teamSummary } = useTeamAccess(companyId);

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      onUpdate({ labelIds: [...(issue.labelIds ?? []), created.id] });
      setNewLabelName("");
    },
  });

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) => issuesApi.deleteLabel(labelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
  });

  const toggleLabel = (labelId: string) => {
    const ids = issue.labelIds ?? [];
    const next = ids.includes(labelId)
      ? ids.filter((id) => id !== labelId)
      : [...ids, labelId];
    onUpdate({ labelIds: next });
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const projectLink = (id: string | null) => {
    if (!id) return null;
    const project = projects?.find((p) => p.id === id) ?? null;
    return project ? projectUrl(project) : `/projects/${id}`;
  };

  const humanOptions = useMemo(
    () =>
      (teamSummary?.members ?? []).map((member) => ({
        id: member.userId,
        label: member.displayName ?? member.email ?? member.userId.slice(0, 8),
        title: member.title,
        role: member.role,
        email: member.email,
      })),
    [teamSummary?.members],
  );

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [assigneeOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter((a) => a.status !== "terminated"), recentAssigneeIds),
    [agents, recentAssigneeIds],
  );

  const assignee = issue.assigneeAgentId
    ? agents?.find((a) => a.id === issue.assigneeAgentId)
    : null;
  const userLabel = (userId: string | null | undefined) => {
    if (!userId) return null;
    const member = humanOptions.find((option) => option.id === userId);
    if (member) return member.label;
    if (currentUserId && userId === currentUserId && userId !== "local-board") return "Me";
    return userId.slice(0, 8);
  };
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);
  const responsibleUserLabel = userLabel(issue.responsibleUserId);
  const selectedLabels =
    issue.labels ??
    (labels ?? []).filter((label) => (issue.labelIds ?? []).includes(label.id));

  const labelsTrigger = selectedLabels.length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {selectedLabels.slice(0, 3).map((label) => (
        <span
          key={label.id}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border"
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: label.color,
          }}
        >
          {label.name}
        </span>
      ))}
      {selectedLabels.length > 3 && (
        <span className="text-xs text-muted-foreground">+{selectedLabels.length - 3}</span>
      )}
    </div>
  ) : (
    <>
      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No labels</span>
    </>
  );

  const labelsContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(e) => setLabelSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(labels ?? [])
          .filter((label) => {
            if (!labelSearch.trim()) return true;
            return label.name.toLowerCase().includes(labelSearch.toLowerCase());
          })
          .map((label) => {
            const selected = (issue.labelIds ?? []).includes(label.id);
            return (
              <div key={label.id} className="flex items-center gap-1">
                <button
                  className={cn(
                    "flex items-center gap-2 flex-1 px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                    selected && "bg-accent"
                  )}
                  onClick={() => toggleLabel(label.id)}
                >
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                  <span className="truncate">{label.name}</span>
                </button>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-destructive rounded"
                  onClick={() => deleteLabel.mutate(label.id)}
                  title={`Delete ${label.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
      </div>
      <div className="mt-2 border-t border-border pt-2 space-y-1">
        <div className="flex items-center gap-1">
          <input
            className="h-7 w-7 p-0 rounded bg-transparent"
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
          />
          <input
            className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none rounded placeholder:text-muted-foreground/50"
            placeholder="New label"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
          />
        </div>
        <button
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || createLabel.isPending}
          onClick={() =>
            createLabel.mutate({
              name: newLabelName.trim(),
              color: newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? "Creating…" : "Create label"}
        </button>
      </div>
    </>
  );

  const assigneeTrigger = assignee ? (
    <Identity name={assignee.name} size="sm" />
  ) : assigneeUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm">{assigneeUserLabel}</span>
    </>
  ) : (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Unassigned</span>
    </>
  );

  const assigneeContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search assignees..."
        value={assigneeSearch}
        onChange={(e) => setAssigneeSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent"
          )}
          onClick={() => { onUpdate({ assigneeAgentId: null, assigneeUserId: null }); setAssigneeOpen(false); }}
        >
          No assignee
        </button>
        {issue.createdByUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              issue.assigneeUserId === issue.createdByUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ assigneeAgentId: null, assigneeUserId: issue.createdByUserId });
              setAssigneeOpen(false);
            }}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel ? `Assign to ${creatorUserLabel === "Me" ? "me" : creatorUserLabel}` : "Assign to requester"}
          </button>
        )}
        {humanOptions
          .filter((human) => human.id !== issue.createdByUserId)
          .filter((human) => {
            if (!assigneeSearch.trim()) return true;
            const q = assigneeSearch.toLowerCase();
            return [human.label, human.email, human.title, human.role]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(q));
          })
          .map((human) => (
            <button
              key={human.id}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                human.id === issue.assigneeUserId && "bg-accent",
              )}
              onClick={() => {
                onUpdate({ assigneeAgentId: null, assigneeUserId: human.id });
                setAssigneeOpen(false);
              }}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {human.label}
            </button>
          ))}
        {sortedAgents
          .filter((a) => {
            if (!assigneeSearch.trim()) return true;
            const q = assigneeSearch.toLowerCase();
            return a.name.toLowerCase().includes(q);
          })
          .map((a) => (
          <button
            key={a.id}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              a.id === issue.assigneeAgentId && "bg-accent"
            )}
            onClick={() => { trackRecentAssignee(a.id); onUpdate({ assigneeAgentId: a.id, assigneeUserId: null }); setAssigneeOpen(false); }}
          >
            <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            {a.name}
          </button>
        ))}
      </div>
    </>
  );

  const responsibleTrigger = responsibleUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm">{responsibleUserLabel}</span>
    </>
  ) : (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No responsible human</span>
    </>
  );

  const responsibleContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search responsible humans..."
        value={responsibleSearch}
        onChange={(e) => setResponsibleSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.responsibleUserId && "bg-accent",
          )}
          onClick={() => { onUpdate({ responsibleUserId: null }); setResponsibleOpen(false); }}
        >
          No responsible human
        </button>
        {humanOptions
          .filter((human) => {
            if (!responsibleSearch.trim()) return true;
            const q = responsibleSearch.toLowerCase();
            return [human.label, human.email, human.title, human.role]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(q));
          })
          .map((human) => (
            <button
              key={human.id}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                human.id === issue.responsibleUserId && "bg-accent",
              )}
              onClick={() => { onUpdate({ responsibleUserId: human.id }); setResponsibleOpen(false); }}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{human.label}</span>
            </button>
          ))}
      </div>
    </>
  );

  const projectTrigger = issue.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{ backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "#6366f1" }}
      />
      <span className="text-sm truncate">{projectName(issue.projectId)}</span>
    </>
  ) : (
    <>
      <Hexagon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No project</span>
    </>
  );

  const projectContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search projects..."
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
            !issue.projectId && "bg-accent"
          )}
          onClick={() => { onUpdate({ projectId: null }); setProjectOpen(false); }}
        >
          No project
        </button>
        {orderedProjects
          .filter((p) => {
            if (!projectSearch.trim()) return true;
            const q = projectSearch.toLowerCase();
            return p.name.toLowerCase().includes(q);
          })
          .map((p) => (
          <button
            key={p.id}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
              p.id === issue.projectId && "bg-accent"
            )}
            onClick={() => { onUpdate({ projectId: p.id }); setProjectOpen(false); }}
          >
            <span
              className="shrink-0 h-3 w-3 rounded-sm"
              style={{ backgroundColor: p.color ?? "#6366f1" }}
            />
            {p.name}
          </button>
        ))}
      </div>
    </>
  );

  if (layout === "compact") {
    const createdTitle = formatDateTime(issue.createdAt);
    const startedTitle = issue.startedAt ? formatDateTime(issue.startedAt) : "Not started";
    const workMode = issue.workMode ?? "standard";
    const workModeLabel = workMode === "planning" ? "Planning" : "Standard";

    return (
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        data-testid="task-compact-properties-grid"
      >
        <PropertyPicker
          compact
          label="Mode"
          open={workModeOpen}
          onOpenChange={setWorkModeOpen}
          triggerContent={
            <span className="flex min-w-0 items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs">{workModeLabel}</span>
            </span>
          }
          triggerAriaLabel={`Mode ${workModeLabel}`}
          triggerClassName="min-w-0"
          popoverClassName="w-44"
          contentTestId="task-property-picker-work-mode"
        >
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
              workMode === "standard" && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ workMode: "standard" });
              setWorkModeOpen(false);
            }}
          >
            <ClipboardList className="h-3 w-3 shrink-0 text-muted-foreground" />
            Standard
          </button>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
              workMode === "planning" && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ workMode: "planning" });
              setWorkModeOpen(false);
            }}
          >
            <ClipboardList className="h-3 w-3 shrink-0 text-muted-foreground" />
            Planning
          </button>
        </PropertyPicker>

          <CompactPropertyCard label="Status" editable>
            <StatusIcon
              status={issue.status}
              onChange={(status) => onUpdate({ status })}
              showLabel
              triggerClassName="w-full justify-end text-right -mx-1"
            />
          </CompactPropertyCard>

          <CompactPropertyCard label="Priority" editable>
            <PriorityIcon
              priority={issue.priority}
              onChange={(priority) => onUpdate({ priority })}
              showLabel
              triggerClassName="w-full justify-end text-right -mx-1"
            />
          </CompactPropertyCard>

          {permissions.canAssignTasks ? (
            <PropertyPicker
              compact
              label="Assignee"
              open={assigneeOpen}
              onOpenChange={(open) => { setAssigneeOpen(open); if (!open) setAssigneeSearch(""); }}
              triggerContent={assigneeTrigger}
              triggerClassName="min-w-0"
              popoverClassName="w-52"
              contentTestId="task-property-picker-assignee"
            >
              {assigneeContent}
            </PropertyPicker>
          ) : (
            <CompactPropertyCard label="Assignee">
              {assigneeTrigger}
            </CompactPropertyCard>
          )}

          {permissions.canAssignTasks ? (
            <PropertyPicker
              compact
              label="Responsible"
              open={responsibleOpen}
              onOpenChange={(open) => { setResponsibleOpen(open); if (!open) setResponsibleSearch(""); }}
              triggerContent={responsibleTrigger}
              triggerClassName="min-w-0"
              popoverClassName="w-56"
              contentTestId="task-property-picker-responsible"
            >
              {responsibleContent}
            </PropertyPicker>
          ) : (
            <CompactPropertyCard label="Responsible">
              {responsibleTrigger}
            </CompactPropertyCard>
          )}

          <PropertyPicker
            compact
            label="Project"
            open={projectOpen}
            onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
            triggerContent={projectTrigger}
            triggerClassName="min-w-0"
            popoverClassName="w-fit min-w-[11rem]"
            contentTestId="task-property-picker-project"
          >
            {projectContent}
          </PropertyPicker>

          <PropertyPicker
            compact
            label="Labels"
            open={labelsOpen}
            onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
            triggerContent={labelsTrigger}
            triggerClassName="min-w-0"
            popoverClassName="w-64"
            contentTestId="task-property-picker-labels"
          >
            {labelsContent}
          </PropertyPicker>

          <CompactPropertyCard label="Started">
            <CompactTimeValue
              value={issue.startedAt ? timeAgo(issue.startedAt) : "Not started"}
              title={startedTitle}
            />
          </CompactPropertyCard>
          <CompactPropertyCard label="Created">
            <CompactTimeValue value={formatDateTime(issue.createdAt)} title={createdTitle} />
          </CompactPropertyCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {!hideStatus && (
          <PropertyRow label="Status">
            <StatusIcon
              status={issue.status}
              onChange={(status) => onUpdate({ status })}
              showLabel
            />
          </PropertyRow>
        )}

        {!hidePriority && (
          <PropertyRow label="Priority">
            <PriorityIcon
              priority={issue.priority}
              onChange={(priority) => onUpdate({ priority })}
              showLabel
            />
          </PropertyRow>
        )}

        <PropertyPicker
          inline={inline}
          label="Labels"
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
        >
          {labelsContent}
        </PropertyPicker>

        {permissions.canAssignTasks ? (
          <PropertyPicker
            inline={inline}
            label="Assignee"
            open={assigneeOpen}
            onOpenChange={(open) => { setAssigneeOpen(open); if (!open) setAssigneeSearch(""); }}
            triggerContent={assigneeTrigger}
            popoverClassName="w-52"
            extra={issue.assigneeAgentId ? (
              <Link
                to={`/agents/${issue.assigneeAgentId}`}
                className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            ) : undefined}
          >
            {assigneeContent}
          </PropertyPicker>
        ) : (
          <PropertyRow label="Assignee">
            {assigneeTrigger}
          </PropertyRow>
        )}

        {permissions.canAssignTasks ? (
          <PropertyPicker
            inline={inline}
            label="Responsible"
            open={responsibleOpen}
            onOpenChange={(open) => { setResponsibleOpen(open); if (!open) setResponsibleSearch(""); }}
            triggerContent={responsibleTrigger}
            popoverClassName="w-56"
          >
            {responsibleContent}
          </PropertyPicker>
        ) : (
          <PropertyRow label="Responsible">
            {responsibleTrigger}
          </PropertyRow>
        )}

        <PropertyPicker
          inline={inline}
          label="Project"
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-[11rem]"
          extra={issue.projectId ? (
            <Link
              to={projectLink(issue.projectId)!}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {projectContent}
        </PropertyPicker>

        {!hideHierarchy && issue.parentId && (
          <PropertyRow label="Parent">
            <Link
              to={`/issues/${issue.ancestors?.[0]?.identifier ?? issue.parentId}`}
              className="text-sm hover:underline"
            >
              {issue.ancestors?.[0]?.title ?? issue.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}

        {!hideHierarchy && issue.requestDepth > 0 && (
          <PropertyRow label="Depth">
            <span className="text-sm font-mono">{issue.requestDepth}</span>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        {issue.startedAt && (
          <PropertyRow label="Started">
            <span className="text-sm">{formatDateTime(issue.startedAt)}</span>
          </PropertyRow>
        )}
        {issue.completedAt && (
          <PropertyRow label="Completed">
            <span className="text-sm">{formatDateTime(issue.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDateTime(issue.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{timeAgo(issue.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
