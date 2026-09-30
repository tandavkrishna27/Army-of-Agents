import { universeReconciliationSnapshotSchema, type UniverseAttentionResponse, type UniverseReconciliationSnapshot, type UserRole, type UniverseLayoutDocument } from "@armyofagents/shared";

const MAX_REFERENCES = 100;
export type UniverseCatchupScope = {companyId:string;conversationId:string;userId:string};
type LayoutSnapshot = {schemaVersion:number;revision:number;document:UniverseLayoutDocument};
type TaskProjection = {id:string;companyId:string;title:string;status:string;updatedAt:Date};
type OutputProjection = {id:string;issueId:string;type:string;title:string;status:string;artifactId:string|null;artifactVersionId:string|null;updatedAt:Date};
export interface UniverseCatchupDependencies {
  requireOwner(scope:UniverseCatchupScope):Promise<void>;
  currentSeq(companyId:string):Promise<number|null>;
  getLayout(scope:UniverseCatchupScope):Promise<LayoutSnapshot>;
  getTask(companyId:string,taskId:string):Promise<TaskProjection|null>;
  getOutputs(companyId:string,taskId:string):Promise<OutputProjection[]>;
  getAttention(input:{companyId:string;actorUserId:string;role:UserRole}):Promise<UniverseAttentionResponse>;
  now():Date;
}
export type UniverseCatchupInput=UniverseCatchupScope&{role:UserRole};

/** Pure orchestration core. All operations are reads; it cannot dispatch or submit work. */
export function createUniverseCatchupService(deps:UniverseCatchupDependencies){return{async get(input:UniverseCatchupInput):Promise<UniverseReconciliationSnapshot>{
  const scope={companyId:input.companyId,conversationId:input.conversationId,userId:input.userId};
  await deps.requireOwner(scope);
  const seq=await deps.currentSeq(input.companyId);
  const partialReasons:string[]=[];
  if(seq===null)partialReasons.push("durable_event_cursor_unavailable");
  let layout:LayoutSnapshot;
  try{layout=await deps.getLayout(scope);}catch{partialReasons.push("layout_references_unavailable");layout={schemaVersion:1,revision:0,document:{panels:[],order:[],selected:null,maximized:null,viewport:{x:0,y:0,zoom:1},nextOpenedOrdinal:1}};}
  const panels=layout.document.panels.slice(0,MAX_REFERENCES);
  if(layout.document.panels.length>MAX_REFERENCES)partialReasons.push("reference_limit_reached");
  const tasks:UniverseReconciliationSnapshot["tasks"]=[],outputs:UniverseReconciliationSnapshot["outputs"]=[],references:UniverseReconciliationSnapshot["references"]=[];
  for(const panel of panels){
    const reference={key:panel.key,kind:panel.ref.kind,id:panel.ref.id,...(panel.ref.version?{version:panel.ref.version}:{})};
    if(panel.ref.kind!=="task"){references.push({...reference,available:true});continue;}
    const task=await deps.getTask(input.companyId,panel.ref.id);const available=task?.companyId===input.companyId;
    references.push({...reference,available});if(!available||!task)continue;
    tasks.push({id:task.id,title:task.title,status:task.status,updatedAt:task.updatedAt.toISOString()});
    outputs.push(...(await deps.getOutputs(input.companyId,task.id)).map(output=>({id:output.id,issueId:output.issueId,type:output.type,title:output.title,status:output.status,artifactId:output.artifactId,artifactVersionId:output.artifactVersionId,updatedAt:output.updatedAt.toISOString()})));
  }
  let attention:UniverseAttentionResponse|null=null;
  try{attention=await deps.getAttention({companyId:input.companyId,actorUserId:input.userId,role:input.role});}catch{partialReasons.push("attention_unavailable");}
  return universeReconciliationSnapshotSchema.parse({conversationId:input.conversationId,currentSeq:seq??0,layoutRevision:layout.revision,observedAt:deps.now().toISOString(),references,tasks,outputs,attention,partialReasons:[...new Set(partialReasons)]});
}};}
