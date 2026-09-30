import { describe, it, expect } from "vitest";
import { resolveCrewRole } from "../services/internal-agent/aoa-agents/resolve-crew-role.js";
function makeDb(rows: Array<{ config: Record<string, unknown> | null }>) {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) } as any;
}
describe("resolveCrewRole", () => {
  it("returns the first VALID CrewRole found across the agent's triggers", async () => {
    expect(await resolveCrewRole(makeDb([{ config: { role: "engineer" } }]), "a1")).toBe("engineer");
  });
  it("recognizes the Steward role so sweep wakeups pass the dispatcher autonomy gate", async () => {
    expect(await resolveCrewRole(makeDb([{ config: { role: "steward" } }]), "steward-1")).toBe("steward");
  });
  it("returns null when no trigger carries a role", async () => {
    expect(await resolveCrewRole(makeDb([{ config: {} }]), "a2")).toBeNull();
  });
  it("returns null for an UNKNOWN role string (e.g. the 'member' template default)", async () => {
    expect(await resolveCrewRole(makeDb([{ config: { role: "member" } }]), "a3")).toBeNull();
    expect(await resolveCrewRole(makeDb([{ config: { role: "typo" } }]), "a4")).toBeNull();
  });
});
