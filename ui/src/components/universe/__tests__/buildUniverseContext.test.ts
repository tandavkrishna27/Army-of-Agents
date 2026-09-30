import { describe, expect, it } from "vitest";
import { buildUniverseContext } from "../buildUniverseContext";

const C = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const V1 = "30000000-0000-4000-8000-000000000001";
const V2 = "30000000-0000-4000-8000-000000000002";

describe("buildUniverseContext", () => {
  it("freezes selection and deduplicates visible references at submission", () => {
    const selected = { kind: "artifact" as const, id: A, versionId: V1 };
    const input = {
      conversationId: C,
      selected,
      visible: [selected, selected],
      viewport: { width: 1440, height: 900, x: 0, y: 0, zoom: 1 },
    };
    const captured = buildUniverseContext(input);
    selected.versionId = V2;
    expect(captured.selected?.versionId).toBe(V1);
    expect(captured.visible).toEqual([{ kind: "artifact", id: A, versionId: V1 }]);
    expect(captured.schemaVersion).toBe(1);
  });
});
