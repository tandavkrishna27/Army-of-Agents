import { describe, expect, it } from "vitest";
import type { ResolvedUniverseContext } from "@armyofagents/shared";
import { formatResolvedUniverseContext } from "../services/internal-agent/universe-context-format.js";

describe("formatResolvedUniverseContext", () => {
  it("describes available and superseded references without exposing unavailable labels", () => {
    const context: ResolvedUniverseContext = {
      schemaVersion: 1,
      conversationId: "10000000-0000-4000-8000-000000000001",
      selected: {
        reference: { kind: "artifact", id: "20000000-0000-4000-8000-000000000001", versionId: "30000000-0000-4000-8000-000000000001" },
        disposition: "superseded",
        label: "Launch brief",
        currentVersionId: "30000000-0000-4000-8000-000000000002",
      },
      visible: [{
        reference: { kind: "task", id: "40000000-0000-4000-8000-000000000001" },
        disposition: "unavailable",
      }],
      viewport: { width: 1200, height: 800, x: 1, y: 2, zoom: 1 },
    };
    const text = formatResolvedUniverseContext(context);
    expect(text).toContain("Launch brief");
    expect(text).toContain("superseded");
    expect(text).toContain("unavailable");
    expect(text).not.toContain("undefined");
  });
});
