export const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
export const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];

export const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the routine is already active.",
};
export const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the routine or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};

export function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

/** Maps a run status to a display label and Tailwind text color class. */
export function runStatusStyle(status: string): { label: string; colorClass: string } {
  const labels: Record<string, string> = {
    issue_created: "issue created",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
    coalesced: "coalesced",
    received: "running",
  };

  let colorClass = "text-muted-foreground";
  if (status === "issue_created" || status === "completed") colorClass = "text-emerald-400";
  else if (status === "failed") colorClass = "text-destructive";
  else if (status === "received") colorClass = "text-blue-400";

  return { label: labels[status] ?? status.replaceAll("_", " "), colorClass };
}

/** Badge class overrides for run status (used in Badge variant="secondary" className). */
export function runStatusBadgeClass(status: string): string {
  if (status === "issue_created" || status === "completed")
    return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
  if (status === "failed")
    return "bg-destructive/10 text-destructive border border-destructive/20";
  if (status === "received")
    return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
  return "";
}
