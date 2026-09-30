import { describe, it, expect } from "vitest";
import type { CompanyStats } from "@/api/companies";

type StatsValue = CompanyStats[string];

type Required = {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;
  unreadNotificationCount: number;
};

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;

const _typeAssert: Equals<StatsValue, Required> = true;

describe("CompanyStats type", () => {
  it("each company entry has the four canonical count fields", () => {
    void _typeAssert;
    const entry: StatsValue = {
      agentCount: 7,
      issueCount: 24,
      pendingApprovalCount: 3,
      unreadNotificationCount: 12,
    };
    expect(entry.pendingApprovalCount).toBe(3);
    expect(entry.unreadNotificationCount).toBe(12);
  });
});
