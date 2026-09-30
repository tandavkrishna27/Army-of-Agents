import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LobbyOrOnboardingRedirect invitation handoff", () => {
  it("passes returning users' pending invitations into Lobby", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        process.cwd().endsWith("ui") ? "src/App.tsx" : "ui/src/App.tsx",
      ),
      "utf8",
    );
    expect(source).toContain(
      "<Lobby pendingInvitations={data?.pendingInvitations ?? []} />",
    );
  });
});
