import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServerResultAccumulator } from "../app-server/parse-events.js";
import { parseCodexJsonl } from "../parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Frame {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function loadFixtureFrames(): Frame[] {
  const raw = readFileSync(
    path.join(__dirname, "fixtures", "appserver-turn.json"),
    "utf8",
  );
  return (JSON.parse(raw) as { frames: Frame[] }).frames;
}

/** Replay only the NOTIFICATION frames (method present, id absent) — mirrors the
 *  driver's `registerNotificationHandler` routing. Server requests (method+id)
 *  and plain responses (id only) are not notifications. */
function feedFixture(acc: ReturnType<typeof createAppServerResultAccumulator>) {
  for (const frame of loadFixtureFrames()) {
    if (frame.method && frame.id === undefined) {
      acc.onNotification(frame.method, frame.params);
    }
  }
}

describe("createAppServerResultAccumulator — fixture replay", () => {
  it("derives summary, usage (incl. cachedInputTokens), chunks and outputFiles", () => {
    const acc = createAppServerResultAccumulator();
    feedFixture(acc);
    const out = acc.result();

    // Three agentMessages complete in this turn (all phases, mirroring
    // parseCodexJsonl which has no phase filter): the turn-1 final_answer, the
    // turn-2 commentary, then the turn-2 final_answer.
    expect(out.summary).toBe(
      "Command was rejected.\n\n" +
        "Using the direct file patch tool to add `notes.txt` with the requested single line.\n\n" +
        "Done.",
    );

    // Last-wins token usage = the final thread/tokenUsage/updated total.
    expect(out.usage).toEqual({
      inputTokens: 80355,
      cachedInputTokens: 52736,
      outputTokens: 162,
    });
    // cachedInputTokens must survive (camelCase → not dropped).
    expect((out.usage as { cachedInputTokens: number }).cachedInputTokens).toBe(52736);

    // fileChange item surfaces the raw path (Task 7 normalizes later).
    expect(out.outputFiles).toEqual([
      "C:\\Users\\TK\\AppData\\Local\\Temp\\w5c-cap-uIHiyF\\notes.txt",
    ]);

    // No mcp/tool_result/action_confirmation payloads in this capture, and the
    // reasoning items carry empty text → no chunks.
    expect(out.chunks).toEqual([]);

    expect(out.errorMessage).toBeNull();
    expect(out.errorCode).toBeNull();
  });

  it("dedupes delta+completed for the same message (join semantics match exec)", () => {
    const acc = createAppServerResultAccumulator();
    const itemId = "msg_1";
    // Stream deltas...
    acc.onNotification("item/agentMessage/delta", { itemId, delta: "Hello" });
    acc.onNotification("item/agentMessage/delta", { itemId, delta: " world" });
    // ...then the authoritative completed text arrives for the SAME id.
    acc.onNotification("item/completed", {
      item: { type: "agentMessage", id: itemId, text: "Hello world" },
    });

    // Counted ONCE (not "Hello world\n\nHello world").
    expect(acc.result().summary).toBe("Hello world");
  });

  it("dedupe falls back to delta text when no completed frame arrives", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("item/agentMessage/delta", { itemId: "m", delta: "partial" });
    expect(acc.result().summary).toBe("partial");
  });
});

