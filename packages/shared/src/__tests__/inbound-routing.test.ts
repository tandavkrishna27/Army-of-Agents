import { describe, it, expect } from "vitest";
import { INBOUND_ROUTING_LEVELS, isValidRoutingLevel, routingLevelLabel } from "../inbound-routing.js";

describe("inbound routing dial", () => {
  it("has off/suggest/auto_attach/full_auto in order", () => {
    expect(INBOUND_ROUTING_LEVELS.map(l => l.value)).toEqual(["off", "suggest", "auto_attach", "full_auto"]);
    expect(INBOUND_ROUTING_LEVELS.map(l => l.name)).toEqual(["Off", "Suggest", "Auto-attach", "Full-auto"]);
  });

  it("routingLevelLabel resolves; default-ish unknown → 'Off'", () => {
    expect(routingLevelLabel("auto_attach")).toBe("Auto-attach");
    expect(routingLevelLabel(null)).toBe("Off");
    expect(routingLevelLabel("nope")).toBe("Off");
  });

  it("isValidRoutingLevel rejects unknown", () => {
    expect(isValidRoutingLevel("suggest")).toBe(true);
    expect(isValidRoutingLevel("nope")).toBe(false);
    expect(isValidRoutingLevel(2)).toBe(false);
  });
});
