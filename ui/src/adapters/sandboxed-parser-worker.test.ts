import { describe, expect, it } from "vitest";
import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables network and child worker escape hatches", () => {
    const source = getWorkerBootstrapSource();
    expect(source).toContain("self.fetch = _undefined");
    expect(source).toContain("self.Worker = _undefined");
    expect(source).toContain("self.SharedWorker = _undefined");
    expect(source).toContain("self.Blob = _undefined");
    expect(source).toContain("self.RTCPeerConnection = _undefined");
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });
});