describe("createAppServerResultAccumulator — parity with parseCodexJsonl", () => {
  it("mcp tool result with outputRefs lifts an IDENTICAL tool_result chunk via both paths", () => {
    const refPayload = JSON.stringify({
      outputRefs: [
        {
          v: 1,
          kind: "artifact",
          id: "artifact-123",
          versionId: "ver-9",
          versionNumber: 2,
          title: "Spec",
          action: "created",
          toolCallId: "call-xyz",
          mimeType: "text/markdown",
        },
      ],
    });

    // exec JSONL form: `item.completed` (dot) + snake_case `mcp_tool_call`.
    // server:"aoa" required — the Task-4 trust gate lifts refs only from the AoA MCP.
    const execLine = JSON.stringify({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "aoa", name: "write_artifact", content: refPayload },
    });
    const execChunks = parseCodexJsonl(execLine).chunks;

    // app-server form: `item/completed` (slash) + camelCase item type.
    const acc = createAppServerResultAccumulator();
    acc.onNotification("item/completed", {
      item: { type: "mcp_tool_call", server: "aoa", name: "write_artifact", content: refPayload },
    });
    const accChunks = acc.result().chunks as unknown[];

    expect(accChunks).toEqual(execChunks);
    // Sanity: a real tool_result chunk was produced.
    expect(accChunks).toHaveLength(1);
    expect(accChunks[0]).toMatchObject({ type: "tool_result", name: "write_artifact" });
  });

  it("mcp-only gate: a plain tool_result with outputRefs does NOT lift a chunk", () => {
    const refPayload = JSON.stringify({
      outputRefs: [{ v: 1, kind: "artifact", id: "a1", action: "created" }],
    });

    // Plain (non-mcp) tool_result — must be gated out on BOTH paths.
    const execLine = JSON.stringify({
      type: "item.completed",
      item: { type: "tool_result", name: "shell", content: refPayload },
    });
    expect(parseCodexJsonl(execLine).chunks).toEqual([]);

    const acc = createAppServerResultAccumulator();
    acc.onNotification("item/completed", {
      item: { type: "tool_result", name: "shell", content: refPayload },
    });
    expect(acc.result().chunks).toEqual([]);
  });

  it("cross-MCP injection: a non-aoa server mcp_tool_call does NOT lift refs (Task 4 / P1.1)", () => {
    const refPayload = JSON.stringify({
      outputRefs: [{ v: 2, kind: "artifact", id: "forged-1", action: "created" }],
    });

    // Same mcp_tool_call item, but server:"playwright" — a non-AoA MCP. Must be
    // gated out on BOTH the exec JSONL path and the app-server accumulator path.
    const execLine = JSON.stringify({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "playwright", name: "browser_navigate", content: refPayload },
    });
    expect(parseCodexJsonl(execLine).chunks).toEqual([]);

    const acc = createAppServerResultAccumulator();
    acc.onNotification("item/completed", {
      item: { type: "mcp_tool_call", server: "playwright", name: "browser_navigate", content: refPayload },
    });
    expect(acc.result().chunks).toEqual([]);
  });

  it("cross-MCP injection: a non-aoa mcp_tool_call_end (event_msg path) does NOT lift refs", () => {
    const refPayload = JSON.stringify({
      outputRefs: [{ v: 2, kind: "artifact", id: "forged-2", action: "created" }],
    });
    const nonAoa = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "c1",
        invocation: { server: "playwright", tool: "browser_navigate" },
        result: { Ok: { content: [{ type: "text", text: refPayload }] } },
      },
    });
    const chunks = parseCodexJsonl(nonAoa).chunks;
    const tr = chunks.find((c) => c.type === "tool_result") as any;
    expect(tr).toBeDefined(); // the chunk still emits (tool ran)
    expect(tr.refs).toEqual([]); // but NO refs lifted from a non-aoa server

    const aoa = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "c2",
        invocation: { server: "aoa", tool: "create_artifact" },
        result: { Ok: { content: [{ type: "text", text: refPayload }] } },
      },
    });
    const aoaTr = parseCodexJsonl(aoa).chunks.find((c) => c.type === "tool_result") as any;
    expect(aoaTr.refs).toHaveLength(1); // aoa server → refs lifted
    expect(aoaTr.refs[0]).toMatchObject({ id: "forged-2" });
  });

  it("action_confirmation lifts identically through both paths", () => {
    const confirm = `⚡CONFIRM:${JSON.stringify({
      toolName: "create_task",
      params: { title: "x" },
      confirmId: "run-7",
    })}⚡`;

    const execLine = JSON.stringify({
      type: "item.completed",
      item: { type: "tool_result", name: "ask", content: confirm },
    });
    const execChunks = parseCodexJsonl(execLine).chunks;

    const acc = createAppServerResultAccumulator();
    acc.onNotification("item/completed", {
      item: { type: "tool_result", name: "ask", content: confirm },
    });
    const accChunks = acc.result().chunks as unknown[];

    expect(accChunks).toEqual(execChunks);
    expect(accChunks[0]).toMatchObject({ type: "action_confirmation", toolName: "create_task" });
  });
});

