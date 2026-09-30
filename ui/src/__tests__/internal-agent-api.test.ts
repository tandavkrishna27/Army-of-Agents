import { afterEach, describe, expect, it, vi } from "vitest";
import { commanderConversationsApi, streamAgentChat } from "../api/internal-agent";

function sseResponse(body = 'event: done\ndata: {"ok":true}\n\n') {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Commander submission outcome", () => {
  it("uses a read-only canonical lookup", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ state: "not_found" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await commanderConversationsApi.getSubmissionOutcome("company-1", "conv-1", "sub-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/conversations/conv-1/submissions/sub-1");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
});

describe("streamAgentChat", () => {
  it("sends a frozen Universe context snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());
    const universeContext = { schemaVersion: 1 as const, conversationId: "550e8400-e29b-41d4-a716-446655440001", selected: null, visible: [], viewport: { width: 1200, height: 800, x: 0, y: 0, zoom: 1 } };
    for await (const _ of streamAgentChat("company-1", "hello", null, undefined, universeContext.conversationId, { surface: "universe" }, [], "submission-1", universeContext)) void _;
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body)).universeContext).toEqual(universeContext);
  });

  it("sends structured Commander context scope while preserving async iteration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());
    const scope = {
      surface: "task" as const,
      taskId: "550e8400-e29b-41d4-a716-446655440001",
    };

    const stream = streamAgentChat("company-1", "remember this", "Tasks > Onboarding", undefined, null, scope);

    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ event: "done", data: { ok: true } }]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      message: "remember this",
      pageContext: "Tasks > Onboarding",
      contextScope: scope,
    });
  });
});
