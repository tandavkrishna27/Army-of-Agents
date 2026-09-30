import {and,eq} from "drizzle-orm";
import {internalAgentConversations,type Db} from "@armyofagents/db";
import {notFound} from "../errors.js";
import {getLiveEventLogStore} from "./live-events.js";
import {issueService} from "./issues.js";
import {taskOutputService} from "./task-outputs.js";
import {universeAttentionProjectionService} from "./universe-attention-projection.js";
import {universeLayoutService} from "./universe-layout.js";
import {createUniverseCatchupService} from "./universe-catchup-core.js";

export {createUniverseCatchupService} from "./universe-catchup-core.js";

/** Production adapters for the canonical read owners. */
export function universeCatchupService(db:Db){
  const layouts=universeLayoutService(db),issues=issueService(db),outputs=taskOutputService(db),attention=universeAttentionProjectionService(db);
  return createUniverseCatchupService({
    async requireOwner(scope){
      const [row]=await db.select({id:internalAgentConversations.id}).from(internalAgentConversations).where(and(eq(internalAgentConversations.id,scope.conversationId),eq(internalAgentConversations.companyId,scope.companyId),eq(internalAgentConversations.userId,scope.userId)));
      if(!row)throw notFound("Conversation not found");
    },
    async currentSeq(companyId){return(await getLiveEventLogStore()?.currentSeq(companyId))??null;},
    getLayout:scope=>layouts.get(scope),
    async getTask(companyId,taskId){const task=await issues.getById(taskId);return task?.companyId===companyId?task:null;},
    getOutputs:(companyId,taskId)=>outputs.listForIssue(companyId,taskId),
    getAttention:input=>attention.get(input),
    now:()=>new Date(),
  });
}
