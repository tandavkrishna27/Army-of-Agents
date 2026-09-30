import { useCallback, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Rocket } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@armyofagents/shared";

function SortableProjectItem({
  activeProjectRef,
  isMobile,
  project,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  isMobile: boolean;
  project: Project;
  setSidebarOpen: (open: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const routeRef = projectRouteRef(project);
  const isActive = activeProjectRef === routeRef || activeProjectRef === project.id;
  const tint = project.color ?? "#6366f1";

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <NavLink
        to={`/projects/${routeRef}/issues`}
        onClick={() => { if (isMobile) setSidebarOpen(false); }}
        className={cn(
          "relative flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors",
          isActive
            ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
            : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
        )}
      >
        {project.type === "project" ? (
          <Rocket className="size-4 shrink-0" style={{ color: tint }} />
        ) : (
          <span className="shrink-0 size-3.5 rounded-sm" style={{ backgroundColor: tint }} />
        )}
        <span className="flex-1 truncate">{project.name}</span>
        {isActive && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
          />
        )}
      </NavLink>
    </div>
  );
}

interface SidebarProjectsByTypeProps {
  type: "department" | "project";
  label: string;
  collapsed?: boolean;
}

export function SidebarProjectsByType({ type, label, collapsed }: SidebarProjectsByTypeProps) {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((p: Project) => !p.archivedAt && p.type === type),
    [projects, type],
  );
  const { orderedProjects, persistOrder } = useProjectOrder({
    projects: visibleProjects,
    companyId: selectedCompanyId,
    type,
  });

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedProjects.map((project) => project.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedProjects, persistOrder],
  );

  const newLabel = type === "department" ? "New Department" : "New Project";

  // Collapsed mode: individual color dot per department/project + "new" button
  if (collapsed) {
    return (
      <div className="w-full">
        <div className="mx-auto w-8 my-1.5 border-t border-border" />
        <div className="flex flex-col gap-0.5 items-center">
          {orderedProjects.map((project: Project) => {
            const routeRef = projectRouteRef(project);
            const isActive = activeProjectRef === routeRef || activeProjectRef === project.id;
            return (
              <Tooltip key={project.id}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={`/projects/${routeRef}/issues`}
                    onClick={() => { if (isMobile) setSidebarOpen(false); }}
                    className={cn(
                      "relative flex items-center justify-center size-9 rounded-md transition-colors",
                      isActive
                        ? "bg-brand/[0.08]"
                        : "hover:bg-white/[0.04]",
                    )}
                  >
                    {project.type === "project" ? (
                      <Rocket className="size-4 shrink-0" style={{ color: project.color ?? "#6366f1" }} />
                    ) : (
                      <span
                        className="size-3.5 rounded-sm shrink-0"
                        style={{ backgroundColor: project.color ?? "#6366f1" }}
                      />
                    )}
                    {isActive && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute right-1.5 top-1.5 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                      />
                    )}
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>{project.name}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  // Expanded mode: collapsible list with drag-drop
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              {label}
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewProject({ type });
            }}
            className="flex items-center justify-center size-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label={newLabel}
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedProjects.map((project) => project.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-0.5 mt-0.5">
              {orderedProjects.map((project: Project) => (
                <SortableProjectItem
                  key={project.id}
                  activeProjectRef={activeProjectRef}
                  isMobile={isMobile}
                  project={project}
                  setSidebarOpen={setSidebarOpen}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CollapsibleContent>
    </Collapsible>
  );
}
