import { describe, it, expect } from "vitest";
import { coerceQueueRowTimestamps } from "../services/embeddings-row-utils.js";

describe("coerceQueueRowTimestamps", () => {
  it("converts postgres.js string timestamps to Date", () => {
    const row = {
      id: "q1",
      createdAt: "2026-06-27 14:12:18.187703+00",
      updatedAt: "2026-06-27 14:12:18.187703+00",
      nextRetryAt: "2026-06-27 15:00:00+00",
    };
    const out = coerceQueueRowTimestamps(row);
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.updatedAt).toBeInstanceOf(Date);
    expect(out.nextRetryAt).toBeInstanceOf(Date);
    // Critical: a Date HAS toISOString (the method Drizzle gt() invokes on the
    // value bound to a timestamp column — the exact thing that crashed).
    expect(typeof (out.createdAt as Date).toISOString).toBe("function");
  });

  it("leaves null/undefined timestamps untouched", () => {
    const out = coerceQueueRowTimestamps({
      id: "q2",
      createdAt: "2026-06-27 00:00:00+00",
      updatedAt: null,
      nextRetryAt: undefined,
    });
    expect(out.nextRetryAt ?? null).toBeNull();
    expect(out.updatedAt ?? null).toBeNull();
    expect(out.createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent when the field is already a Date", () => {
    const d = new Date("2026-06-27T00:00:00.000Z");
    const out = coerceQueueRowTimestamps({
      id: "q3",
      createdAt: d,
      updatedAt: d,
      nextRetryAt: d,
    });
    expect((out.createdAt as Date).getTime()).toBe(d.getTime());
  });

  it("preserves non-timestamp fields verbatim", () => {
    const out = coerceQueueRowTimestamps({
      id: "q4",
      companyId: "c1",
      inputText: "hello",
      attempts: 2,
      createdAt: "2026-06-27 00:00:00+00",
      updatedAt: null,
      nextRetryAt: null,
    });
    expect(out.id).toBe("q4");
    expect(out.companyId).toBe("c1");
    expect(out.inputText).toBe("hello");
    expect(out.attempts).toBe(2);
  });
});
