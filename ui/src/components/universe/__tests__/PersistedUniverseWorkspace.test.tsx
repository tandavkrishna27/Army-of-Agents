import {createRef} from "react";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {beforeEach, afterEach, it, expect, vi} from "vitest";
import {emptyUniverseLayoutDocument, type LayoutPatch} from "@armyofagents/shared";
import {applyLayoutWithOpenings} from "../../../../../server/src/services/universe-layout-document";
import {PersistedUniverseWorkspace} from "../PersistedUniverseWorkspace";
import type {WorkspaceHandle} from "../UniverseWorkspace";
import {panelKey} from "../panel-state";
import {ApiError} from "../../../api/client";
import {universeLayoutApi} from "../../../api/universe-layout";
vi.mock("../../../api/auth", () => ({authApi: {getSession: async () => ({user: {id: "u"}, session: {id: "login", userId: "u"}})}}));
vi.mock("../../../api/universe-layout", () => ({universeLayoutApi: {get: vi.fn(), apply: vi.fn(), receipt: vi.fn()}}));
const scope = {companyId: "c", userId: "u", conversationId: "v"};
const ref = {companyId: "c", kind: "task" as const, id: "t"};
const key = panelKey(scope, ref);
const rect = {x: 10, y: 20, width: 400, height: 300};
const api = vi.mocked(universeLayoutApi);
let server = {schemaVersion: 1, revision: 0, document: emptyUniverseLayoutDocument()};
beforeEach(() => {
 vi.resetAllMocks(); sessionStorage.clear();
 vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
 vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
 vi.stubGlobal("ResizeObserver", class {constructor(private cb: ResizeObserverCallback) {} observe(target: Element) {this.cb([{target, contentRect: {width: 1200, height: 900}} as ResizeObserverEntry], this as unknown as ResizeObserver);} unobserve() {} disconnect() {}});
 vi.stubGlobal("DOMMatrixReadOnly", class {m22 = 1;});
 server = {schemaVersion: 1, revision: 1, document: applyLayoutWithOpenings(emptyUniverseLayoutDocument(), [{type: "open", key, ref: {kind: "task", id: "t"}, title: "Task", rect}], scope).document};
 api.get.mockImplementation(async () => structuredClone(server));
 api.apply.mockImplementation(async (_c, _v, patch: LayoutPatch) => {
   const applied = applyLayoutWithOpenings(server.document, patch.operations, scope);
   server = {...server, revision: server.revision + 1, document: applied.document};
   return {operationId: patch.operationId, revision: server.revision, schemaVersion: 1, nextOpenedOrdinal: server.document.nextOpenedOrdinal, opened: applied.opened};
 });
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
function setup() {
 const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
 const handle = createRef<WorkspaceHandle>();
 const view = render(<QueryClientProvider client={client}><PersistedUniverseWorkspace ref={handle} companyId="c" conversationId="v" content={{[key]: {ref, title: "Task", render: () => <><p>Task content</p><textarea aria-label="Unsaved panel draft" defaultValue=""/></>}}}/></QueryClientProvider>);
 return {...view, client, handle};
}
it("hydrates without saving and persists real frame controls through the queue", async () => {
 const {handle} = setup();
 await screen.findByText("Task content");
 expect(api.apply).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", {name: "Pin panel"}));
 await waitFor(() => expect(server.document.panels[0]!.pinned).toBe(true));
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("Saved"));
 expect(handle.current!.getState().panels[key].pinned).toBe(true);
 fireEvent.click(screen.getByRole("button", {name: "Maximize panel"}));
 await waitFor(() => expect(server.document.maximized).toBe(key));
 expect(server.document.panels[0]!.rect).toEqual(rect);
});
it("reconciles authoritative open ordinals without issuing a hydration write", async () => {
 server.document.nextOpenedOrdinal = 10;
 const {handle} = setup(); await screen.findByText("Task content");
 const second = {companyId: "c", kind: "task" as const, id: "second"};
 act(() => handle.current!.open({ref: second, title: "Second"}));
 await waitFor(() => expect(server.document.panels).toHaveLength(2));
 await waitFor(() => expect(handle.current!.getState().panels[panelKey(scope, second)].openedOrdinal).toBe(10));
 expect(api.apply).toHaveBeenCalledTimes(1);
});

it("keeps a live drag stable when a background fetch reports a competing move", async () => {
 const {handle, client} = setup(); await screen.findByText("Task content");
 const mouse = (target: EventTarget, type: string, x: number) => {
   const event = new MouseEvent(type, {bubbles: true, clientX: x, clientY: 200, buttons: 1});
   Object.defineProperty(event, "view", {value: window}); fireEvent(target, event);
 };
 const header = screen.getByLabelText("Task panel controls");
 mouse(header, "mousedown", 200); mouse(window, "mousemove", 250);
 const localGeneration = handle.current!.getState().panels[key].generation;
 server = {...server, revision: 2, document: {...server.document, panels: server.document.panels.map(p => ({...p, rect: {...p.rect, x: 999}}))}};
 try {
   await act(async () => {await client.invalidateQueries({queryKey: ["universe-layout"]}); await new Promise(resolve => setTimeout(resolve, 20));});
   expect(handle.current!.getState().panels[key].generation).toBe(localGeneration);
   expect(handle.current!.getState().panels[key].rect.x).not.toBe(999);
 } finally {
   mouse(window, "mouseup", 250);
   await act(async () => {await new Promise(resolve => setTimeout(resolve, 0));});
 }
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("conflict"));
 expect(api.apply).not.toHaveBeenCalled();
});

