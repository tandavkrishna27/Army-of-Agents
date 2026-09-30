// DEP-011 reaper Slice C — the AM-local metric counter + Prometheus render.
import { describe, expect, it } from "vitest";
import {
  accumulateReaperMetrics,
  createReaperMetrics,
  renderReaperMetrics,
} from "../reaper-metrics.js";

describe("reaper metrics counter", () => {
  it("starts zeroed", () => {
    expect(createReaperMetrics()).toEqual({ reaped: 0, skipped: 0, unknown: 0, failed: 0 });
  });

  it("accumulates each sweep's tally into the shared ref", () => {
    const counter = createReaperMetrics();
    accumulateReaperMetrics(counter, { reaped: 2, skipped: 3, unknown: 1, failed: 0 });
    accumulateReaperMetrics(counter, { reaped: 1, skipped: 0, unknown: 4, failed: 2 });
    expect(counter).toEqual({ reaped: 3, skipped: 3, unknown: 5, failed: 2 });
  });

  it("renders zeros for a fresh (unwired) counter", () => {
    const text = renderReaperMetrics(createReaperMetrics());
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="reaped"} 0');
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="skipped"} 0');
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="unknown"} 0');
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="failed"} 0');
    expect(text).toContain("# TYPE aoa_reaper_sandboxes_total counter");
  });

  it("renders the accumulated tally", () => {
    const counter = createReaperMetrics();
    accumulateReaperMetrics(counter, { reaped: 7, skipped: 2, unknown: 5, failed: 1 });
    const text = renderReaperMetrics(counter);
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="reaped"} 7');
    expect(text).toContain('aoa_reaper_sandboxes_total{outcome="failed"} 1');
  });
});
