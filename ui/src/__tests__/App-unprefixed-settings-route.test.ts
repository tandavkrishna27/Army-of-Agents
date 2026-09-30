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

describe("unprefixed Settings route", () => {
  it("redirects through the selected Company before the dynamic prefix route", () => {
    const source = readAppSource();
    const route = '<Route path="settings" element={<UnprefixedBoardRedirect />} />';
    const dynamicPrefix = '<Route path=":companyPrefix" element={<Layout />}>';

    expect(source).toContain(route);
    expect(source.indexOf(route)).toBeLessThan(source.indexOf(dynamicPrefix));
  });
});