it.each(["Use saved layout", "Apply my layout edits"])("keeps both conflict variants until the user chooses %s", async choice => {
 setup(); await screen.findByText("Task content");
 server = {...server, revision: 2, document: {...server.document, panels: server.document.panels.map(p => ({...p, pinned: true}))}};
 fireEvent.click(screen.getByRole("button", {name: "Pin panel"}));
 await screen.findByText("Compare layout changes");
 expect(api.apply).not.toHaveBeenCalled();
 expect(screen.getByText("Your edits")).toBeInTheDocument();
 expect(screen.getByText("Saved layout")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", {name: choice}));
 await waitFor(() => expect(screen.queryByText("Compare layout changes")).not.toBeInTheDocument());
 expect(api.apply).toHaveBeenCalledTimes(choice === "Use saved layout" ? 0 : 1);
});

it("automatically reconciles a tab recovery after reload without changing the request identity", async () => {
 const first = setup(); await screen.findByText("Task content");
 api.apply.mockRejectedValueOnce(new Error("lost response"));
 act(() => first.handle.current!.setViewport({x: 50, y: 80, zoom: 0.75}));
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("Offline"));
 const original = api.apply.mock.calls[0]![2]; first.unmount();
 api.receipt.mockRejectedValue(new ApiError("missing", 404, null));
 const second = setup();
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("Saved"));
 expect(api.apply).toHaveBeenCalledTimes(2);
 expect(api.apply.mock.calls[1]![2]).toEqual(original);
 expect(second.handle.current!.getViewport()).toEqual({x: 50, y: 80, zoom: 0.75});
});
it("requires an export and explicit discard choice for unreadable recovery", async () => {
 const journal = "aoa:universe:layout:v1:" + JSON.stringify([JSON.stringify(["u", "login"]), "c", "v"]);
 sessionStorage.setItem(journal, "broken");
 vi.stubGlobal("URL", class extends URL {static createObjectURL() {return "blob:recovery";} static revokeObjectURL() {}});
 vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
 setup(); await screen.findByText("Task content");
 const discard = screen.getByRole("button", {name: "Discard invalid recovery"});
 expect(discard).toBeDisabled();
 fireEvent.click(screen.getByRole("button", {name: "Export layout recovery"}));
 fireEvent.click(screen.getByRole("checkbox", {name: "Discard this unreadable local recovery record"}));
 await waitFor(() => expect(discard).toBeEnabled());
 fireEvent.click(discard);
 await waitFor(() => expect(sessionStorage.getItem(journal)).toBeNull());
 expect(server.revision).toBe(1);
 expect(api.apply).not.toHaveBeenCalled();
});

