import {render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {describe,expect,it,vi} from "vitest";
import {AttentionRail} from "../AttentionRail";
import {AttentionQuestion} from "../AttentionQuestion";
import {openTaskReference} from "../open-task-reference";
import {initialState,panelKey,panelReducer} from "../panel-state";
const h=vi.hoisted(()=>({getOne:vi.fn()}));
vi.mock("../../../api/hub-items",()=>({hubItemsApi:{getOne:h.getOne}}));
vi.mock("../../work-questions/WorkQuestionPanel",()=>({WorkQuestionPanel:({questionId}:{questionId:string})=><div>Question {questionId}</div>}));
vi.mock("../../approval/ApprovalDetailCore",()=>({ApprovalDetailCore:({approvalId}:{approvalId:string})=><div>Approval {approvalId}</div>}));
vi.mock("../../hub/RuntimeDecisionPanel",()=>({RuntimeDecisionPanel:()=> <div>Runtime decision</div>}));
const entry=(id:string,kind:"task"|"work_question"="task")=>({id,kind:"hub" as const,sourceId:id,title:`Title ${id}`,summary:"Summary",version:1,sourceRef:{kind,id},stale:false as const});
const response={asOf:new Date().toISOString(),needsYou:[entry("1"),entry("2"),entry("3"),entry("4"),entry("5"),entry("6")],ready:[],comingUp:[],nextCursor:null};

describe("Universe attention",()=>{
  it("shows no zero categories and caps a category at five",async()=>{
    const select=vi.fn(),finish=vi.fn(); render(<AttentionRail attention={response} onSelect={select} onViewAll={vi.fn()} onFinish={finish}/>);
    expect(screen.queryByText("Ready")).toBeNull(); expect(screen.getAllByRole("button")).toHaveLength(7);
    await userEvent.click(screen.getByRole("button",{name:/Title 1/})); expect(select).toHaveBeenCalledWith(response.needsYou[0]);
    await userEvent.click(screen.getByRole("button",{name:"Finish review"})); expect(finish).toHaveBeenCalledOnce();
  });
  it("hides a question view without resolving the source",async()=>{
    const close=vi.fn(); const client=new QueryClient();
    render(<QueryClientProvider client={client}><AttentionQuestion companyId="c" entry={entry("q","work_question")} onOpenTask={vi.fn()} onClose={close}/></QueryClientProvider>);
    expect(screen.getByText("Question q")).toBeInTheDocument(); await userEvent.click(screen.getByRole("button",{name:"Hide question"}));
    expect(close).toHaveBeenCalledOnce(); expect(h.getOne).not.toHaveBeenCalled();
  });
  it("routes every task entry through one stable panel identity",async()=>{
    const scope={companyId:"c",userId:"u",conversationId:"v"}; let state=initialState(scope);
    const dispatch=vi.fn((action:any)=>{state=panelReducer(state,action)}); const open=vi.fn(({ref,title}:any)=>dispatch({type:"open",ref,title,rect:{x:0,y:0,width:400,height:300}}));
    const workspace={dispatch,open,getState:()=>state,requestNavigation:vi.fn(()=>"moved")} as any;
    const resolveIssue=vi.fn(async()=>({id:"t",companyId:"c",title:"Task"}));
    for(const route of ["needs-you","work","artifact-source","open-panels","direct-reference"] as const)
      await openTaskReference({issueId:"t",route},{companyId:"c",state,workspace,resolveIssue});
    expect(open).toHaveBeenCalledOnce(); expect(Object.keys(state.panels)).toEqual([panelKey(scope,{companyId:"c",kind:"task",id:"t"})]);
    expect(workspace.requestNavigation).toHaveBeenCalledTimes(4);
  });
});
