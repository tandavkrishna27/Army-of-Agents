import { describe, it, expect } from "vitest";
import { mapProviderRunnerCallbacks } from "../services/environment-run-orchestrator.js";

describe("mapProviderRunnerCallbacks", () => {
  it("routes onStdout/onStderr into the adapter's onLog(stream, chunk)", () => {
    const seen: Array<[string, string]> = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => { seen.push([stream, chunk]); };
    const { onStdout, onStderr } = mapProviderRunnerCallbacks(onLog);
    onStdout!("a");
    onStderr!("b");
    expect(seen).toEqual([["stdout", "a"], ["stderr", "b"]]);
  });

  it("returns undefined callbacks when onLog is absent (byte-identical buffered path)", () => {
    const { onStdout, onStderr } = mapProviderRunnerCallbacks(undefined);
    expect(onStdout).toBeUndefined();
    expect(onStderr).toBeUndefined();
  });
});
