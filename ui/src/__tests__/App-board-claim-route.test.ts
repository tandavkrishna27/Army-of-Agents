import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readAppSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      process.cwd().endsWith("ui") ? "src/App.tsx" : "ui/src/App.tsx",
    ),
    "utf8",
  );
}

describe("headless board-claim route", () => {
  it("keeps the claim page reachable outside the authenticated app gate", () => {
    const source = readAppSource();
    const route = '<Route path="board-claim/:token" element={<BoardClaimPage />} />';
    const gate = '<Route element={<CloudAccessGate />}>';

    expect(source).toContain('import { BoardClaimPage } from "./pages/BoardClaim";');
    expect(source).toContain(route);
    expect(source.indexOf(route)).toBeLessThan(source.indexOf(gate));
  });
});
