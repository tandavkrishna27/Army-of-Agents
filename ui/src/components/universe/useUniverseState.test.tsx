vi.mock("../../api/auth", () => ({ authApi: { getSession: async () => ({user: {id: "owner"}, session: {id: "login", userId: "owner"}}) } }));
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUniverseState } from "./useUniverseState";
import { universeLayoutApi } from "../../api/universe-layout";
import { ApiError } from "../../api/client";

vi.mock("../../api/universe-layout", () => ({
  universeLayoutApi: { get: vi.fn(), apply: vi.fn(), receipt: vi.fn() },
}));
const mockApi = vi.mocked(universeLayoutApi);
beforeEach(() => sessionStorage.clear());

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const snapshot = (revision: number) => ({
  schemaVersion: 1,
  revision,
  document: {
    panels: [],
    order: [],
    selected: null,
    maximized: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    nextOpenedOrdinal: 1,
  },
});
const op = { type: "viewport" as const, x: 1, y: 2, zoom: 1 };

async function ready(revision = 0) {
  mockApi.get.mockResolvedValue(snapshot(revision));
  const hook = renderHook(() => useUniverseState("c1", "conv1"), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe("useUniverseState", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.receipt.mockRejectedValue(new ApiError("missing", 404, null));
  });

  it("loads the snapshot and exposes document + revision", async () => {
    const { result } = await ready(3);
    expect(result.current.revision).toBe(3);
    expect(result.current.document?.panels).toEqual([]);
  });

  it("flush sends a patch with the current expectedRevision and reports saved", async () => {
    mockApi.apply.mockResolvedValue({ operationId: "x", revision: 3, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    const { result } = await ready(2);
    await act(async () => {
      await result.current.queueOps([op], true);
    });
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    const patch = mockApi.apply.mock.calls[0]![2];
    expect(patch.expectedRevision).toBe(2);
    expect(patch.operations).toEqual([op]);
    expect(result.current.status).toBe("saved");
  });

  it("batches multiple queued ops into one patch on flush", async () => {
    mockApi.apply.mockResolvedValue({ operationId: "z", revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    const { result } = await ready();
    const op2 = { type: "viewport" as const, x: 9, y: 9, zoom: 2 };
    await act(async () => {
      result.current.queueOps([op]);
      result.current.queueOps([op2]);
      await result.current.flush();
    });
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    expect(mockApi.apply.mock.calls[0]![2].operations).toEqual([op, op2]);
  });

  it("a 409 sets conflict status and re-fetches the acknowledged base", async () => {
    mockApi.apply.mockRejectedValue(new ApiError("stale", 409, null));
    const { result } = await ready();
    mockApi.get.mockClear();
    await act(async () => {
      result.current.queueOps([op]);
      await result.current.flush().catch(() => {});
    });
    expect(result.current.status).toBe("conflict");
    expect(mockApi.get).toHaveBeenCalled();
  });

  it("a network error sets offline and keeps the ops for a retry", async () => {
    mockApi.apply.mockRejectedValueOnce(new Error("network"));
    const { result } = await ready();
    await act(async () => {
      result.current.queueOps([op]);
      await result.current.flush().catch(() => {});
    });
    expect(result.current.status).toBe("offline");
    mockApi.apply.mockResolvedValueOnce({ operationId: "y", revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    await act(async () => {
      await result.current.flush();
    });
    expect(mockApi.apply).toHaveBeenCalledTimes(2);
    expect(mockApi.apply.mock.calls[1]![2].operations).toEqual([op]);
    expect(result.current.status).toBe("saved");
  });
  it("checks the receipt and reuses the exact operation identity after an unknown response", async () => {
    const { result } = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("connection lost"));
    await act(async () => { await result.current.queueOps([op], true)?.catch(() => {}); });
    const original = mockApi.apply.mock.calls[0]![2];
    mockApi.apply.mockResolvedValueOnce({ operationId: original.operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    await act(async () => { await result.current.flush(); });
    expect(mockApi.receipt).toHaveBeenCalledWith("c1", "conv1", original.operationId, expect.any(AbortSignal));
    expect(mockApi.apply.mock.calls[1]![2]).toEqual(original);
  });

  it("reads fresh state and checks the old receipt again before rebasing an uncertain request", async () => {
    const {result} = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => {await result.current.queueOps([op], true)?.catch(() => {});});
    const original = mockApi.apply.mock.calls[0]![2];
    const sequence: string[] = [];
    mockApi.receipt.mockImplementation(async () => {sequence.push("receipt"); throw new ApiError("missing", 404, null);});
    mockApi.get.mockImplementation(async () => {sequence.push("snapshot"); return snapshot(1);});
    mockApi.apply.mockImplementation(async (_c, _v, patch) => {sequence.push("apply"); return {operationId: patch.operationId, revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []};});
    await act(async () => {await result.current.flush();});
    const replacement = mockApi.apply.mock.calls[1]![2];
    expect(sequence.slice(0,4)).toEqual(["receipt", "snapshot", "receipt", "apply"]);
    expect(replacement.operationId).not.toBe(original.operationId);
    expect(replacement.expectedRevision).toBe(1);
    expect(replacement.operations).toEqual(original.operations);
  });

  it("consumes a receipt that appeared during snapshot loading without replay", async () => {
    const {result} = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => {await result.current.queueOps([op], true)?.catch(() => {});});
    const original = mockApi.apply.mock.calls[0]![2];
    mockApi.get.mockResolvedValue(snapshot(2));
    mockApi.receipt.mockRejectedValueOnce(new ApiError("missing", 404, null)).mockResolvedValueOnce({operationId: original.operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
    await act(async () => {await result.current.flush();});
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saved");
  });

  it("does not replay an uncertain operation when the fresh snapshot is unavailable", async () => {
    const {result} = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => {await result.current.queueOps([op], true)?.catch(() => {});});
    mockApi.get.mockRejectedValue(new Error("offline"));
    await act(async () => {await result.current.flush().catch(() => {});});
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("offline");
  });

  it("a durable receipt resolves a lost response without executing the operation again", async () => {
    const { result } = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("response lost"));
    await act(async () => { await result.current.queueOps([op], true)?.catch(() => {}); });
    const original = mockApi.apply.mock.calls[0]![2];
    mockApi.receipt.mockResolvedValueOnce({ operationId: original.operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    await act(async () => { await result.current.flush(); });
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saved");
  });

  it("drains newer edits after resolving an uncertain save", async () => {
    const { result } = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => { await result.current.queueOps([op], true)?.catch(() => {}); });
    const original = mockApi.apply.mock.calls[0]![2];
    mockApi.receipt.mockResolvedValueOnce({ operationId: original.operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    mockApi.get.mockResolvedValue(snapshot(1));
    mockApi.apply.mockResolvedValueOnce({ operationId: "second", revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    const newer = { ...op, x: 99 };
    await act(async () => { await result.current.queueOps([newer], true); });
    expect(mockApi.apply).toHaveBeenCalledTimes(2);
    expect(mockApi.apply.mock.calls[1]![2]).toMatchObject({ expectedRevision: 1, operations: [newer] });
  });

  it("quarantines a definitive conflict and accepts explicitly resolved operations", async () => {
    const { result } = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => { await result.current.queueOps([op], true)?.catch(() => {}); });
    const original = mockApi.apply.mock.calls[0]![2];
    mockApi.apply.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    // The revision advances between the fresh read and the write, producing a
    // definitive CAS conflict rather than the preflight rebase path.
    mockApi.get.mockResolvedValue(snapshot(0));
    await act(async () => { await result.current.flush().catch(() => {}); });
    mockApi.get.mockResolvedValue(snapshot(2));
    expect(result.current.conflictingPatch).toEqual(original);
    await act(async () => { await result.current.flush(); });
    expect(mockApi.apply).toHaveBeenCalledTimes(2);
    mockApi.apply.mockResolvedValueOnce({ operationId: "resolved", revision: 3, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    await act(async () => { await result.current.resolveConflict([{ ...op, x: 77 }]); });
    expect(mockApi.apply.mock.calls[2]![2]).toMatchObject({ expectedRevision: 2, operations: [{ ...op, x: 77 }] });
    expect(mockApi.apply.mock.calls[2]![2].operationId).not.toBe(original.operationId);
  });

  it("serializes a second flush behind the in-flight save", async () => {
    const { result } = await ready();
    let finish!: (value: import("@armyofagents/shared").LayoutAck) => void;
    mockApi.apply.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let first!: Promise<unknown>;
    act(() => { first = result.current.queueOps([op], true)!; });
    await waitFor(() => expect(mockApi.apply).toHaveBeenCalledTimes(1));
    let second!: Promise<unknown>;
    act(() => { second = result.current.queueOps([{ ...op, x: 77 }], true)!; });
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    mockApi.get.mockResolvedValue(snapshot(1));
    mockApi.apply.mockResolvedValueOnce({ operationId: "next", revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: [] });
    await act(async () => { finish({operationId: "first", revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []}); await first; await second; });
    expect(mockApi.apply.mock.calls[1]![2]).toMatchObject({expectedRevision: 1, operations: [{ ...op, x: 77 }]});
  });

  it("does not resend when receipt lookup fails", async () => {
    const { result } = await ready();
    mockApi.apply.mockRejectedValueOnce(new Error("lost"));
    await act(async () => { await result.current.queueOps([op], true)?.catch(() => {}); });
    mockApi.receipt.mockRejectedValueOnce(new Error("lookup offline"));
    await act(async () => { await result.current.flush().catch(() => {}); });
    expect(mockApi.apply).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("offline");
  });

  it("a conversation switch cannot retarget pending operations", async () => {
    mockApi.get.mockResolvedValue(snapshot(0));
    const { result, rerender, unmount } = renderHook(({conv}) => useUniverseState("c1", conv, {debounceMs: 10000}), {initialProps: {conv: "old"}, wrapper: makeWrapper()});
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => { result.current.queueOps([op]); });
    rerender({conv: "new"});
    await act(async () => { await result.current.flush(); });
    expect(mockApi.apply).not.toHaveBeenCalled();
    rerender({conv: "old"});
    mockApi.apply.mockResolvedValue({operationId: "old-save", revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
    await act(async () => { await result.current.flush(); });
    expect(mockApi.apply).toHaveBeenCalledWith("c1", "old", expect.objectContaining({operations: [op]}), expect.any(AbortSignal));
    unmount();
  });

  it("does not silently rebase a queued gesture over another client's save", async () => {
    const { result } = await ready();
    act(() => { result.current.queueOps([op]); });
    const remote = snapshot(1); remote.document.viewport.x = 999;
    mockApi.get.mockResolvedValue(remote);
    await act(async () => { await result.current.flush().catch(() => {}); });
    expect(mockApi.apply).not.toHaveBeenCalled();
    expect(result.current.status).toBe("conflict");
    expect(result.current.conflictingPatch?.expectedRevision).toBe(0);
  });

  it("rebases an unsent viewport edit when remote changed only an independent property", async () => {
    const { result } = await ready();
    act(() => { result.current.queueOps([op]); });
    mockApi.get.mockResolvedValue(snapshot(1));
    mockApi.apply.mockResolvedValue({operationId: "rebased", revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
    await act(async () => { await result.current.flush(); });
    expect(mockApi.apply).toHaveBeenCalledWith("c1", "conv1", expect.objectContaining({expectedRevision: 1, operations: [op]}), expect.any(AbortSignal));
    expect(result.current.status).toBe("saved");
  });

  it("keeps atomic caller groups together at the 50-operation boundary", async () => {
    const { result } = await ready();
    mockApi.apply.mockImplementation(async (_company, _conversation, patch) => {
      mockApi.get.mockResolvedValue(snapshot(patch.expectedRevision + 1));
      return {operationId: patch.operationId, revision: patch.expectedRevision + 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []};
    });
    const pair = [{type: "order" as const, keys: []}, {type: "presentation" as const, selected: null, maximized: null}];
    await act(async () => {
      result.current.queueOps(Array.from({length: 49}, () => op));
      result.current.queueOps(pair);
      await result.current.flush();
    });
    expect(mockApi.apply.mock.calls.map((call) => call[2].operations.length)).toEqual([49, 2]);
    expect(mockApi.apply.mock.calls[1]![2].operations).toEqual(pair);
  });

  it("resolving while a conflict refresh is pending cannot revive the rejected attempt", async () => {
    const { result } = await ready();
    let finishRead!: (value: ReturnType<typeof snapshot>) => void;
    mockApi.get.mockResolvedValueOnce(snapshot(0)).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; })).mockResolvedValue(snapshot(2));
    mockApi.apply.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    let initial!: Promise<unknown>;
    act(() => { initial = result.current.queueOps([op], true)!.catch(() => {}); });
    await waitFor(() => expect(result.current.status).toBe("conflict"));
    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    let resolving!: Promise<unknown>;
    act(() => { resolving = result.current.resolveConflict([{ ...op, x: 77 }]).catch(() => {}); });
    mockApi.apply.mockResolvedValueOnce({operationId: "resolved", revision: 3, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
    await act(async () => { finishRead(snapshot(2)); await initial; await resolving; });
    expect(mockApi.apply).toHaveBeenCalledTimes(2);
    expect(mockApi.receipt).not.toHaveBeenCalled();
    expect(mockApi.apply.mock.calls[1]![2].operations).toEqual([{ ...op, x: 77 }]);
  });

  it("resolving one conflict does not silently rebase other older queued gestures", async () => {
    const { result } = await ready();
    let reject!: (reason: Error) => void;
    mockApi.apply.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let first!: Promise<unknown>;
    act(() => { first = result.current.queueOps([op], true)!.catch(() => {}); });
    await waitFor(() => expect(mockApi.apply).toHaveBeenCalledTimes(1));
    act(() => { result.current.queueOps([{ ...op, x: 88 }]); });
    mockApi.get.mockResolvedValue(snapshot(1));
    await act(async () => { reject(new ApiError("remote edit", 409, null)); await first; });
    mockApi.apply.mockImplementationOnce(async (_c, _v, patch) => {
      mockApi.get.mockResolvedValue(snapshot(2));
      return {operationId: patch.operationId, revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []};
    });
    await act(async () => { await result.current.resolveConflict([{ ...op, x: 77 }]).catch(() => {}); });
    expect(mockApi.apply).toHaveBeenCalledTimes(2);
    expect(result.current.conflictingPatch?.operations).toEqual([{ ...op, x: 88 }]);
    expect(result.current.status).toBe("conflict");
  });

});

it("quarantines an incomplete legacy receipt instead of replaying or reporting offline", async () => {
  vi.resetAllMocks();
  const hook = await ready();
  mockApi.apply.mockRejectedValueOnce(new Error("lost reply"));
  await act(async () => { await hook.result.current.queueOps([op], true)?.catch(() => undefined); });
  mockApi.receipt.mockRejectedValueOnce(new ApiError("Legacy receipt requires snapshot reconciliation", 409, null));
  await act(async () => { await hook.result.current.flush().catch(() => undefined); });
  expect(hook.result.current.status).toBe("conflict");
  expect(hook.result.current.conflictingPatch).not.toBeNull();
  expect(mockApi.apply).toHaveBeenCalledTimes(1);
});

it("keeps individually valid atomic groups below the UTF-8 patch cap when batching", async () => {
  vi.resetAllMocks();
  const hook = await ready(); let revision = 0;
  mockApi.get.mockImplementation(async () => snapshot(revision));
  mockApi.apply.mockImplementation(async (_c, _v, patch) => {
    const { layoutPatchSchema } = await import("@armyofagents/shared");
    layoutPatchSchema.parse(patch); revision++;
    return {operationId: patch.operationId, revision, schemaVersion: 1, opened: [], nextOpenedOrdinal: 1};
  });
  const group = (offset: number) => Array.from({length:15}, (_, i) => ({type: "open" as const, key: `${offset+i}`,
    ref:{kind:"task" as const,id:`${offset+i}`}, title:"界".repeat(1024),rect:{x:0,y:0,width:300,height:200}}));
  await act(async () => {
    hook.result.current.queueOps(group(0));
    await hook.result.current.queueOps(group(15), true);
  });
  expect(mockApi.apply).toHaveBeenCalledTimes(2);
  expect(hook.result.current.status).toBe("saved");
});


it("reload recovers the exact uncertain operation and reconciles its receipt", async () => {
  sessionStorage.clear(); vi.resetAllMocks();
  const first = await ready();
  mockApi.apply.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await act(async () => {await first.result.current.queueOps([op], true)?.catch(() => {});});
  const operationId = mockApi.apply.mock.calls[0]![2].operationId;
  first.unmount();
  mockApi.get.mockResolvedValue(snapshot(1));
  mockApi.receipt.mockResolvedValue({operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
  const next = renderHook(() => useUniverseState("c1", "conv1"), {wrapper: makeWrapper()});
  await waitFor(() => expect(next.result.current.document).toBeDefined());
  await act(async () => {await next.result.current.flush();});
  expect(mockApi.receipt).toHaveBeenCalledWith("c1", "conv1", operationId, expect.any(AbortSignal));
  expect(mockApi.apply).toHaveBeenCalledTimes(1);
  expect(next.result.current.status).toBe("saved");
  next.unmount();
});
it("rejects queue overflow while retaining exportable recovery data", async () => {
 sessionStorage.clear(); vi.resetAllMocks();
 const h = await ready();
 act(() => {for (let i = 0; i < 100; i++) h.result.current.queueOps([{...op, x: i}]);});
 expect(() => act(() => {h.result.current.queueOps([{...op, x: 999}]);})).toThrow();
 expect(JSON.parse(h.result.current.exportRecovery()).pending).toHaveLength(100);
 expect(h.result.current.status).not.toBe("saved");
 h.unmount();
});

it("can drain a full queue and then recover the rejected edit", async () => {
 sessionStorage.clear(); vi.resetAllMocks();
 const h = await ready();
 act(() => {for (let i = 0; i < 100; i++) h.result.current.queueOps([{...op, x: i}]);});
 act(() => {try {h.result.current.queueOps([{...op, x: 999}]);} catch {}});
 mockApi.apply.mockImplementation(async (_c, _v, patch) => {
   const revision = patch.expectedRevision + 1; mockApi.get.mockResolvedValue(snapshot(revision));
   return {operationId: patch.operationId, revision, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []};
 });
 await act(async () => {await h.result.current.retryRecovery();});
 expect(mockApi.apply.mock.calls.at(-1)![2].operations).toEqual([{...op, x: 999}]);
 expect(h.result.current.status).toBe("saved");
 h.unmount();
});

it("blocked browser storage never sends an unjournaled edit", async () => {
 sessionStorage.clear(); vi.resetAllMocks();
 const h = await ready();
 const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
 try {
  act(() => {try {h.result.current.queueOps([op], true);} catch {}});
  expect(mockApi.apply).not.toHaveBeenCalled();
  expect(h.result.current.status).toBe("blocked");
  expect(JSON.parse(h.result.current.exportRecovery()).rejectedEdit).toEqual([op]);
 } finally {write.mockRestore(); h.unmount();}
});

it("a stale retry callback cannot discard the rejected edit in another conversation", async () => {
 sessionStorage.clear(); vi.resetAllMocks(); mockApi.get.mockResolvedValue(snapshot(0));
 const h = renderHook(({conv}) => useUniverseState("c1", conv, {debounceMs: 60000}), {initialProps: {conv: "first"}, wrapper: makeWrapper()});
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 act(() => {for (let i = 0; i < 100; i++) h.result.current.queueOps([op]); try {h.result.current.queueOps([{...op, x: 999}]);} catch {}});
 const retry = h.result.current.retryRecovery;
 h.rerender({conv: "second"});
 await act(async () => {await retry().catch(() => {});});
 h.rerender({conv: "first"});
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 expect(JSON.parse(h.result.current.exportRecovery()).rejectedEdit).toEqual([{...op, x: 999}]);
 h.unmount();
});

it("hydrates recovery after mounting during a temporary auth failure", async () => {
 sessionStorage.clear(); vi.resetAllMocks();
 const first = await ready();
 act(() => {first.result.current.queueOps([op]);}); first.unmount();
 const qc = new QueryClient({defaultOptions: {queries: {retry: false}}});
 qc.setQueryData(["auth", "session"], {user: {id: "owner"}, session: {id: "login", userId: "owner"}});
 qc.getQueryCache().find({queryKey: ["auth", "session"]})!.setState({status: "error", error: new Error("offline")});
 const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
 const h = renderHook(() => useUniverseState("c1", "conv1"), {wrapper});
 await waitFor(() => expect(h.result.current.document).toBeDefined());
 expect(JSON.parse(h.result.current.exportRecovery()).pending).toHaveLength(1);
 h.unmount();
});

it("does not promote unexamined later batches after adopting a remote revision", async () => {
 vi.resetAllMocks();
 const panel = {key: "p", ref: {companyId: "c1", kind: "task" as const, id: "t"}, title: "T", rect: {x: 0, y: 0, width: 100, height: 100}, openedOrdinal: 1, pinned: false, minimized: false};
 const initial = {...snapshot(0), document: {...snapshot(0).document, panels: [panel], order: ["p"], nextOpenedOrdinal: 2}};
 mockApi.get.mockResolvedValue(initial);
 const {result} = renderHook(() => useUniverseState("c1", "conv1", {debounceMs: 10000}), {wrapper: makeWrapper()});
 await waitFor(() => expect(result.current.isLoading).toBe(false));
 act(() => {
   result.current.queueOps(Array.from({length: 49}, () => op));
   result.current.queueOps([{type: "pin", key: "p", value: false}, {type: "pin", key: "p", value: false}]);
 });
 const remote = {...initial, revision: 1, document: {...initial.document, panels: [{...panel, pinned: true}]}};
 mockApi.get.mockResolvedValue(remote);
 mockApi.apply.mockImplementation(async (_c, _v, patch) => {
   mockApi.get.mockResolvedValue({...remote, revision: 2});
   return {operationId: patch.operationId, revision: 2, schemaVersion: 1, nextOpenedOrdinal: 2, opened: []};
 });
 await act(async () => {await result.current.flush().catch(() => {});});
 expect(mockApi.apply).toHaveBeenCalledTimes(1);
 expect(result.current.status).toBe("conflict");
});

it("keeps controller opening identity attached to its own acknowledged batch", async () => {
 vi.resetAllMocks(); mockApi.get.mockResolvedValue(snapshot(0));
 const acknowledged = vi.fn();
 const {result} = renderHook(() => useUniverseState("c1", "conv1", {debounceMs: 10000, onAcknowledged: acknowledged}), {wrapper: makeWrapper()});
 await waitFor(() => expect(result.current.isLoading).toBe(false));
 mockApi.apply.mockImplementation(async (_c, _v, patch) => {
   mockApi.get.mockResolvedValue(snapshot(patch.expectedRevision + 1));
   return {operationId: patch.operationId, revision: patch.expectedRevision + 1, schemaVersion: 1, nextOpenedOrdinal: 2, opened: [{operationIndex: 0, key: "p", openedOrdinal: 1}]};
 });
 const open = {type: "open" as const, key: "p", ref: {kind: "task" as const, id: "t"}, title: "T", rect: {x: 0, y: 0, width: 100, height: 100}};
 const context = {epoch: "frame-one", openings: [{operationIndex: 0, key: "p", generation: 7}]};
 await act(async () => {
   result.current.queueOps([open], false, context);
   result.current.queueOps([op]);
   await result.current.flush();
 });
 expect(mockApi.apply).toHaveBeenCalledTimes(2);
 expect(acknowledged).toHaveBeenCalledTimes(2);
 expect(acknowledged.mock.calls[0]![2]).toEqual(context);
 expect(acknowledged.mock.calls[1]![2]).toBeUndefined();
});

it("rejects unknown snapshot schemas without exposing or mutating the layout", async () => {
 vi.resetAllMocks(); mockApi.get.mockResolvedValue({...snapshot(0), schemaVersion: 999});
 const {result} = renderHook(() => useUniverseState("c1", "conv1"), {wrapper: makeWrapper()});
 await waitFor(() => expect(result.current.isLoading).toBe(false));
 expect(result.current.document).toBeUndefined();
 expect(result.current.isError).toBe(true);
 expect(() => result.current.queueOps([op])).toThrow();
});
it("lets the user discard only the current corrupt journal after preserving an export", async () => {
 vi.resetAllMocks(); mockApi.get.mockResolvedValue(snapshot(0));
 const scope = JSON.stringify([JSON.stringify(["owner", "login"]), "c1", "conv1"]);
 const storageKey = "aoa:universe:layout:v1:" + scope;
 sessionStorage.setItem(storageKey, "corrupt");
 const {result} = renderHook(() => useUniverseState("c1", "conv1"), {wrapper: makeWrapper()});
 await waitFor(() => expect(result.current.isLoading).toBe(false));
 expect(result.current.status).toBe("blocked");
 expect(result.current.exportRecovery()).toContain("corrupt");
 act(() => result.current.discardInvalidRecovery());
 expect(sessionStorage.getItem(storageKey)).toBeNull();
 expect(result.current.status).toBe("idle");
 expect(mockApi.apply).not.toHaveBeenCalled();
});

it("uses the rendered edit base instead of a newer background snapshot", async () => {
 vi.resetAllMocks(); const {result} = await ready();
 const remote = snapshot(1); remote.document.viewport.x = 99;
 mockApi.get.mockResolvedValue(remote);
 await act(async () => {await result.current.refetch();});
 mockApi.apply.mockResolvedValue({operationId: "wrong", revision: 2, schemaVersion: 1, nextOpenedOrdinal: 1, opened: []});
 await act(async () => {await result.current.queueOps([op], true, undefined, {revision: 0, document: snapshot(0).document})?.catch(() => {});});
 expect(mockApi.apply).not.toHaveBeenCalled();
 expect(result.current.status).toBe("conflict");
});

it("requires review again if the saved layout changed while conflict choices were visible", async () => {
 vi.resetAllMocks(); const {result} = await ready();
 mockApi.apply.mockRejectedValueOnce(new ApiError("conflict", 409, null));
 await act(async () => {await result.current.queueOps([op], true)?.catch(() => {});});
 mockApi.get.mockResolvedValue(snapshot(2));
 await act(async () => {await result.current.resolveConflict([op], 0).catch(() => {});});
 expect(result.current.status).toBe("conflict");
 expect(result.current.conflictingPatch).not.toBeNull();
 expect(mockApi.apply).toHaveBeenCalledTimes(1);
});

it("retains a storage-rejected edit's original witnesses when retry sees remote changes", async () => {
 vi.resetAllMocks();
 const {result} = await ready(0);
 const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
 act(() => {expect(() => result.current.queueOps([op])).toThrow("quota");});
 storage.mockRestore();
 mockApi.get.mockResolvedValue({...snapshot(1), document: {...snapshot(1).document, viewport: {x: 99, y: 0, zoom: 1}}});
 await act(async () => {await result.current.refetch();});
 await act(async () => {await result.current.retryRecovery().catch(() => undefined);});
 expect(result.current.status).toBe("conflict");
 expect(mockApi.apply).not.toHaveBeenCalled();
});

it("keeps recovery blocked and the first rejected edit after retry storage fails again", async () => {
 vi.resetAllMocks(); const {result} = await ready(0);
 const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
 try {
  act(() => {expect(() => result.current.queueOps([op])).toThrow("quota");});
  await act(async () => {await expect(result.current.retryRecovery()).rejects.toThrow("quota");});
  expect(result.current.recoveryError).toContain("quota");
  act(() => {expect(() => result.current.queueOps([{...op, x: 50}])).toThrow("quota");});
  expect(JSON.parse(result.current.exportRecovery()).rejectedEdit).toEqual([op]);
 } finally {storage.mockRestore();}
});
