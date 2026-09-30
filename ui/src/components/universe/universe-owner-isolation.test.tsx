import { it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUniverseState } from "./useUniverseState";
import { universeLayoutApi } from "../../api/universe-layout";
import { useUniverseDraft } from "./useUniverseDraft";
import { universeDraftApi } from "../../api/universe-draft";
import { queryKeys } from "../../lib/queryKeys";
vi.mock("../../api/auth", () => ({authApi: {getSession: async () => null}}));
vi.mock("../../api/universe-layout", () => ({universeLayoutApi: {get: vi.fn(), apply: vi.fn(), receipt: vi.fn()}}));
vi.mock("../../api/universe-draft", () => ({universeDraftApi: {get: vi.fn(), save: vi.fn()}}));
const draftApi = vi.mocked(universeDraftApi);
const api = vi.mocked(universeLayoutApi);
const session = (id: string) => ({user: {id}, session: {id: `login-${id}`, userId: id}});
const snapshot = (revision = 0) => ({schemaVersion: 1, revision, document: {panels: [], order: [], selected: null, maximized: null, viewport: {x: 0, y: 0, zoom: 1}, nextOpenedOrdinal: 1}});
function setup(owner: string | null) {
 const qc = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}});
 qc.setQueryData(queryKeys.auth.session, owner ? session(owner) : null);
 const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
 return {qc, ...renderHook(() => useUniverseState("company", "conversation", {debounceMs: 60000}), {wrapper})};
}
beforeEach(() => {vi.resetAllMocks(); api.get.mockResolvedValue(snapshot());});
it("does not read or enqueue layout without an authenticated owner", async () => {
 const h = setup(null);
 await act(async () => {});
 expect(api.get).not.toHaveBeenCalled();
 expect(() => h.result.current.queueOps([{type: "viewport", x: 1, y: 1, zoom: 1}])).toThrow();
 h.unmount();
});
it("account change cannot expose old snapshot or send old pending gestures", async () => {
 const h = setup("a");
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 act(() => {h.result.current.queueOps([{type: "viewport", x: 1, y: 1, zoom: 1}]);});
 api.get.mockImplementation(() => new Promise(() => {}));
 act(() => {h.qc.setQueryData(queryKeys.auth.session, session("b"));});
 await waitFor(() => expect(h.result.current.document).toBeUndefined());
 await act(async () => {await h.result.current.flush();});
 expect(api.apply).not.toHaveBeenCalled();
 h.unmount();
});
it("logout during preflight prevents the subsequent PATCH", async () => {
 const h = setup("a");
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 let finish!: (value: ReturnType<typeof snapshot>) => void;
 api.get.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
 let flight!: Promise<unknown>;
 act(() => {flight = h.result.current.queueOps([{type: "viewport", x: 1, y: 1, zoom: 1}], true)!;});
 act(() => {h.qc.setQueryData(queryKeys.auth.session, null);});
 await act(async () => {finish(snapshot()); await flight.catch(() => {});});
 expect(api.apply).not.toHaveBeenCalled();
 await waitFor(() => expect(h.result.current.document).toBeUndefined());
 h.unmount();
});

it("draft account switches discard old candidates and delayed acknowledgements", async () => {
 const qc = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}});
 qc.setQueryData(queryKeys.auth.session, session("a"));
 draftApi.get.mockResolvedValue({revision: 0, text: "", attachmentAssetIds: []});
 const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
 const h = renderHook(() => useUniverseDraft("company", "conversation", {kind: "task", id: "task"}, {debounceMs: 60000}), {wrapper});
 await waitFor(() => expect(h.result.current.isLoading).toBe(false));
 let finish!: (value: {revision: number; text: string; attachmentAssetIds: string[]}) => void;
 draftApi.save.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
 let flight!: Promise<unknown>;
 act(() => {flight = h.result.current.save("private a", [], true)!;});
 act(() => {qc.setQueryData(queryKeys.auth.session, session("b"));});
 await act(async () => {finish({revision: 1, text: "private a", attachmentAssetIds: []}); await flight.catch(() => {});});
 await waitFor(() => expect(h.result.current.submitSnapshot("new")?.text).toBe(""));
 expect(h.result.current.draft.text).toBe("");
 h.unmount();
});

it("logout after leaving the canvas still clears its tab recovery journal", async () => {
 sessionStorage.clear();
 const h = setup("a");
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 act(() => {h.result.current.queueOps([{type: "viewport", x: 3, y: 3, zoom: 1}]);});
 expect(sessionStorage.length).toBeGreaterThan(0);
 h.unmount();
 h.qc.setQueryData(queryKeys.auth.session, null);
 expect(sessionStorage.length).toBe(0);
});

it("an offline auth refresh blocks access but preserves pending recovery", async () => {
 sessionStorage.clear(); const h = setup("a");
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 act(() => {h.result.current.queueOps([{type: "viewport", x: 3, y: 3, zoom: 1}]);});
 const saved = sessionStorage.getItem(sessionStorage.key(0)!);
 act(() => {h.qc.getQueryCache().find({queryKey: queryKeys.auth.session})!.setState({status: "error", error: new Error("offline")});});
 await waitFor(() => expect(h.result.current.document).toBeUndefined());
 expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved);
 act(() => {h.qc.setQueryData(queryKeys.auth.session, session("a"));});
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 expect(JSON.parse(h.result.current.exportRecovery()).pending).toHaveLength(1);
 h.unmount();
});

it("switching drafts during auth failure preserves the same owner's local input", async () => {
 const qc = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}});
 qc.setQueryData(queryKeys.auth.session, session("a"));
 draftApi.get.mockResolvedValue({revision: 0, text: "", attachmentAssetIds: []});
 const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
 const h = renderHook(({id}) => useUniverseDraft("company", "conversation", {kind: "task", id}, {debounceMs: 60000}), {wrapper, initialProps: {id: "first"}});
 await waitFor(() => expect(h.result.current.isLoading).toBe(false));
 act(() => {h.result.current.save("keep offline", []);});
 act(() => {qc.getQueryCache().find({queryKey: queryKeys.auth.session})!.setState({status: "error", error: new Error("offline")});});
 h.rerender({id: "second"});
 act(() => {qc.setQueryData(queryKeys.auth.session, session("a"));});
 h.rerender({id: "first"});
 await waitFor(() => expect(h.result.current.submitSnapshot("s")?.text).toBe("keep offline"));
 h.unmount();
});
