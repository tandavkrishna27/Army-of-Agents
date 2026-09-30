import { describe, expect, it } from "vitest";
import { deriveAuthTrustedOrigins } from "../auth/better-auth.js";

describe("server startup auth port wiring", () => {
  it("trusted origins include the actual listenPort when port shifts", () => {
    const config = {
      deploymentMode: "authenticated" as const,
      port: 3100,
      allowedHostnames: ["worktree.example.ts.net"],
    } as any;
    const listenPort = 3101;
    const origins = deriveAuthTrustedOrigins(config, { listenPort });
    expect(origins).toContain("https://worktree.example.ts.net:3101");
    expect(origins).not.toContain("https://worktree.example.ts.net:3100");
  });
});
