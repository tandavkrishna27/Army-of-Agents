import { describe, expect, it } from "vitest";
import { createLimiter } from "../services/internal-agent/subagents/concurrency-limiter.js";

describe("createLimiter", () => {
  it("never exceeds max concurrent and releases on success AND on throw", async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = (fail: boolean) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error("boom");
      });

    await Promise.allSettled([job(false), job(true), job(false), job(false), job(true)]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0); // all released, including the throwing ones
  });

  it("queues excess work and eventually runs all of it", async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 1));
        }),
      ),
    );
    expect(order.sort()).toEqual([1, 2, 3]); // none dropped
  });
});
