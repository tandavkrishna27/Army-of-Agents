import { describe, it, expect } from "vitest";
import { prunePresence, type PresenceEntry } from "../services/live-events.js";

// Plan 7 Task 5: ephemeral presence — entries older than the TTL are dropped.
describe("prunePresence", () => {
  it("drops entries older than the TTL", () => {
    const now = 10_000;
    const out = prunePresence(
      [
        { userId: "u1", lastSeen: 9_000 },
        { userId: "u2", lastSeen: 1_000 },
      ],
      now,
      5_000,
    );
    expect(out.map((e) => e.userId)).toEqual(["u1"]);
  });

  it("keeps entries exactly at the TTL boundary", () => {
    const now = 10_000;
    const out: PresenceEntry[] = prunePresence(
      [{ userId: "edge", lastSeen: 5_000 }],
      now,
      5_000,
    );
    expect(out.map((e) => e.userId)).toEqual(["edge"]);
  });

  it("returns an empty list when all entries are stale", () => {
    expect(prunePresence([{ userId: "old", lastSeen: 0 }], 100_000, 1_000)).toEqual([]);
  });

  it("preserves the typing flag on surviving entries", () => {
    const out = prunePresence(
      [{ userId: "t", lastSeen: 9_999, typing: true }],
      10_000,
      5_000,
    );
    expect(out[0].typing).toBe(true);
  });
});
