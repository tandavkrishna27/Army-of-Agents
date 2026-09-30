import type {IssueAttachment} from "@armyofagents/shared";
import {WorkspaceTimeline} from "../workspace/WorkspaceTimeline";

export interface TaskConversationContentProps {
  issueId: string;
  active: boolean;
  anchorId?: string;
  className?: string;
  onOpenAttachment?: (attachment: IssueAttachment) => void;
}

/** Shared canonical task timeline and composer. Window actions belong to the host. */
export function TaskConversationContent({active: _active, ...props}: TaskConversationContentProps) {
  // The host controls visibility. Deactivation must not discard the canonical
  // composer's in-memory attachments or failed-send retry state.
  return <WorkspaceTimeline key={props.issueId} {...props} compact/>;
}
