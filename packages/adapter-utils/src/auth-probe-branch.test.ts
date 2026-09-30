import { describe, expect, it, vi } from "vitest";
import { runAuthStatusAndBranch } from "./auth-probe-branch.js";

function baseOpts(runStatus: () => Promise<{ loggedIn: boolean; account: string | null }>) {
  return {
    runStatus,
    codes: { expired: "x_auth_expired", required: "x_auth_required" },
    copy: {
      expiredWithAccount: (a: string) => `Signed in as ${a}, but that session has expired.`,
      expiredNoAccount: "Your sign-in has expired.",
      required: "Not signed in yet.",
    },
    hints: { expired: "Sign in again.", required: "Run the login command." },
  };
}

describe("runAuthStatusAndBranch", () => {
  it("returns the expired check with account when status reports logged in with an account", async () => {
    const check = await runAuthStatusAndBranch(
      baseOpts(async () => ({ loggedIn: true, account: "ada@example.com" })),
    );
    expect(check).toMatchObject({
      code: "x_auth_expired",
      level: "warn",
      message: "Signed in as ada@example.com, but that session has expired.",
      hint: "Sign in again.",
    });
  });

  it("returns the expired check with account-less copy when status has no account", async () => {
    const check = await runAuthStatusAndBranch(baseOpts(async () => ({ loggedIn: true, account: null })));
    expect(check).toMatchObject({
      code: "x_auth_expired",
      message: "Your sign-in has expired.",
    });
  });

  it("returns the required check when status reports logged out", async () => {
    const check = await runAuthStatusAndBranch(baseOpts(async () => ({ loggedIn: false, account: null })));
    expect(check).toMatchObject({
      code: "x_auth_required",
      level: "warn",
      message: "Not signed in yet.",
      hint: "Run the login command.",
    });
  });

  it("degrades to the required check, without throwing, when runStatus rejects", async () => {
    const runStatus = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });
    const check = await runAuthStatusAndBranch(baseOpts(runStatus));
    expect(check.code).toBe("x_auth_required");
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  it("includes detail on both branches when provided", async () => {
    const opts = { ...baseOpts(async () => ({ loggedIn: true, account: null })), detail: "raw probe line" };
    const check = await runAuthStatusAndBranch(opts);
    expect(check.detail).toBe("raw probe line");
  });

  it("omits detail when not provided", async () => {
    const check = await runAuthStatusAndBranch(baseOpts(async () => ({ loggedIn: false, account: null })));
    expect(check.detail).toBeUndefined();
  });
});
