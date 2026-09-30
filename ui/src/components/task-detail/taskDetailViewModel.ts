export type TaskDetailTab =
  | "overview"
  | "work"
  | "comments"
  | "subtasks"
  | "activity";

export const TASK_DETAIL_TAB_ORDER = [
  "overview",
  "work",
  "comments",
  "subtasks",
  "activity",
] as const satisfies readonly TaskDetailTab[];

const TASK_DETAIL_TAB_LABELS: Record<TaskDetailTab, string> = {
  overview: "Overview",
  work: "Work",
  comments: "Comments",
  subtasks: "Sub-tasks",
  activity: "Activity",
};

export type TaskDetailTabBadgesInput = {
  comments?: number | null;
  subtasks?: number | null;
  activity?: number | null;
  artifacts?: number | null;
  dependencies?: number | null;
  documents?: number | null;
  attachments?: number | null;
  contextBundles?: number | null;
  hasWorkspace?: boolean | null;
};

export type TaskDetailTabBadges = Record<TaskDetailTab, number | null>;

function count(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function badge(value: number) {
  return value > 0 ? value : null;
}

export function getDefaultTaskDetailTab(): TaskDetailTab {
  return "overview";
}

export function getTaskDetailTabLabel(tab: TaskDetailTab): string {
  return TASK_DETAIL_TAB_LABELS[tab];
}

export function getTaskDetailTabBadges(input: TaskDetailTabBadgesInput): TaskDetailTabBadges {
  const workCount =
    count(input.dependencies) +
    count(input.documents) +
    count(input.attachments) +
    count(input.artifacts) +
    count(input.contextBundles) +
    (input.hasWorkspace ? 1 : 0);

  return {
    overview: null,
    work: badge(workCount),
    comments: badge(count(input.comments)),
    subtasks: badge(count(input.subtasks)),
    activity: badge(count(input.activity)),
  };
}
