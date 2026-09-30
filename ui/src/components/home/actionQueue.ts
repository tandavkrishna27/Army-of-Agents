import type { ElementType } from "react";
import { AlertCircle, Clock, Eye } from "lucide-react";
import type { HomeSummary } from "@armyofagents/shared";

export interface ActionGroupItem {
  key: string;
  label: string;
  sublabel?: string;
  to: string;
}

export interface ActionGroup {
  id: string;
  title: string;
  icon: ElementType;
  items: ActionGroupItem[];
}

export function buildActionGroups(data: HomeSummary): ActionGroup[] {
  const groups: ActionGroup[] = [];
  const needsReviewItems: ActionGroupItem[] = [];

  if (data.discussionsPendingReview > 0) {
    needsReviewItems.push({
      key: "discussions-review",
      label: `${data.discussionsPendingReview} discussion${data.discussionsPendingReview === 1 ? "" : "s"} pending review`,
      to: "/discussions",
    });
  }
  if (data.tasksInReview > 0) {
    needsReviewItems.push({
      key: "tasks-review",
      label: `${data.tasksInReview} task${data.tasksInReview === 1 ? "" : "s"} in review`,
      to: "/issues?status=in_review",
    });
  }
  if (needsReviewItems.length > 0) {
    groups.push({ id: "needs-review", title: "Needs Review", icon: Eye, items: needsReviewItems });
  }

  if (data.blockedTasks > 0) {
    groups.push({
      id: "blocked",
      title: "Blocked",
      icon: AlertCircle,
      items: [{
        key: "blocked-tasks",
        label: `${data.blockedTasks} blocked task${data.blockedTasks === 1 ? "" : "s"}`,
        to: "/issues?status=blocked",
      }],
    });
  }

  if (data.myTasksDueToday.length > 0) {
    groups.push({
      id: "due-today",
      title: "Due Today",
      icon: Clock,
      items: data.myTasksDueToday.map((task) => ({
        key: `due-${task.id}`,
        label: task.title,
        sublabel: task.status === "in_progress" ? "In progress" : task.status === "todo" ? "To do" : task.status,
        to: `/issues/${task.id}`,
      })),
    });
  }

  return groups;
}

export interface AllocatedActionGroup {
  group: ActionGroup;
  /** How many of this group's items to render — always <= group.items.length. */
  maxItems: number;
}

/**
 * Distributes a flattened row budget (from `rowsForSize`) across groups in
 * order, filling each group's own items until the budget runs out. A group
 * that would get 0 (the budget was already exhausted before reaching it) is
 * dropped from the result entirely rather than kept as an empty section —
 * its full item count still folds into `overflow` so the caller can render
 * one aggregate "+N more" line.
 *
 * Deliberately flat rather than per-group-proportional: `buildActionGroups`
 * produces "Needs Review"/"Blocked" as near-always 1-2 aggregate-count items
 * and "Due Today" as the only group whose size can really grow, so there's
 * no single "fair" way to split a fixed budget across such differently-
 * shaped groups — simplicity (fill in order, spill the rest into one
 * overflow count) wins over a cleverer per-group split.
 */
export function allocateActionGroups(
  groups: ActionGroup[],
  maxTotalItems: number,
): { allocated: AllocatedActionGroup[]; overflow: number } {
  let remaining = maxTotalItems;
  let overflow = 0;
  const allocated: AllocatedActionGroup[] = [];
  for (const group of groups) {
    const take = Math.max(0, Math.min(group.items.length, remaining));
    if (take > 0) {
      allocated.push({ group, maxItems: take });
    }
    overflow += group.items.length - take;
    remaining -= take;
  }
  return { allocated, overflow };
}
