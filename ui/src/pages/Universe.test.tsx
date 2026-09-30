import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, expect, it, vi} from "vitest";
import {Universe} from "./Universe";
import {queryKeys} from "../lib/queryKeys";
import {ApiError} from "../api/client";
const h=vi.hoisted(()=>({company:"c",verified:true,list:vi.fn(),tasks:vi.fn(),getTask:vi.fn(),attention:vi.fn(),create:vi.fn()}));
vi.mock("../context/CompanyContext",()=>({useCompany:()=>({selectedCompanyId:h.company,selectedCompany:{issuePrefix:"ACM"}})}));
vi.mock("../components/universe/useUniverseOwner",()=>({useUniverseOwner:()=>({identity:"owner:session",userId:"owner",isVerified:h.verified,isCurrent:()=>h.verified})}));
vi.mock("../api/internal-agent",()=>({commanderConversationsApi:{list:h.list,create:h.create}}));
vi.mock("../api/issues",()=>({issuesApi:{list:h.tasks,get:h.getTask}}));
vi.mock("../api/universe-attention",()=>({universeAttentionApi:{get:h.attention}}));
vi.mock("../components/universe/UniverseCommanderChat",()=>({UniverseCommanderChat:()=> <div>Canonical Commander composer</div>}));
vi.mock("../components/universe/PersistedUniverseWorkspace",()=>({PersistedUniverseWorkspace:({companyId,conversationId}:{companyId:string;conversationId:string})=><div>Workspace {companyId} {conversationId}</div>}));
function setup(url="/ACM/universe"){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});return {...render(<MemoryRouter initialEntries={[url]}><QueryClientProvider client={client}><Universe/></QueryClientProvider></MemoryRouter>),client};}
const mine={id:"mine",userId:"owner",title:"Mine"};
beforeEach(()=>{h.company="c";h.verified=true;h.list.mockReset();h.tasks.mockReset();h.getTask.mockReset();h.attention.mockReset();h.create.mockReset();h.tasks.mockResolvedValue([]);h.attention.mockResolvedValue({asOf:new Date().toISOString(),needsYou:[],ready:[],comingUp:[],nextCursor:null});});
it("only offers the authenticated owner's conversations even when the founder list includes others",async()=>{
 h.list.mockResolvedValue({conversations:[mine,{id:"foreign",userId:"other",title:"Private"}]});setup();
 expect(await screen.findByText("Workspace c mine")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Commander options"}));
 expect(screen.getByRole("button",{name:"Mine"})).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Private"})).toBeNull();
});
it("does not load private libraries before authentication",()=>{
 h.verified=false;setup();expect(h.list).not.toHaveBeenCalled();expect(h.tasks).not.toHaveBeenCalled();
});
it("does not create a conversation just by visiting the workspace",async()=>{
 h.list.mockResolvedValue({conversations:[]});setup();await screen.findByText("Canonical Commander composer");
 expect(h.create).not.toHaveBeenCalled();
});
it("removes retained conversation titles and content when the list is denied",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});const view=setup();await screen.findByText("Workspace c mine");
 fireEvent.click(screen.getByRole("button",{name:"Commander options"}));h.list.mockRejectedValue(new ApiError("Forbidden",403,null));
 await act(async()=>{await view.client.invalidateQueries({queryKey:["commander-conversations"]});});
 await waitFor(()=>expect(screen.queryByRole("button",{name:"Mine"})).toBeNull());
 expect(screen.queryByText("Workspace c mine")).toBeNull();
});
it("uses canonical task invalidation and removes denied task titles",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});
 h.tasks.mockResolvedValue([{id:"task",companyId:"c",title:"Private task"}]);const view=setup();
 await screen.findByText("Workspace c mine");fireEvent.click(screen.getByRole("button",{name:/^Work$/}));
 await screen.findByRole("button",{name:"Private task"});h.tasks.mockRejectedValue(new Error("Forbidden"));
 await act(async()=>{await view.client.invalidateQueries({queryKey:queryKeys.issues.list("c")});});
 await waitFor(()=>expect(screen.queryByRole("button",{name:"Private task"})).toBeNull());
});
it("keeps the selected workspace mounted but hidden through a transient conversation-list failure",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});const view=setup();
 const workspace=await screen.findByText("Workspace c mine");
 fireEvent.click(screen.getByRole("button",{name:"Commander options"}));
 h.list.mockRejectedValue(new ApiError("Unavailable",503,null));
 await act(async()=>{await view.client.invalidateQueries({queryKey:["commander-conversations"]});});
 await waitFor(()=>expect(workspace).not.toBeVisible());expect(workspace).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Mine"})).toBeNull();
 h.list.mockResolvedValue({conversations:[mine]});
 await act(async()=>{screen.getByRole("button",{name:"Retry conversations"}).click();});
 await waitFor(()=>expect(workspace).toBeVisible());
 expect(screen.getByText("Workspace c mine")).toBe(workspace);
});
it("uses the floating icon tray instead of engineering selector rows",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});setup();
 expect(await screen.findByRole("navigation",{name:"Universe"})).toBeInTheDocument();
 expect(screen.queryByLabelText("Conversation")).toBeNull();
 expect(screen.queryByLabelText("Open task")).toBeNull();
});
it("does not fall back to another conversation for an inaccessible deep link",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});setup("/ACM/universe?conversation=foreign");
 await screen.findByText("This conversation is unavailable. Choose another in Commander options.");
 expect(screen.queryByText("Workspace c mine")).toBeNull();
 expect(screen.queryByText("Canonical Commander composer")).toBeNull();
});
it("keeps the current conversation when a refreshed list gains a newer conversation",async()=>{
 h.list.mockResolvedValue({conversations:[mine]});const view=setup();await screen.findByText("Workspace c mine");
 h.list.mockResolvedValue({conversations:[{id:"newer",userId:"owner",title:"Newer"},mine]});
 await act(async()=>{await view.client.invalidateQueries({queryKey:["commander-conversations"]});});
 await waitFor(()=>expect(h.list).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect(screen.queryByText("Workspace c newer")).toBeNull());
 expect(screen.getByText("Workspace c mine")).toBeInTheDocument();
});
