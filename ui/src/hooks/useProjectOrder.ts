import { useCallback, useMemo } from "react";
import type { Project } from "@armyofagents/shared";
import { sortProjectsByStoredOrder } from "../lib/project-order";
import { useSidebarOrder, type SidebarOrderType } from "./useSidebarOrder";

type UseProjectOrderParams = {
  projects: Project[];
  companyId: string | null | undefined;
  /** If provided, reads/writes only the matching section's order.
   *  When omitted, callers get a combined view suitable for read-only sorting. */
  type?: SidebarOrderType;
  /** @deprecated userId is resolved server-side from the session; ignored. */
  userId?: string | null | undefined;
};

export function useProjectOrder({ projects, companyId, type }: UseProjectOrderParams) {
  const { departmentOrder, projectOrder, setOrder } = useSidebarOrder(companyId);

  const storedIds = useMemo(() => {
    if (type) return type === "department" ? departmentOrder : projectOrder;
    return [...departmentOrder, ...projectOrder];
  }, [type, departmentOrder, projectOrder]);

  const orderedProjects = useMemo(
    () => sortProjectsByStoredOrder(projects, storedIds),
    [projects, storedIds],
  );

  const orderedIds = useMemo(
    () => orderedProjects.map((project) => project.id),
    [orderedProjects],
  );

  const persistOrder = useCallback(
    (ids: string[]) => {
      if (!type) return;
      const idSet = new Set(projects.map((project) => project.id));
      const filtered = ids.filter((id) => idSet.has(id));
      for (const project of projects) {
        if (!filtered.includes(project.id)) filtered.push(project.id);
      }
      setOrder(type, filtered);
    },
    [projects, setOrder, type],
  );

  return {
    orderedProjects,
    orderedIds,
    persistOrder,
  };
}
