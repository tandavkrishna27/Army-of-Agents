import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// C3 structural backstop: prevents future regressions where the
// onSuccess invalidate set drops projects.agents() and reintroduces
// the stale dept-agent dropdown bug.
//
// We don't run the form behaviorally here — wiring up
// QueryClientProvider + render + fill + submit for a 1-line invalidate
// assertion is overkill. The structural test is the same pattern used
// for the RBAC source-structural backstops (teams-routes-rbac.test.ts).

describe("Team-create flows invalidate dept-agents cache (C3 backstop)", () => {
  it("BuildFromScratchForm onSuccess invalidates projects.agents()", () => {
    const src = readFileSync(
      resolve(__dirname, "../BuildFromScratchForm.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });

  it("ImportPreviewDialog onSuccess invalidates projects.agents()", () => {
    const src = readFileSync(
      resolve(__dirname, "../ImportPreviewDialog.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });

  it("ImportPreviewDialog onSuccess invalidates the full team-create set", () => {
    // Task 11 originally only invalidated teams.list. C3 fixup expanded
    // to match BuildFromScratchForm. Assert all 4 keys appear.
    const src = readFileSync(
      resolve(__dirname, "../ImportPreviewDialog.tsx"),
      "utf8",
    );
    expect(src).toMatch(/queryKeys\.teams\.list\(/);
    expect(src).toMatch(/queryKeys\.agents\.list\(/);
    expect(src).toMatch(/queryKeys\.projects\.list\(/);
    expect(src).toMatch(/queryKeys\.projects\.agents\(/);
  });
});
