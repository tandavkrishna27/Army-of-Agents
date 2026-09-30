// ui/src/components/commander/commanderChrome.test.ts
import { describe, it, expect } from "vitest";
import { COMMANDER_PANEL_CARD, COMMANDER_PANEL_ROW } from "./commanderChrome";

describe("commander chrome tokens", () => {
  it("card = rounded + border + shadow, and NOT overflow-hidden (divider safety)", () => {
    expect(COMMANDER_PANEL_CARD).toContain("rounded-xl");
    expect(COMMANDER_PANEL_CARD).toContain("border");
    expect(COMMANDER_PANEL_CARD).toContain("shadow-sm");
    expect(COMMANDER_PANEL_CARD).not.toContain("overflow-hidden");
  });
  it("row = gap + padding + backdrop", () => {
    expect(COMMANDER_PANEL_ROW).toContain("gap-2");
    expect(COMMANDER_PANEL_ROW).toContain("p-2");
    expect(COMMANDER_PANEL_ROW).toContain("bg-muted/30");
  });
});