it("preserves panel content and Undo after an acknowledged gesture", async () => {
 const {handle, client} = setup(); await screen.findByText("Task content");
 fireEvent.change(screen.getByRole("textbox", {name: "Unsaved panel draft"}), {target: {value: "Keep this draft"}});
 const before = handle.current!.getState().panels[key].rect;
 const generation = handle.current!.getState().panels[key].generation;
 const mouse = (target: EventTarget, type: string, x: number) => {
   const event = new MouseEvent(type, {bubbles: true, clientX: x, clientY: 200, buttons: 1});
   Object.defineProperty(event, "view", {value: window}); fireEvent(target, event);
 };
 mouse(screen.getByLabelText("Task panel controls"), "mousedown", 200);
 mouse(window, "mousemove", 250); mouse(window, "mouseup", 250);
 await act(async () => {await new Promise(resolve => setTimeout(resolve, 0));});
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("Saved"));
 await act(async () => {await client.invalidateQueries({queryKey: ["universe-layout"]}); await new Promise(resolve => setTimeout(resolve, 20));});
 expect(server.document.panels[0].placement).toBe("manual");
 expect(handle.current!.getState().panels[key].placement).toBe("manual");
 expect(handle.current!.getState().panels[key].generation).toBe(generation);
 expect(screen.getByRole("textbox", {name: "Unsaved panel draft"})).toHaveValue("Keep this draft");
 act(() => handle.current!.undo());
 await waitFor(() => expect(server.document.panels[0]!.rect).toEqual(before));
});

it("rejects an over-budget arrangement before changing any panel", async () => {
 for (let i = 0; i < 50; i++) {
   const extraRef = {companyId: "c", kind: "task" as const, id: "extra-" + i};
   server.document = applyLayoutWithOpenings(server.document, [{type: "open", key: panelKey(scope, extraRef), ref: {kind: "task", id: extraRef.id}, title: extraRef.id, rect: {...rect, x: 1000 + i}}], scope).document;
 }
 const {handle} = setup(); await screen.findByText("Task content");
 const before = handle.current!.getState();
 act(() => handle.current!.arrange());
 expect(handle.current!.getState()).toEqual(before);
 expect(screen.getByRole("alert")).toHaveTextContent(/operation or byte budget/);
 expect(api.apply).not.toHaveBeenCalled();
});

it("blocks further panel and camera edits after recovery storage fails", async () => {
 const {handle} = setup(); await screen.findByText("Task content");
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("Storage quota reached");});
 fireEvent.click(screen.getByRole("button", {name: "Pin panel"}));
 await waitFor(() => expect(screen.getByRole("status", {name: "Layout save status"})).toHaveTextContent("needs attention"));
 const state = handle.current!.getState(); const camera = handle.current!.getViewport();
 fireEvent.click(screen.getByRole("button", {name: "Maximize panel"}));
 act(() => handle.current!.setViewport({x: 150, y: 90, zoom: .5}));
 expect(handle.current!.getState()).toEqual(state);
 expect(handle.current!.getViewport()).toEqual(camera);
 expect(api.apply).not.toHaveBeenCalled();
 expect(screen.getByRole("button", {name: "Export layout recovery"})).toBeEnabled();
});

it("blocks reentrant commands before React has rendered a storage failure", async () => {
 const {handle} = setup(); await screen.findByText("Task content");
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
 act(() => {
  const generation = handle.current!.getState().panels[key].generation;
  handle.current!.dispatch({type: "pin", key, generation, value: true});
  handle.current!.dispatch({type: "maximize", key, generation});
 });
 expect(handle.current!.getState().panels[key].pinned).toBe(true);
 expect(handle.current!.getState().maximized).toBeNull();
 expect(api.apply).not.toHaveBeenCalled();
});
