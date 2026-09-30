import {useQuery} from "@tanstack/react-query";
import {useEffect,useRef,useState} from "react";
import type {UniverseAttentionEntry} from "@armyofagents/shared";
import {hubItemsApi} from "../../api/hub-items";
import {WorkQuestionPanel} from "../work-questions/WorkQuestionPanel";
import {RuntimeDecisionPanel} from "../hub/RuntimeDecisionPanel";
import {ApprovalDetailCore} from "../approval/ApprovalDetailCore";

export function AttentionQuestion({companyId, entry, onOpenTask, onClose}: {
  companyId: string;
  entry: UniverseAttentionEntry;
  onOpenTask: (issueId: string) => void;
  onClose: () => void;
}) {
  const [offset,setOffset]=useState({x:0,y:0});
  const drag=useRef<{pointerId:number;x:number;y:number;origin:{x:number;y:number}}|null>(null);
  useEffect(()=>{
    const move=(event:PointerEvent)=>{const active=drag.current;if(!active||event.pointerId!==active.pointerId)return;
      setOffset({x:active.origin.x+event.clientX-active.x,y:active.origin.y+event.clientY-active.y});};
    const end=(event:PointerEvent)=>{if(drag.current?.pointerId===event.pointerId)drag.current=null;};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",end);window.addEventListener("pointercancel",end);
    return()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",end);window.removeEventListener("pointercancel",end);};
  },[]);
  const needsHubRow = entry.sourceRef.kind === "runtime_decision";
  const hub = useQuery({queryKey:["hub-items",companyId,entry.id,"attention"], queryFn:()=>hubItemsApi.getOne(companyId,entry.id), enabled:needsHubRow, retry:false});
  return <aside className="universe-attention-question" aria-label={entry.title} style={{transform:`translate(${offset.x}px,${offset.y}px)`}}>
    <header className="universe-attention-question-handle" onPointerDown={event=>{
      if((event.target as HTMLElement).closest("button,input,select,textarea,a"))return;
      drag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,origin:offset};event.currentTarget.setPointerCapture?.(event.pointerId);
    }}>
      <strong>{entry.title}</strong><button type="button" aria-label="Hide question" onClick={onClose}>×</button>
    </header>
    <div className="universe-attention-question-body">
      {entry.sourceRef.kind === "work_question" && <WorkQuestionPanel companyId={companyId} questionId={entry.sourceRef.id} embedded/>}
      {entry.sourceRef.kind === "runtime_decision" && (hub.data
        ? <RuntimeDecisionPanel item={hub.data}/>
        : <p role={hub.isError ? "alert" : "status"}>{hub.isError ? "Question is no longer available." : "Loading question…"}</p>)}
      {entry.sourceRef.kind === "approval" && <ApprovalDetailCore approvalId={entry.sourceRef.id} embedded/>}
      {entry.sourceRef.kind === "task" && <button type="button" onClick={()=>onOpenTask(entry.sourceRef.id)}>Open task</button>}
      {(entry.sourceRef.kind === "hub" || entry.sourceRef.kind === "routine") && <p>{entry.summary || "Open Inbox for details."}</p>}
    </div>
  </aside>;
}
