import { describe, expect, it } from "vitest";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./index.js";

describe("worker protocol package", () => {
  it("exports the initial version range", () => {
    expect(MIN_PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
