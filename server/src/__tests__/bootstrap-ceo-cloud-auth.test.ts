import { describe, it, expect } from "vitest";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";

describe("bootstrapCeoPromotionAllowed", () => {
  it("blocks bootstrap_ceo promotion in cloud_auth", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });
  it("allows it self-hosted", () => {
    expect(bootstrapCeoPromotionAllowed("authenticated")).toBe(true);
    expect(bootstrapCeoPromotionAllowed("local_trusted")).toBe(true);
  });
});
