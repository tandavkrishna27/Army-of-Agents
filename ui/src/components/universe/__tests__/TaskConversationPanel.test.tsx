import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, expect, it, vi} from "vitest";
import {queryKeys} from "../../../lib/queryKeys";
import {TaskConversationPanel} from "../TaskConversationPanel";
import {ApiError} from "../../../api/client";
const h = vi.hoisted(() => ({company: "c", identity: "u:session", verified: true, get: vi.fn()}));
vi.mock("../../../context/CompanyContext", () => ({useCompany: () => ({selectedCompanyId:h.company})}));
vi.mock("../useUniverseOwner", () => ({useUniverseOwner: () => ({identity:h.identity, isVerified:h.verified, isCurrent: () => h.verified && !!h.identity})}));
vi.mock("../../../api/issues", () => ({issuesApi:{get:h.get}}));
vi.mock("../../task-detail/TaskConversationContent", () => ({TaskConversationContent: ({issueId}:{issueId:string}) => <div>Private task {issueId}<input aria-label="Pending attachment" type="file"/></div>}));
const props={companyId:"c",issueId:"task",panelKey:"key",generation:1,active:true};
function setup() {
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const wrapper=({children}:{children:React.ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
 return {...render(<TaskConversationPanel {...props}/>,{wrapper}),client};
}
beforeEach(() => {h.company="c";h.identity="u:session";h.verified=true;h.get.mockReset();});
it("retains authorized content while the host deactivates the panel", async () => {
 h.get.mockResolvedValue({id:"task",companyId:"c"}); const view=setup();
 const content=await screen.findByText("Private task task");
 view.rerender(<TaskConversationPanel {...props} active={false}/>);
 expect(content).toBeInTheDocument();
 view.rerender(<TaskConversationPanel {...props}/>);
 expect(screen.getByText("Private task task")).toBe(content);
});
it("mounts content only after task authorization and adds no nested lifecycle controls",async()=>{
 let resolve!:(value:unknown)=>void;h.get.mockImplementation(()=>new Promise(r=>{resolve=r}));setup();
 expect(screen.queryByText("Private task task")).toBeNull();
 await act(async()=>resolve({id:"task",companyId:"c"}));
 expect(await screen.findByText("Private task task")).toBeInTheDocument();
 expect(screen.queryAllByRole("button")).toHaveLength(0);
});
it("rejects foreign-company content even if the endpoint returns it",async()=>{
 h.get.mockResolvedValue({id:"task",companyId:"other"});setup();
 expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
 expect(screen.queryByText("Private task task")).toBeNull();
});
it("does not query or mount under an unverified owner or different selected company",async()=>{
 h.verified=false;const view=setup();expect(h.get).not.toHaveBeenCalled();
 h.verified=true;h.company="other";view.rerender(<TaskConversationPanel {...props}/>);
 expect(h.get).not.toHaveBeenCalled();expect(screen.queryByText("Private task task")).toBeNull();
});
it("a late old-company response cannot mount after scope changes",async()=>{
 let resolve!:(value:unknown)=>void;h.get.mockImplementation(()=>new Promise(r=>{resolve=r}));const view=setup();
 h.company="other";view.rerender(<TaskConversationPanel {...props}/>);
 await act(async()=>resolve({id:"task",companyId:"c"}));
 expect(screen.queryByText("Private task task")).toBeNull();
});
it("hides previously mounted content when access is revoked",async()=>{
 h.get.mockResolvedValue({id:"task",companyId:"c"});const view=setup();await screen.findByText("Private task task");
 h.get.mockRejectedValue(new Error("Forbidden"));
 await act(async()=>{await view.client.invalidateQueries({queryKey:queryKeys.issues.detail("task")});});
 await waitFor(()=>expect(screen.queryByText("Private task task")).toBeNull());
 expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
});
it.each([new TypeError("Failed to fetch"), new ApiError("Unavailable", 503, null)])("retains prior authorized composer state through transient refetch and retry: %s",async(error)=>{
 h.get.mockResolvedValue({id:"task",companyId:"c"});const view=setup();
 const content=await screen.findByText("Private task task");
 const attachment=screen.getByLabelText("Pending attachment") as HTMLInputElement;
 const file=new File(["unsent"],"pending.txt",{type:"text/plain"});
 Object.defineProperty(attachment,"files",{value:[file],configurable:true});
 h.get.mockRejectedValue(error);
 await act(async()=>{await view.client.invalidateQueries({queryKey:queryKeys.issues.detail("task")});});
 await waitFor(()=>expect(content).not.toBeVisible());expect(content).toBeInTheDocument();
 h.get.mockResolvedValue({id:"task",companyId:"c"});
 await act(async()=>{screen.getByRole("button",{name:"Retry task"}).click();});
 await waitFor(()=>expect(content).toBeVisible());
 expect(screen.getByLabelText("Pending attachment")).toBe(attachment);
 expect(attachment.files?.[0]).toBe(file);
});
