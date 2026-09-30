import {isTransientUniverseReadError} from "./transient-read-error";
import {useQuery} from "@tanstack/react-query";
import {issuesApi} from "../../api/issues";
import {queryKeys} from "../../lib/queryKeys";
import {useCompany} from "../../context/CompanyContext";
import {TaskConversationContent, type TaskConversationContentProps} from "../task-detail/TaskConversationContent";
import {useUniverseOwner} from "./useUniverseOwner";

export interface TaskPanelProps extends TaskConversationContentProps {
  companyId: string;
  panelKey: string;
  generation: number;
}

/** Authorize before mounting canonical task queries. The Universe frame alone
 * owns pin/minimize/maximize/close, so this content cannot introduce a second frame. */
export function TaskConversationPanel({companyId, panelKey, generation, ...content}: TaskPanelProps) {
  const {selectedCompanyId} = useCompany();
  const owner = useUniverseOwner();
  const enabled = !!owner.identity && owner.isVerified && owner.isCurrent() && selectedCompanyId === companyId;
  const task = useQuery({
    queryKey: [...queryKeys.issues.detail(content.issueId), "universe-owner", owner.identity, companyId],
    enabled,
    retry: false,
    queryFn: async () => {
      const issue = await issuesApi.get(content.issueId);
      if (issue.companyId !== companyId || issue.id !== content.issueId)
        throw new Error("Task is unavailable in this workspace");
      return issue;
    },
  });
  const suspended = task.isError && !!task.data && isTransientUniverseReadError(task.error);
  if (!enabled || (task.isError && !suspended)) return <p role="alert">Task is unavailable in this workspace.</p>;
  if (!task.data) return <p role="status">Loading task…</p>;
  return <>
    {suspended && <p role="alert">Task could not be refreshed. <button type="button" onClick={() => void task.refetch()}>Retry task</button></p>}
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    style={content.active && !suspended ? undefined : {display: "none"}}
    data-panel-key={panelKey} data-panel-generation={generation}>
    <TaskConversationContent key={JSON.stringify([owner.identity, companyId, content.issueId])}
      {...content} className="flex-1 min-h-0"/>
  </div></>;
}
