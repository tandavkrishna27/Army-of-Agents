import {useEffect,useMemo,useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {universeCatchupApi} from "../../api/universe-catchup";
import {useLiveUpdates} from "../../context/LiveUpdatesProvider";
import {queryKeys} from "../../lib/queryKeys";
import {acceptHint,acceptSnapshot,type ReconciliationState} from "./reconciliation-state";

const COALESCE_MS=200, SAFETY_REFRESH_MS=30_000;

export function useUniverseReconciliation(input:{companyId:string;conversationId:string|null;ownerSession:string}){
  const {companyId,conversationId,ownerSession}=input;
  const live=useLiveUpdates(),client=useQueryClient(),generation=useRef(0),timer=useRef<number|null>(null);
  const key=useMemo(()=>conversationId?queryKeys.universeSnapshot(companyId,conversationId,ownerSession):["universe-snapshot","disabled"],
    [companyId,conversationId,ownerSession]);
  const [state,setState]=useState<ReconciliationState>(()=>({generation:0,lastSeq:0,status:"loading",dirtyRefs:[]}));
  const query=useQuery({queryKey:key,enabled:!!conversationId,retry:3,retryDelay:attempt=>Math.min(30_000,1000*2**attempt),
    queryFn:({signal})=>universeCatchupApi.get(companyId,conversationId!,signal),
    refetchInterval:()=>typeof document!=="undefined"&&document.visibilityState==="visible"&&live.connectionState==="open"?SAFETY_REFRESH_MS:false});

  useEffect(()=>{generation.current+=1;setState({generation:generation.current,lastSeq:0,status:conversationId?"loading":"current",dirtyRefs:[]});
    return()=>{if(timer.current!==null)window.clearTimeout(timer.current);timer.current=null;};},[companyId,conversationId,ownerSession]);
  useEffect(()=>{if(query.data)setState(previous=>acceptSnapshot(previous,query.data.currentSeq));},[query.data]);
  useEffect(()=>{if(live.connectionState==="offline")setState(previous=>({...previous,status:"offline"}));
    else if(live.connectionState!=="open")setState(previous=>({...previous,status:"stale"}));},[live.connectionState]);
  useEffect(()=>live.onEventHint(hint=>{
    if(!conversationId)return;setState(previous=>acceptHint(previous,hint));
    if(timer.current!==null)return;
    timer.current=window.setTimeout(()=>{timer.current=null;void client.invalidateQueries({queryKey:key});},COALESCE_MS);
  }),[client,conversationId,key,live]);
  useEffect(()=>live.onReconnect(()=>{if(conversationId)void client.invalidateQueries({queryKey:key});}),[client,conversationId,key,live]);
  useEffect(()=>{const refresh=()=>{if(document.visibilityState==="visible"&&conversationId)void client.invalidateQueries({queryKey:key});};
    document.addEventListener("visibilitychange",refresh);window.addEventListener("online",refresh);return()=>{document.removeEventListener("visibilitychange",refresh);window.removeEventListener("online",refresh);};},[client,conversationId,key]);
  return {state,query};
}
