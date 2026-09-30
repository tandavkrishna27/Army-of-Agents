import { describe, expect, it } from "vitest";
import { requiresBoardSession } from "../authGate";

describe("requiresBoardSession", () => {
  it("requires a session for authenticated deployments", () => {
    expect(requiresBoardSession({ status: "ok", deploymentMode: "authenticated" })).toBe(true);
  });

  it("requires a session when local_trusted has the real auth stack ready", () => {
    expect(
      requiresBoardSession({ status: "ok", deploymentMode: "local_trusted", authReady: true }),
    ).toBe(true);
  });

  it("keeps compatibility with local_trusted servers that do not advertise auth readiness", () => {
    expect(requiresBoardSession({ status: "ok", deploymentMode: "local_trusted" })).toBe(false);
  });
});
