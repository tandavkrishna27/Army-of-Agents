import { describe, expect, it } from "vitest";
import { resolveCrewInstallDeadlineMs } from "../services/marketplace-install/crew-install-deadline.js";

describe("resolveCrewInstallDeadlineMs", () => {
  it("uses the existing 30-second default when unset", () => {
    expect(resolveCrewInstallDeadlineMs(undefined)).toBe(30_000);
  });

  it("accepts a valid bounded override for slow first-time installs", () => {
    expect(resolveCrewInstallDeadlineMs("90000")).toBe(90_000);
  });

  it.each(["0", "29999", "120001", "NaN", "1e9", "-1"])(
    "falls back to the safe default for invalid override %s",
    (value) => expect(resolveCrewInstallDeadlineMs(value)).toBe(30_000),
  );
});
