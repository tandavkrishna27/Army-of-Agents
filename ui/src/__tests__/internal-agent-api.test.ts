import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAgentChat } from "../api/internal-agent";

function sseResponse(body = 'event: done\ndata: {"ok":true}\n\n') {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamAgentChat", () => {
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
