export type ActivityActorType = "agent" | "user" | "system" | "autonomy";

export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: ActivityActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}
