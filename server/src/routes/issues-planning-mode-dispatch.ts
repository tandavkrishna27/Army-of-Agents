export function shouldDispatchIssueWakeup(issue: { workMode: string | null }): boolean {
  return issue.workMode !== "planning";
}