describe("createAppServerResultAccumulator — errors", () => {
  it("captures error notification message (willRetry) and code", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", {
      message: "stream disconnected",
      willRetry: true,
      code: "stream_error",
    });
    const out = acc.result();
    expect(out.errorMessage).toBe("stream disconnected");
    expect(out.errorCode).toBe("stream_error");
  });

  it("captures turn/failed message + errorCode (live nested turn.error shape)", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("turn/failed", {
      turn: { error: { message: "model overloaded", code: "overloaded" } },
    });
    const out = acc.result();
    expect(out.errorMessage).toBe("model overloaded");
    expect(out.errorCode).toBe("overloaded");
  });

  it("captures the driver-synthesized turn/failed shape", () => {
    // driver.ts synthesizes `{ turn: { error: { message } } }` on turn/start reject.
    const acc = createAppServerResultAccumulator();
    acc.onNotification("turn/failed", {
      turn: { error: { message: "turn/start rejected: boom" } },
    });
    expect(acc.result().errorMessage).toBe("turn/start rejected: boom");
  });

  it("clears a transient error when the turn recovered AND produced work (M1)", () => {
    // A turn may emit a transient `error` (willRetry) frame, recover, produce a
    // real agent message, and settle on `turn/completed`. That is a SUCCESSFUL
    // turn — the accumulated errorMessage/errorCode must be cleared so
    // bridgedResultToIntermediate does NOT map it to exitCode:1. (M1)
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", {
      message: "stream disconnected",
      willRetry: true,
      code: "stream_error",
    });
    acc.onNotification("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "Done." },
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBeNull();
    expect(out.errorCode).toBeNull();
    expect(out.summary).toBe("Done.");
  });

  it("PRESERVES a fatal error on a ZERO-WORK completed turn (masked-400 guard, M1 hardened)", () => {
    // The BUG-6 primary defect: a ChatGPT-auth 400 ends the turn with zero items
    // but codex still emits turn/completed. A completed turn with NO work AND an
    // error present is a masked fatal — the error must be PRESERVED so it maps to
    // exitCode:1 (honest failure) instead of a false "succeeded".
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", {
      message: "not supported when using Codex with a ChatGPT account",
      code: "http_400",
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBe(
      "not supported when using Codex with a ChatGPT account",
    );
    expect(out.errorCode).toBe("http_400");
    expect(out.summary).toBe("");
  });

  it("clears the error when work came only from an outputFile (fileChange) — producedWork counts files", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", { message: "transient", code: "x" });
    acc.onNotification("item/completed", {
      item: { type: "fileChange", changes: [{ path: "/tmp/out.txt" }] },
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBeNull();
    expect(out.outputFiles).toEqual(["/tmp/out.txt"]);
  });
});

describe("createAppServerResultAccumulator — idempotency", () => {
  it("result() is idempotent (two calls return equal intermediates)", () => {
    const acc = createAppServerResultAccumulator();
    feedFixture(acc);
    const a = acc.result();
    const b = acc.result();
    expect(b).toEqual(a);
  });

  it("a duplicate terminal turn/failed does not double-count (last-wins)", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("turn/failed", { turn: { error: { message: "first" } } });
    acc.onNotification("turn/failed", { turn: { error: { message: "second" } } });
    // Last-wins, single value — not concatenated.
    expect(acc.result().errorMessage).toBe("second");
  });
});
