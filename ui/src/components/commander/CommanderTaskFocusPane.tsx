import { TaskDetail } from "../TaskDetail";
import type { TaskDetailTab } from "../task-detail/taskDetailViewModel";

interface CommanderTaskFocusPaneProps {
  issueId: string;
  anchorId?: string;
  onClose: () => void;
}

export function initialTabForAnchor(anchorId?: string): TaskDetailTab {
  if (
    anchorId === "question"
    || anchorId === "work"
    || (anchorId != null && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(anchorId))
  ) return "work";
  return "overview";
}

export function CommanderTaskFocusPane({
  issueId,
  anchorId,
  onClose,
}: CommanderTaskFocusPaneProps) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-testid="commander-task-focus-pane"
      data-issue-id={issueId}
    >
      <TaskDetail
        issueId={issueId}
        active
        initialTab={initialTabForAnchor(anchorId)}
        initialMode="workspace"
        workspaceAnchorId={anchorId}
        onDismiss={onClose}
      />
    </div>
  );
}
