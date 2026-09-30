/** Explicit effects a task composer submission may request. */
export type TaskCommentAction = "comment" | "interrupt" | "reopen" | "reassign";

export interface TaskCommentActionInput {
  isClosed: boolean;
  reopenRequested: boolean;
  hasActiveRun: boolean;
  interruptRequested: boolean;
  hasReassignment: boolean;
}

/**
 * Ordinary comments are non-interrupting. Reopen, interrupt, and reassignment
 * are deliberate task mutations and are surfaced as distinct effects.
 */
export function resolveTaskCommentAction(input: TaskCommentActionInput): TaskCommentAction {
  if (input.hasReassignment) return "reassign";
  if (input.isClosed && input.reopenRequested) return "reopen";
  if (input.hasActiveRun && input.interruptRequested) return "interrupt";
  return "comment";
}
