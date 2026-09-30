import { z } from "zod";

export const COCKPIT_PRESENTATION_VERSION = 3 as const;

export const COCKPIT_ATTENTION_FILTERS = ["all", "needs_me", "at_risk"] as const;
export const COCKPIT_SECTION_IDS = [
  "my_work",
  "conversations",
  "company_overview",
  "context",
] as const;
export const COCKPIT_RELATIONSHIPS = ["to_do", "managing", "following"] as const;
export const COCKPIT_GROUP_IDS = [
  "to_do_tasks",
  "to_do_decisions",
  "managing",
  "following",
] as const;
export const COCKPIT_ATTENTION_KINDS = [
  "question",
  "approval",
  "review",
  "reply_request",
  "blocked",
  "overdue",
  "sla_breach",
  "at_risk",
  "continuation_failed",
  "waiting_on_human",
  "running",
  "queued",
  "unread",
  "updated",
  "completed",
] as const;

export type CockpitAttentionFilter = (typeof COCKPIT_ATTENTION_FILTERS)[number];
export type CockpitSectionId = (typeof COCKPIT_SECTION_IDS)[number];
export type CockpitRelationship = (typeof COCKPIT_RELATIONSHIPS)[number] | null;
export type CockpitGroupId = (typeof COCKPIT_GROUP_IDS)[number];
export type CockpitAttentionKind = (typeof COCKPIT_ATTENTION_KINDS)[number];
export type CockpitAttentionCategory = "required_action" | "risk" | "execution" | "change";
export type CockpitAttentionTone = "warning" | "error" | "info" | "success";

export interface CockpitEntityRef {
  kind: string;
  id: string;
}

export interface CommanderAnchor {
  kind: "question" | "review" | "message" | "action";
  id: string;
}

export interface CommanderViewerTabDescriptor {
  id: string;
  kind: "artifact" | "run" | "approval" | "inbox" | "task" | "discussion" | "note";
  title: string;
  refId: string;
  versionId?: string | null;
}

export type CommanderOpenTarget =
  | { surface: "workspace"; issueId: string; anchor?: CommanderAnchor }
  | { surface: "discussion"; discussionId: string; anchor?: CommanderAnchor }
  | { surface: "viewer"; tab: CommanderViewerTabDescriptor }
  | { surface: "workspace_and_viewer"; issueId: string; tab: CommanderViewerTabDescriptor }
  | { surface: "note"; noteId: string }
  | { surface: "route"; href: string; reason: string };

export interface CockpitAttentionSignal {
  kind: CockpitAttentionKind;
  label: string;
  category: CockpitAttentionCategory;
  tone: CockpitAttentionTone;
  needsMe: boolean;
  atRisk: boolean;
}

export interface CockpitLinkedAction {
  id: string;
  kind: "question" | "approval" | "review" | "inbox_request";
  workflowRef: CockpitEntityRef;
  relatedRefs: CockpitEntityRef[];
  label: string;
  attention: CockpitAttentionSignal;
  openTarget: CommanderOpenTarget;
}

export interface CockpitPresentationItem {
  key: string;
  primaryRef: CockpitEntityRef;
  title: string;
  subtitle: string | null;
  relationship: CockpitRelationship;
  groupId: CockpitGroupId | null;
  attention: CockpitAttentionSignal[];
  actions: CockpitLinkedAction[];
  primaryActionId: string | null;
  openTarget: CommanderOpenTarget;
  updatedAt: string;
}

export interface CockpitGroup {
  id: CockpitGroupId | string;
  title: string;
  items: CockpitPresentationItem[];
  total: number;
  nextCursor: string | null;
}

export interface CockpitPresentationSection {
  id: CockpitSectionId;
  groups: CockpitGroup[];
}

export interface CockpitPresentationMeta {
  generatedAt: string;
  partial: boolean;
  slices: Record<string, { status: "ok" | "error"; errorCode?: string }>;
}

export interface CockpitPresentation {
  version: typeof COCKPIT_PRESENTATION_VERSION;
  activeFilter: CockpitAttentionFilter;
  filterCounts: { all: number; needsMe: number; atRisk: number };
  sections: CockpitPresentationSection[];
  meta: CockpitPresentationMeta;
}

const entityRefSchema = z.object({ kind: z.string().min(1), id: z.string().min(1) }).strict();
const anchorSchema = z.object({
  kind: z.enum(["question", "review", "message", "action"]),
  id: z.string().min(1),
}).strict();
const viewerTabSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["artifact", "run", "approval", "inbox", "task", "discussion", "note"]),
  title: z.string().min(1),
  refId: z.string().min(1),
  versionId: z.string().nullable().optional(),
}).strict();

export const commanderOpenTargetSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("workspace"), issueId: z.string().min(1), anchor: anchorSchema.optional() }).strict(),
  z.object({ surface: z.literal("discussion"), discussionId: z.string().min(1), anchor: anchorSchema.optional() }).strict(),
  z.object({ surface: z.literal("viewer"), tab: viewerTabSchema }).strict(),
  z.object({ surface: z.literal("workspace_and_viewer"), issueId: z.string().min(1), tab: viewerTabSchema }).strict(),
  z.object({ surface: z.literal("note"), noteId: z.string().min(1) }).strict(),
  z.object({ surface: z.literal("route"), href: z.string().min(1), reason: z.string().min(1) }).strict(),
]);

