import { describe, expect, it } from "vitest";
import {
  EXECUTION_TARGET_KINDS,
  EXECUTION_TARGET_TRUST_CLASSES,
  EXECUTION_TARGET_STATUSES,
  ORG_MAX_CONCURRENT_RUNS_DEFAULT,
  ORG_MAX_CONCURRENT_RUNS_MAX,
} from "./constants.js";

describe("execution target constants", () => {
  it("enumerates the beta kinds incl. the inert desktop seam", () => {
    expect(EXECUTION_TARGET_KINDS).toEqual([
      "pooled_gvisor",
      "dedicated_worker",
      "e2b",
      "local_host",
      "desktop",
    ]);
  });
  it("enumerates trust classes and statuses", () => {
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("shared_multitenant");
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("dedicated_tenant");
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("local_trusted");
    expect(EXECUTION_TARGET_STATUSES).toEqual(["active", "draining", "offline", "disabled"]);
  });
  it("sets a light org concurrency default below the max", () => {
    expect(ORG_MAX_CONCURRENT_RUNS_DEFAULT).toBe(8);
    expect(ORG_MAX_CONCURRENT_RUNS_MAX).toBe(200);
    expect(ORG_MAX_CONCURRENT_RUNS_DEFAULT).toBeLessThan(ORG_MAX_CONCURRENT_RUNS_MAX);
  });
});
