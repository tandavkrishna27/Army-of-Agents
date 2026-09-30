import { Activity, Bell, Brain, CircleDollarSign, Cpu, Inbox, Lightbulb, ListChecks, MessagesSquare, Target } from "lucide-react";
import { HOME_BOARD_ALLOWED_SIZES } from "@armyofagents/shared";
import type { WidgetDef, WidgetKey } from "./types";
import { ActionQueueWidget } from "./ActionQueueWidget";
import { SuggestionsWidget } from "./SuggestionsWidget";
import { ObjectivesWidget } from "./ObjectivesWidget";
import { ActivityFeedWidget } from "./ActivityFeedWidget";
import { AgentsNowWidget } from "./AgentsNowWidget";
import { BudgetWidget } from "./BudgetWidget";
import { ApprovalsWidget } from "./ApprovalsWidget";
import { MyTasksWidget } from "./MyTasksWidget";
import { DiscussionsWidget } from "./DiscussionsWidget";
import { MemoryReviewWidget } from "./MemoryReviewWidget";

export const widgetRegistry: Record<WidgetKey, WidgetDef> = {
  "action-queue": {
    key: "action-queue",
    title: "Action queue",
    icon: Inbox,
    Component: ActionQueueWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES["action-queue"],
    defaultSize: HOME_BOARD_ALLOWED_SIZES["action-queue"][0],
  },
  suggestions: {
    key: "suggestions",
    title: "Suggestions",
    icon: Lightbulb,
    Component: SuggestionsWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES.suggestions,
    defaultSize: HOME_BOARD_ALLOWED_SIZES.suggestions[0],
  },
  objectives: {
    key: "objectives",
    title: "Objectives",
    icon: Target,
    Component: ObjectivesWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES.objectives,
    defaultSize: HOME_BOARD_ALLOWED_SIZES.objectives[0],
  },
  "activity-feed": {
    key: "activity-feed",
    title: "Today's activity",
    icon: Activity,
    Component: ActivityFeedWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES["activity-feed"],
    defaultSize: HOME_BOARD_ALLOWED_SIZES["activity-feed"][0],
  },
  "agents-now": {
    key: "agents-now",
    title: "Agents working now",
    icon: Cpu,
    Component: AgentsNowWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES["agents-now"],
    defaultSize: HOME_BOARD_ALLOWED_SIZES["agents-now"][0],
  },
  budget: {
    key: "budget",
    title: "Budget",
    icon: CircleDollarSign,
    Component: BudgetWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES.budget,
    defaultSize: HOME_BOARD_ALLOWED_SIZES.budget[0],
  },
  approvals: {
    key: "approvals",
    title: "Waiting on you",
    icon: Bell,
    Component: ApprovalsWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES.approvals,
    defaultSize: HOME_BOARD_ALLOWED_SIZES.approvals[0],
  },
  "my-tasks": {
    key: "my-tasks",
    title: "My tasks",
    icon: ListChecks,
    Component: MyTasksWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES["my-tasks"],
    defaultSize: HOME_BOARD_ALLOWED_SIZES["my-tasks"][0],
  },
  discussions: {
    key: "discussions",
    title: "Discussions",
    icon: MessagesSquare,
    Component: DiscussionsWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES.discussions,
    defaultSize: HOME_BOARD_ALLOWED_SIZES.discussions[0],
  },
  "memory-review": {
    key: "memory-review",
    title: "Memory review",
    icon: Brain,
    requiresFounder: true,
    Component: MemoryReviewWidget,
    allowedSizes: HOME_BOARD_ALLOWED_SIZES["memory-review"],
    defaultSize: HOME_BOARD_ALLOWED_SIZES["memory-review"][0],
  },
};
export function getWidget(key: WidgetKey): WidgetDef | undefined { return widgetRegistry[key]; }
export function listWidgets(): WidgetDef[] { return Object.values(widgetRegistry); }
