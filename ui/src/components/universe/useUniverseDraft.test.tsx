vi.mock("../../api/auth", () => ({ authApi: { getSession: async () => ({user: {id: "owner"}, session: {id: "login", userId: "owner"}}) } }));
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUniverseDraft } from "./useUniverseDraft";
import { universeDraftApi } from "../../api/universe-draft";
import { ApiError } from "../../api/client";
import { commanderConversationsApi } from "../../api/internal-agent";
import { issuesApi } from "../../api/issues";

vi.mock("../../api/universe-draft", () => ({
  universeDraftApi: { get: vi.fn(), save: vi.fn() },
}));
vi.mock("../../api/internal-agent", () => ({
  commanderConversationsApi: { getSubmissionOutcome: vi.fn() },
}));
vi.mock("../../api/issues", () => ({ issuesApi: { getCommentSubmissionOutcome: vi.fn() } }));
const mockApi = vi.mocked(universeDraftApi);
const mockCommanderApi = vi.mocked(commanderConversationsApi);
const mockIssuesApi = vi.mocked(issuesApi);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const dest = { kind: "task" as const, id: "t1" };
const draft = (revision: number, text = "", attachmentAssetIds: string[] = []) => ({
  revision,
  text,
  attachmentAssetIds,
});

async function ready(initial = draft(0)) {
  mockApi.get.mockResolvedValue(initial);
  const hook = renderHook(() => useUniverseDraft("c1", "conv1", dest), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}
async function readyCommander(initial = draft(0)) {
  mockApi.get.mockResolvedValue(initial);
  const hook = renderHook(() => useUniverseDraft("c1", "conv1", { kind: "commander", id: "conv1" }), { wrapper: makeWrapper() });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe("useUniverseDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the draft", async () => {
    const { result } = await ready(draft(2, "hi", ["a1"]));
    expect(result.current.draft).toEqual(draft(2, "hi", ["a1"]));
    expect(result.current.revision).toBe(2);
  });

  it("save flushes with the current expectedRevision and reports saved", async () => {
    mockApi.save.mockResolvedValue(draft(3, "typed"));
    const { result } = await ready(draft(2, "old"));
    await act(async () => {
      await result.current.save("typed", [], true);
    });
    expect(mockApi.save).toHaveBeenCalledTimes(1);
    const [, , , patch] = mockApi.save.mock.calls[0]!;
    expect(patch.expectedRevision).toBe(2);
    expect("text" in patch && patch.text).toBe("typed");
    expect(result.current.status).toBe("saved");
    expect(result.current.draft).toEqual(draft(3, "typed"));
  });

  it("a 409 sets conflict and re-fetches", async () => {
    mockApi.save.mockRejectedValue(new ApiError("stale", 409, null));
    const { result } = await ready(draft(0));
    mockApi.get.mockClear();
    await act(async () => {
      try {
        await result.current.save("x", [], true);
      } catch {
        /* expected save failure */
      }
    });
    expect(result.current.status).toBe("conflict");
    expect(mockApi.get).toHaveBeenCalled();
  });

  it("a network error keeps the edit and retries", async () => {
    mockApi.save.mockRejectedValueOnce(new Error("net"));
    const { result } = await ready(draft(0));
    await act(async () => {
      try {
        await result.current.save("x", [], true);
      } catch {
        /* expected save failure */
      }
    });
    expect(result.current.status).toBe("offline");
    mockApi.save.mockResolvedValueOnce(draft(1, "x"));
    await act(async () => {
      await result.current.flush();
    });
    expect(mockApi.save).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("saved");
  });

  it("submitSnapshot freezes the draft and acknowledge clears exactly that snapshot", async () => {
    mockApi.save.mockResolvedValue(draft(5, ""));
    const { result } = await ready(draft(4, "hello"));
    const sent = result.current.submitSnapshot("s1");
    expect(sent).toEqual({
      revision: 4,
      text: "hello",
      attachmentAssetIds: [],
      clientSubmissionId: "s1",
    });
    await act(async () => {
      await result.current.acknowledge(sent!);
    });
    const [, , , lastPatch] = mockApi.save.mock.calls[0]!;
    expect("text" in lastPatch && lastPatch.text).toBe("");
  });
  it("Send freezes the current input before its debounce has saved", async () => {
    const { result, unmount } = await ready(draft(2, "old"));
    act(() => { result.current.save("new input", ["a2"]); });
    expect(result.current.submitSnapshot("s2")).toMatchObject({ text: "new input", attachmentAssetIds: ["a2"] });
    unmount();
  });

  it("acknowledgement does not erase input typed after Send", async () => {
    const { result, unmount } = await ready(draft(2, "sent"));
    const sent = result.current.submitSnapshot("s2")!;
    act(() => { result.current.save("unsent new input", []); });
    await act(async () => { await result.current.acknowledge(sent); });
    expect(mockApi.save).not.toHaveBeenCalled();
    expect(result.current.submitSnapshot("s3")?.text).toBe("unsent new input");
    unmount();
  });

  it("acknowledgement clears an attachment-only draft", async () => {
    mockApi.save.mockResolvedValue(draft(3));
    const { result } = await ready(draft(2, "", ["a1"]));
    const sent = result.current.submitSnapshot("s2")!;
    await act(async () => { await result.current.acknowledge(sent); });
    expect(mockApi.save).toHaveBeenCalledWith("c1", "conv1", dest, expect.objectContaining({ text: "", attachmentAssetIds: [] }), expect.any(AbortSignal));
  });

  it("recovers a lost Commander acknowledgement by observing without resending", async () => {
    mockCommanderApi.getSubmissionOutcome.mockResolvedValue({ state: "completed", userMessageId: "u1", assistantMessageId: "a1" });
    mockApi.save.mockResolvedValue(draft(3));
    const { result } = await readyCommander(draft(2, "sent"));
    const sent = result.current.submitSnapshot("submission-2")!;
    let outcome: Awaited<ReturnType<typeof result.current.recoverCommanderSubmission>>;
    await act(async () => { outcome = await result.current.recoverCommanderSubmission(sent); });
    expect(mockCommanderApi.getSubmissionOutcome).toHaveBeenCalledWith("c1", "conv1", "submission-2");
    expect(outcome!.state).toBe("completed");
    expect(mockApi.save).toHaveBeenCalledWith("c1", "conv1", { kind: "commander", id: "conv1" }, expect.objectContaining({ text: "" }), expect.any(AbortSignal));
  });

  it("retains the draft when canonical observation has no submission", async () => {
    mockCommanderApi.getSubmissionOutcome.mockResolvedValue({ state: "not_found" });
    const { result } = await readyCommander(draft(2, "keep"));
    const sent = result.current.submitSnapshot("missing")!;
    await act(async () => { await result.current.recoverCommanderSubmission(sent); });
    expect(mockApi.save).not.toHaveBeenCalled();
    expect(result.current.submitSnapshot("next")?.text).toBe("keep");
  });

  it("recovers a lost task-comment acknowledgement through the task receipt", async () => {
    mockIssuesApi.getCommentSubmissionOutcome.mockResolvedValue({ state: "completed", commentId: "comment-1" });
    mockApi.save.mockResolvedValue(draft(3));
    const { result } = await ready(draft(2, "sent task reply"));
    const sent = result.current.submitSnapshot("task-submission")!;
    await act(async () => { await result.current.recoverSubmission(sent); });
    expect(mockIssuesApi.getCommentSubmissionOutcome).toHaveBeenCalledWith("t1", "task-submission");
    expect(mockApi.save).toHaveBeenCalledWith("c1", "conv1", dest, expect.objectContaining({ text: "" }), expect.any(AbortSignal));
  });

  it("a failed in-flight save cannot overwrite a newer queued edit", async () => {
    let reject!: (reason: Error) => void;
    mockApi.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { result, unmount } = await ready(draft(0));
    let saving!: Promise<unknown>;
    act(() => { saving = result.current.save("older", [], true)!.catch(() => undefined); });
    act(() => { result.current.save("newer", []); });
    await act(async () => { reject(new Error("offline")); await saving; });
    mockApi.save.mockResolvedValue(draft(1, "newer"));
    await act(async () => { await result.current.flush(); });
    const retryPatch = mockApi.save.mock.calls[1]?.[3];
    expect(retryPatch && "text" in retryPatch && retryPatch.text).toBe("newer");
    unmount();
  });

  it("uses a refreshed server draft once the local edit has been saved", async () => {
    mockApi.save.mockResolvedValue(draft(1, "local"));
    const { result } = await ready(draft(0));
    await act(async () => { await result.current.save("local", [], true); });
    mockApi.get.mockResolvedValue(draft(2, "other tab"));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.submitSnapshot("s3")?.text).toBe("other tab");
  });

});

it("keeps unsaved draft candidates separate when switching destinations", async () => {
 mockApi.get.mockResolvedValue(draft(0));
 const h = renderHook(({id}) => useUniverseDraft("c1", "conv1", {kind: "task", id}, {debounceMs: 60000}), {initialProps: {id: "first"}, wrapper: makeWrapper()});
 await waitFor(() => expect(h.result.current.isLoading).toBe(false));
 act(() => {h.result.current.save("unsaved first", []);});
 h.rerender({id: "second"});
 await waitFor(() => expect(h.result.current.isLoading).toBe(false));
 expect(h.result.current.submitSnapshot("second")?.text).toBe("");
 h.rerender({id: "first"});
 await waitFor(() => expect(h.result.current.submitSnapshot("first")?.text).toBe("unsaved first"));
 h.unmount();
});
