import { describe, it, expect } from "vitest";
import { TeamDetail } from "../pages/TeamDetail";

describe("TeamDetail — module import", () => {
  it("exports the component", () => {
    expect(typeof TeamDetail).toBe("function");
  });
});
