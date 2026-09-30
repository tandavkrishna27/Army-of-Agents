import { describe, expect, it } from "vitest";
import {
  tierForItem,
  resolveWriteDisposition,
} from "../services/memory-tier-policy.js";

describe("tierForItem", () => {
  it("maps layers to tiers", () => {
    expect(tierForItem({ layer: "identity" })).toBe("protected");
    expect(tierForItem({ layer: "working" })).toBe("ephemeral");
    expect(tierForItem({ layer: "domain" })).toBe("durable");
    expect(tierForItem({ layer: "active_context" })).toBe("durable");
    expect(tierForItem({ layer: null })).toBe("durable");
  });

  it("prefers an explicit valid tier override", () => {
    expect(tierForItem({ layer: "working", tier: "protected" })).toBe("protected");
    expect(tierForItem({ layer: "domain", tier: "bogus" })).toBe("durable"); // invalid → derive
  });
});

describe("resolveWriteDisposition", () => {
  it("protected is always human", () => {
    for (const lvl of ["manual", "supervised", "trusted", "policy"] as const) {
      expect(resolveWriteDisposition("protected", lvl)).toBe("human");
    }
  });

  it("derived and ephemeral are always auto", () => {
    for (const lvl of ["manual", "supervised", "trusted", "policy"] as const) {
      expect(resolveWriteDisposition("derived", lvl)).toBe("auto");
      expect(resolveWriteDisposition("ephemeral", lvl)).toBe("auto");
    }
  });

  it("consolidation is propose until trusted, then auto", () => {
    expect(resolveWriteDisposition("consolidation", "manual")).toBe("propose");
    expect(resolveWriteDisposition("consolidation", "supervised")).toBe("propose");
    expect(resolveWriteDisposition("consolidation", "trusted")).toBe("auto");
    expect(resolveWriteDisposition("consolidation", "policy")).toBe("auto");
  });

  it("durable escalates manual→human, supervised/trusted→propose, policy→auto", () => {
    expect(resolveWriteDisposition("durable", "manual")).toBe("human");
    expect(resolveWriteDisposition("durable", "supervised")).toBe("propose");
    expect(resolveWriteDisposition("durable", "trusted")).toBe("propose");
    expect(resolveWriteDisposition("durable", "policy")).toBe("auto");
  });

  it("durable at trusted auto-approves only a promoted class", () => {
    expect(resolveWriteDisposition("durable", "trusted", { classPromoted: true })).toBe("auto");
    expect(resolveWriteDisposition("durable", "manual", { classPromoted: true })).toBe("human");
  });
});