export const cockpitAttentionSignalSchema = z.object({
  kind: z.enum(COCKPIT_ATTENTION_KINDS),
  label: z.string().min(1),
  category: z.enum(["required_action", "risk", "execution", "change"]),
  tone: z.enum(["warning", "error", "info", "success"]),
  needsMe: z.boolean(),
  atRisk: z.boolean(),
}).strict();

const linkedActionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["question", "approval", "review", "inbox_request"]),
  workflowRef: entityRefSchema,
  relatedRefs: z.array(entityRefSchema),
  label: z.string().min(1),
  attention: cockpitAttentionSignalSchema,
  openTarget: commanderOpenTargetSchema,
}).strict();

export const cockpitPresentationItemSchema = z.object({
  key: z.string().min(1),
  primaryRef: entityRefSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  relationship: z.enum(COCKPIT_RELATIONSHIPS).nullable(),
  groupId: z.enum(COCKPIT_GROUP_IDS).nullable(),
  attention: z.array(cockpitAttentionSignalSchema),
  actions: z.array(linkedActionSchema),
  primaryActionId: z.string().nullable(),
  openTarget: commanderOpenTargetSchema,
  updatedAt: z.string().datetime(),
}).strict().superRefine((item, ctx) => {
  if (item.primaryActionId && !item.actions.some((action) => action.id === item.primaryActionId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["primaryActionId"], message: "must reference an action on the item" });
  }
});

const groupSchema = z.object({
  id: z.union([z.enum(COCKPIT_GROUP_IDS), z.string().min(1)]),
  title: z.string().min(1),
  items: z.array(cockpitPresentationItemSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

export const cockpitPresentationSchema = z.object({
  version: z.literal(COCKPIT_PRESENTATION_VERSION),
  activeFilter: z.enum(COCKPIT_ATTENTION_FILTERS),
  filterCounts: z.object({
    all: z.number().int().nonnegative(),
    needsMe: z.number().int().nonnegative(),
    atRisk: z.number().int().nonnegative(),
  }).strict(),
  sections: z.array(z.object({
    id: z.enum(COCKPIT_SECTION_IDS),
    groups: z.array(groupSchema),
  }).strict()),
  meta: z.object({
    generatedAt: z.string().datetime(),
    partial: z.boolean(),
    slices: z.record(z.object({
      status: z.enum(["ok", "error"]),
      errorCode: z.string().optional(),
    }).strict()),
  }).strict(),
}).strict();

export interface CockpitRelationshipInput {
  assignedToCurrentUser: boolean;
  responsibleForTask: boolean;
  executedByAnother: boolean;
  inReportingScope: boolean;
  explicitlyFollowed: boolean;
  hasRequiredAction: boolean;
}

export function classifyCockpitRelationship(input: CockpitRelationshipInput): CockpitRelationship {
  if (input.assignedToCurrentUser || (input.responsibleForTask && !input.executedByAnother)) {
    return "to_do";
  }
  if ((input.responsibleForTask && input.executedByAnother) || input.inReportingScope) {
    return "managing";
  }
  if (input.explicitlyFollowed) return "following";
  if (input.hasRequiredAction) return "to_do";
  return null;
}

const ATTENTION_DEFINITIONS: Record<CockpitAttentionKind, Omit<CockpitAttentionSignal, "kind" | "label">> = {
  question: { category: "required_action", tone: "warning", needsMe: true, atRisk: false },
  approval: { category: "required_action", tone: "warning", needsMe: true, atRisk: false },
  review: { category: "required_action", tone: "warning", needsMe: true, atRisk: false },
  reply_request: { category: "required_action", tone: "warning", needsMe: true, atRisk: false },
  blocked: { category: "risk", tone: "error", needsMe: false, atRisk: true },
  overdue: { category: "risk", tone: "error", needsMe: false, atRisk: true },
  sla_breach: { category: "risk", tone: "error", needsMe: false, atRisk: true },
  at_risk: { category: "risk", tone: "error", needsMe: false, atRisk: true },
  continuation_failed: { category: "risk", tone: "error", needsMe: true, atRisk: true },
  waiting_on_human: { category: "execution", tone: "info", needsMe: false, atRisk: false },
  running: { category: "execution", tone: "info", needsMe: false, atRisk: false },
  queued: { category: "execution", tone: "info", needsMe: false, atRisk: false },
  unread: { category: "change", tone: "info", needsMe: false, atRisk: false },
  updated: { category: "change", tone: "info", needsMe: false, atRisk: false },
  completed: { category: "change", tone: "success", needsMe: false, atRisk: false },
};

export function createCockpitAttentionSignal(
  kind: CockpitAttentionKind,
  label: string,
): CockpitAttentionSignal {
  return { kind, label, ...ATTENTION_DEFINITIONS[kind] };
}

export function matchesCockpitAttentionFilter(
  signals: readonly CockpitAttentionSignal[],
  filter: CockpitAttentionFilter,
): boolean {
  if (filter === "all") return true;
  return filter === "needs_me"
    ? signals.some((signal) => signal.needsMe)
    : signals.some((signal) => signal.atRisk);
}
