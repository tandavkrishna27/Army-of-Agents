import { describe, expect, it } from "vitest";
import { formatDoctorJson } from "../commands/doctor.js";

describe("aoa doctor JSON contract", () => {
  it("emits a stable, serializable schema without repair functions", () => {
    const report = formatDoctorJson(
      [
        { name: "Config", status: "pass", message: "Valid." },
        {
          name: "Provider",
          status: "warn",
          message: "Skipped.",
          repairHint: "Run online.",
          repair: async () => undefined,
        },
      ],
      true,
    );

    expect(report).toEqual({
      schemaVersion: 1,
      command: "aoa doctor",
      offline: true,
      status: "needs_attention",
      summary: { passed: 1, warned: 1, failed: 0 },
      checks: [
        { name: "Config", status: "pass", message: "Valid." },
        {
          name: "Provider",
          status: "warn",
          message: "Skipped.",
          repairHint: "Run online.",
        },
      ],
    });
    expect(Object.hasOwn(report.checks[1]!, "repair")).toBe(false);
  });
});
