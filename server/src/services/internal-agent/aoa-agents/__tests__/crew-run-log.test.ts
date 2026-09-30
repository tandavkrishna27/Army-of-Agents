import { describe, it, expect, vi } from "vitest";
import { createCrewRunLogSink, redactMeta } from "../crew-run-log.js";

describe("redactMeta", () => {
  it("drops prompt/context/env and keeps operational fields", () => {
    const out = redactMeta({
      adapterType: "claude_local", command: "claude", commandArgs: ["--print"],
      cwd: "/w", prompt: "SECRET PROMPT", env: { TOKEN: "sk-leak" }, context: { payload: "SECRET" },
    });
    expect(out.command).toBe("claude");
    expect(out.cwd).toBe("/w");
    expect(out.prompt).toBeUndefined();
    expect(out.env).toBeUndefined();
    expect(out.context).toBeUndefined();
    expect(out.promptChars).toBe(13);
    expect(out.contextKeys).toEqual(["payload"]);
  });

  // The real guarantee is that redactMeta is an ALLOWLIST — it builds a fresh
  // object from named fields, so any field added to AdapterInvocationMeta later
  // is dropped by default. Asserting three named absences would still pass if
  // someone rewrote it as a denylist (`delete`/spread), which would silently
  // persist every future field. Pin the exact output key-set instead: feed it
  // EVERY documented field plus an unknown extra, and require the result to
  // contain nothing but the allowlisted keys.
  it("is an allowlist: emits only allowlisted keys, even for unknown input fields", () => {
    const out = redactMeta({
      adapterType: "claude_local",
      command: "claude",
      cwd: "/w",
      commandArgs: ["--print"],
      commandNotes: ["note"],
      env: { TOKEN: "sk-leak" },
      prompt: "SECRET PROMPT",
      promptMetrics: { chars: 13 },
      context: { payload: "SECRET" },
      // Not on AdapterInvocationMeta today — stands in for a field a future
      // change adds. A denylist would forward it; an allowlist drops it.
      futureSecretField: "SECRET",
    } as never);

    expect(Object.keys(out).sort()).toEqual([
      "adapterType",
      "commandArgs",
      "commandNotes",
      "command",
      "contextKeys",
      "cwd",
      "promptChars",
      "promptMetrics",
    ].sort());
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("sk-leak");
  });
});

describe("createCrewRunLogSink", () => {
  it("forwards log chunks verbatim and meta as one redacted system chunk", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const handle = { store: "local_file" as const, logRef: "r" };
    const sink = createCrewRunLogSink({ store: { append }, handle, logger: { warn: vi.fn() } });

    await sink.onLog("stdout", "hello\n");
    await sink.onMeta({ adapterType: "claude_local", command: "claude", prompt: "SECRET PROMPT" });

    expect(append).toHaveBeenCalledTimes(2);
    const [, first] = append.mock.calls[0];
    expect(first).toMatchObject({ stream: "stdout", chunk: "hello\n" });
    expect(typeof first.ts).toBe("string");

    const [, second] = append.mock.calls[1];
    expect(second.stream).toBe("system");
    const parsed = JSON.parse(second.chunk);
    expect(parsed.event).toBe("adapter.invoke");
    expect(parsed.meta.command).toBe("claude");
    expect(parsed.meta.prompt).toBeUndefined();
    expect(second.chunk).not.toContain("SECRET PROMPT");
  });

  it("never throws when the store fails", async () => {
    const append = vi.fn().mockRejectedValue(new Error("disk full"));
    const sink = createCrewRunLogSink({ store: { append }, handle: { store: "local_file", logRef: "r" }, logger: { warn: vi.fn() } });
    await expect(sink.onLog("stderr", "boom")).resolves.toBeUndefined();
    await expect(sink.onMeta({ adapterType: "claude_local", command: "claude" })).resolves.toBeUndefined();
  });

  // A silently-empty transcript is the failure mode T1 exists to kill: it reads
  // identically to "the agent produced no output". Warn ONCE per sink so a
  // broken store is diagnosable without emitting a line per chunk.
  it("warns once per sink on append failure, and keeps swallowing", async () => {
    const append = vi.fn().mockRejectedValue(new Error("disk full"));
    const warn = vi.fn();
    const sink = createCrewRunLogSink({
      store: { append },
      handle: { store: "local_file", logRef: "co-1/ag-1/run-1.ndjson" },
      run: { companyId: "co-1", agentId: "ag-1", runId: "run-1" },
      logger: { warn },
    });

    await expect(sink.onLog("stdout", "one")).resolves.toBeUndefined();
    await expect(sink.onLog("stdout", "two")).resolves.toBeUndefined();
    await expect(sink.onMeta({ adapterType: "claude_local", command: "claude" })).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0];
    expect(fields).toMatchObject({
      companyId: "co-1",
      agentId: "ag-1",
      runId: "run-1",
      logRef: "co-1/ag-1/run-1.ndjson",
    });
    expect(fields.err).toBeInstanceOf(Error);
  });

  it("latches per sink — a second run still gets its own first warning", async () => {
    const append = vi.fn().mockRejectedValue(new Error("disk full"));
    const warn = vi.fn();
    const handle = { store: "local_file" as const, logRef: "r" };
    const first = createCrewRunLogSink({ store: { append }, handle, logger: { warn } });
    const second = createCrewRunLogSink({ store: { append }, handle, logger: { warn } });

    await first.onLog("stdout", "a");
    await first.onLog("stdout", "b");
    await second.onLog("stdout", "c");

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
