import { describe, it, expect, vi } from "vitest";
import { installStdoutGuard } from "../mcp-bridge.js";

describe("stdout guard", () => {
  it("reroutes console.log to stderr so it cannot corrupt protocol frames", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const restore = installStdoutGuard();
    console.log("stray log");
    expect(errSpy).toHaveBeenCalled(); // went to stderr, not stdout
    restore();
    errSpy.mockRestore();
  });
});
