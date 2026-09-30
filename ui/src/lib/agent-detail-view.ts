export type AgentDetailView =
  | "overview"
  | "instructions"
  | "configure"
  | "runs"
  | "skills";

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "configure" || value === "configuration") return "configure";
  if (value === "instructions") return value;
  if (value === "runs") return value;
  if (value === "skills") return value;
  return "overview";
}
