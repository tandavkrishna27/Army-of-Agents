/**
 * Always-on core (enterprise memory model, P1). A tiny deterministic block injected on
 * EVERY run regardless of retrieval ranking, so an agent always knows its role, its
 * current goal, and that a searchable company brain exists. Small by contract — this is
 * a signpost, not a memory dump (scenario O5).
 */
export function buildAlwaysOnCore(input: {
  agentRole: string | null;
  goalTitle: string | null;
}): string {
  const role = input.agentRole && input.agentRole.trim().length > 0 ? input.agentRole.trim() : "agent";
  const lines = [`You are the ${role} for this company.`];
  if (input.goalTitle && input.goalTitle.trim().length > 0) {
    lines.push(`Current goal: ${input.goalTitle.trim()}.`);
  }
  lines.push(
    "Company identity and policies exist in memory — call the query_memory tool before assuming or inventing context.",
  );
  return lines.join("\n");
}
