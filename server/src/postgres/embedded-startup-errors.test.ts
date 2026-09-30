import { describe, expect, it } from "vitest";
import { formatEmbeddedPostgresStartupError } from "./embedded-startup-errors.js";

describe("formatEmbeddedPostgresStartupError", () => {
  it("explains how to recover from an existing cluster with mismatched credentials", () => {
    const error = Object.assign(new Error('password authentication failed for user "aoa"'), { code: "28P01" });

    expect(formatEmbeddedPostgresStartupError(error, "C:/aoa/instances/default/db")).toContain(
      "existing embedded PostgreSQL cluster",
    );
    expect(formatEmbeddedPostgresStartupError(error, "C:/aoa/instances/default/db")).toContain(
      "preserve the data directory",
    );
  });

  it("preserves the original message for unrelated startup failures", () => {
    expect(formatEmbeddedPostgresStartupError(new Error("port unavailable"), "C:/aoa/db")).toBe(
      "port unavailable",
    );
  });
});
