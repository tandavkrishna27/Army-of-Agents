import { describe, it, expect } from "vitest";
import { liftOutputRefs } from "../parse-shared.js";

describe("liftOutputRefs v2", () => {
  it("lifts a legacy v:1 artifact ref byte-identically (no v2 keys)", () => {
    const text = JSON.stringify({ outputRefs: [{ v: 1, kind: "artifact", id: "a1", action: "created" }] });
    expect(liftOutputRefs(text)).toEqual([
      { v: 1, kind: "artifact", id: "a1", versionId: null, versionNumber: null, title: null, action: "created", toolCallId: null, mimeType: null },
    ]);
  });
  it("lifts a v:2 ref preserving provenance", () => {
    const prov = { surface: "commander", entityId: "conv-1", seq: 2, emittedAt: "2026-07-18T10:00:00.000Z" };
    const text = JSON.stringify({ outputRefs: [{ v: 2, kind: "task", id: "t1", action: "referenced", provenance: prov }] });
    const refs = liftOutputRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs![0]).toMatchObject({
      v: 2, kind: "task", id: "t1", action: "referenced", viewerKind: null,
      provenance: { surface: "commander", entityId: "conv-1", seq: 2, emittedAt: "2026-07-18T10:00:00.000Z", agentId: null, runId: null, messageId: null },
    });
  });
  it("accepts a v:2 ref with no provenance (null)", () => {
    const text = JSON.stringify({ outputRefs: [{ v: 2, kind: "approval", id: "ap1", action: "created" }] });
    expect(liftOutputRefs(text)![0]).toMatchObject({ v: 2, kind: "approval", id: "ap1", provenance: null });
  });
  it("rejects unknown kind, missing action, and present-but-malformed provenance", () => {
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "nope", id: "x", action: "created" }] }))).toBeNull();
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "task", id: "x" }] }))).toBeNull();
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "task", id: "x", action: "created", provenance: { surface: "commander" } }] }))).toBeNull();
  });
  it("rejects a v:1 ref with a non-artifact kind", () => {
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 1, kind: "task", id: "x", action: "created" }] }))).toBeNull();
  });
  it("applies id caps by version (v2 allows long ids, v1 does not)", () => {
    const longId = "u".repeat(300);
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "url", id: longId, action: "referenced" }] }))![0]).toMatchObject({ v: 2, id: longId });
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 1, kind: "artifact", id: longId, action: "created" }] }))).toBeNull();
  });
  it("preserves viewerKind when present and rejects negative seq", () => {
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "artifact", id: "a", action: "created", viewerKind: "markdown" }] }))![0]).toMatchObject({ viewerKind: "markdown" });
    expect(liftOutputRefs(JSON.stringify({ outputRefs: [{ v: 2, kind: "task", id: "t", action: "created", provenance: { surface: "commander", entityId: "c", seq: -1, emittedAt: "2026-01-01T00:00:00.000Z" } }] }))).toBeNull();
  });
});
