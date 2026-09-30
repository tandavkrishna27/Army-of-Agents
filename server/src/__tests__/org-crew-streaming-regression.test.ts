import { describe, it, expect } from "vitest";
import { mapProviderRunnerCallbacks } from "../services/environment-run-orchestrator.js";

// -----------------------------------------------------------------------------
// W7.5f Task 3 — org/crew streaming regression. W7.5b added the
// `onLog → onStdout/onStderr` mapping (provider-sandbox live-log parity with
// docker). The org/crew adapters parse the FINAL buffered `{ stdout }` for the
// outcome + cost inputs (computeCostCents), NEVER the incremental onLog. So
// incremental onLog delivery is a strict SUPERSET with an identical parsed
// outcome. This locks that the streamed bytes and the buffered bytes agree.
// -----------------------------------------------------------------------------

describe("org/crew streaming regression (W7.5b did not change the buffered result)", () => {
  it("mapProviderRunnerCallbacks delivers onLog incrementally but the concatenated stream == the buffered stdout (byte-identical)", () => {
    const streamed: string[] = [];
    const onLog = (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stdout") streamed.push(chunk);
    };
    const { onStdout } = mapProviderRunnerCallbacks(onLog);
    const chunks = ["frame-1\n", "frame-2\n", "final-frame"];
    for (const c of chunks) onStdout!(c);
    const buffered = chunks.join("");
    // A consumer that parses the buffered result gets the identical bytes the
    // incremental stream delivered → cost accounting from the buffered result is
    // unchanged.
    expect(streamed.join("")).toBe(buffered);
  });

  it("stderr frames route to onStderr and never leak into the stdout stream (channel integrity)", () => {
    const out: string[] = [];
    const err: string[] = [];
    const onLog = (stream: "stdout" | "stderr", chunk: string) => {
      (stream === "stdout" ? out : err).push(chunk);
    };
    const { onStdout, onStderr } = mapProviderRunnerCallbacks(onLog);
    onStdout!("o1");
    onStderr!("e1");
    onStdout!("o2");
    expect(out.join("")).toBe("o1o2");
    expect(err.join("")).toBe("e1");
  });

  it("returns undefined callbacks with no onLog (buffered-only, pre-W7.5b byte-identical path)", () => {
    expect(mapProviderRunnerCallbacks(undefined)).toEqual({});
  });
});
