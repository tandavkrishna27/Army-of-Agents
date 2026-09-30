export type TaskAssigneeKind = "agent" | "user" | "none";

export type TaskAssigneeValue =
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string }
  | { kind: "none"; id: null };

export type TaskAssigneePayload = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export function formatTaskAssigneeValue(kind: TaskAssigneeKind, id?: string | null): string {
  if (kind === "none" || !id) return "";
  return `${kind}:${id}`;
}

export function parseTaskAssigneeValue(value: string): TaskAssigneeValue {
  if (!value) return { kind: "none", id: null };
  const [kind, id] = value.split(":", 2);
  if ((kind === "agent" || kind === "user") && id) {
    return { kind, id };
  }
  return { kind: "none", id: null };
}

export function taskAssigneePayload(value: string): TaskAssigneePayload {
  const parsed = parseTaskAssigneeValue(value);
  if (parsed.kind === "agent") {
    return { assigneeAgentId: parsed.id, assigneeUserId: null };
  }
  if (parsed.kind === "user") {
    return { assigneeAgentId: null, assigneeUserId: parsed.id };
  }
  return { assigneeAgentId: null, assigneeUserId: null };
}
