import type { Issue } from "@armyofagents/shared";
import { panelKey, type State } from "./panel-state";
import type { WorkspaceHandle } from "./UniverseWorkspace";

export type TaskEntryRoute = "needs-you" | "work" | "artifact-source" | "open-panels" | "direct-reference";

export type OpenTaskReferenceInput = {
  issueId: string;
  anchorId?: string | null;
  route: TaskEntryRoute;
};

export async function openTaskReference(input: OpenTaskReferenceInput, deps: {
  companyId: string;
  state: State;
  workspace: WorkspaceHandle;
  resolveIssue: (issueId: string) => Promise<Issue>;
}) {
  const issue = await deps.resolveIssue(input.issueId);
  if (issue.id !== input.issueId || issue.companyId !== deps.companyId) throw new Error("Task is unavailable.");
  const ref = {companyId: deps.companyId, kind: "task" as const, id: issue.id};
  const key = panelKey(deps.state.scope, ref);
  const existing = deps.workspace.getState().panels[key];
  if (existing) {
    deps.workspace.dispatch({type: existing.minimized ? "restore" : "focus", key, generation: existing.generation});
    deps.workspace.requestNavigation({
      id: crypto.randomUUID(), panelKey: key, generation: existing.generation,
      cause: "user-reference", highlight: input.route !== "open-panels",
    });
  } else deps.workspace.open({ref, title: issue.title});
  if (input.anchorId) queueMicrotask(() => document.getElementById(input.anchorId!)?.scrollIntoView({block:"nearest"}));
  return {key, route: input.route};
}
