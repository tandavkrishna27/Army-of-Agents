import { describe, it, expect, vi } from "vitest";
import { getPrReviewState } from "../services/github-pr.js";

// Minimal octokit stub — getPrReviewState only calls pulls.listReviews.
// GitHub returns reviews OLDEST-first; these arrays are in chronological order.
function octokitWith(reviews: Array<{ user?: { login: string }; state: string }>) {
  return { pulls: { listReviews: vi.fn().mockResolvedValue({ data: reviews }) } } as never;
}

describe("getPrReviewState — latest decision per reviewer (GitHub lists oldest-first)", () => {
  it("short-circuits merged / closed / draft before fetching reviews", async () => {
    expect(await getPrReviewState(octokitWith([]), "o", "r", 1, false, "merged")).toBe("merged");
    expect(await getPrReviewState(octokitWith([]), "o", "r", 1, false, "closed")).toBe("closed");
    expect(await getPrReviewState(octokitWith([]), "o", "r", 1, true, "open")).toBe("draft");
  });

  it("keeps the LATEST decision when a reviewer flips CHANGES_REQUESTED -> APPROVED", async () => {
    const ok = octokitWith([
      { user: { login: "alice" }, state: "CHANGES_REQUESTED" },
      { user: { login: "alice" }, state: "APPROVED" },
    ]);
    expect(await getPrReviewState(ok, "o", "r", 1, false, "open")).toBe("approved");
  });

  it("a trailing COMMENTED review does not erase an approval", async () => {
    const ok = octokitWith([
      { user: { login: "alice" }, state: "APPROVED" },
      { user: { login: "alice" }, state: "COMMENTED" },
    ]);
    expect(await getPrReviewState(ok, "o", "r", 1, false, "open")).toBe("approved");
  });

  it("any reviewer whose latest decision is CHANGES_REQUESTED blocks", async () => {
    const ok = octokitWith([
      { user: { login: "alice" }, state: "APPROVED" },
      { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
    ]);
    expect(await getPrReviewState(ok, "o", "r", 1, false, "open")).toBe("changes_requested");
  });

  it("DISMISSED clears a reviewer's prior decision", async () => {
    const ok = octokitWith([
      { user: { login: "alice" }, state: "CHANGES_REQUESTED" },
      { user: { login: "alice" }, state: "DISMISSED" },
    ]);
    expect(await getPrReviewState(ok, "o", "r", 1, false, "open")).toBe("open");
  });
});
