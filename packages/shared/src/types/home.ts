export interface GoalProgress {
  id: string;
  title: string;
  status: string;
  totalTasks: number;
  doneTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  progressPercent: number;
}

export interface RecentActivityItem {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface SetupStatus {
  hasVisionMission: boolean;
  hasDepartment: boolean;
  hasAgent: boolean;
  hasGoal: boolean;
}

export interface GoalGapNudge {
  type: "goal_gap";
  goalId: string;
  goalTitle: string;
  message: string;
}

export interface HomeSummary {
  companyId: string;
  setupStatus: SetupStatus;
  /**
   * WS0b — the persisted first-run-done flag. Gates first-run vs
   * steady-state Home (`showOnboarding = !firstRunCompleted`), independent
   * of `setupStatus` (which never completes for In-flight/Explorer
   * personas). True for pre-existing members with no onboarding-progress
   * row, or for callers with no board-actor userId to check.
   */
  firstRunCompleted: boolean;
  discussionsPendingReview: number;
  tasksInReview: number;
  myTasksDueToday: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  }[];
  blockedTasks: number;
  pendingMemoryItems: number;
  recentActivity: RecentActivityItem[];
  goalProgress: GoalProgress[];
  nudges: GoalGapNudge[];
}
