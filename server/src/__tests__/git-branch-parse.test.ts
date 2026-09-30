import { describe, it, expect } from "vitest";
import { isSkippableRef } from "../services/git";

describe("branch ref skip rule", () => {
  it("skips the bare remote HEAD symref 'origin'", () => {
    expect(isSkippableRef("origin")).toBe(true);
  });
  it("skips origin/HEAD and other <remote>/HEAD pointers", () => {
    expect(isSkippableRef("origin/HEAD")).toBe(true);
    expect(isSkippableRef("upstream/HEAD")).toBe(true);
  });
  it("keeps real branches", () => {
    expect(isSkippableRef("main")).toBe(false);
    expect(isSkippableRef("origin/main")).toBe(false);
    expect(isSkippableRef("feat/notifications-page")).toBe(false);
  });
});
