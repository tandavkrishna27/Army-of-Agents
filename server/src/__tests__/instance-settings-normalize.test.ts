import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@armyofagents/shared";

describe("instanceGeneralSettingsSchema (Phase A.7 fields)", () => {
  it("applies AoA privacy-first defaults on empty input", () => {
    const parsed = instanceGeneralSettingsSchema.parse({});
    expect(parsed.censorUsernameInLogs).toBe(false);
    expect(parsed.keyboardShortcuts).toBe(false);
    expect(parsed.feedbackDataSharingPreference).toBe("not_allowed");
    expect(DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE).toBe("not_allowed");
    expect(parsed.backupRetention).toEqual(DEFAULT_BACKUP_RETENTION);
    expect(parsed.backupRetention).toEqual({ dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 });
  });

  it("accepts all 3 valid feedbackDataSharingPreference values", () => {
    for (const value of ["allowed", "not_allowed", "prompt"] as const) {
      expect(() =>
        instanceGeneralSettingsSchema.parse({ feedbackDataSharingPreference: value }),
      ).not.toThrow();
    }
  });

  it("rejects unknown feedbackDataSharingPreference", () => {
    const result = instanceGeneralSettingsSchema.safeParse({ feedbackDataSharingPreference: "disabled" });
    expect(result.success).toBe(false);
  });

  it("accepts each valid backupRetention preset", () => {
    for (const dailyDays of [3, 7, 14] as const) {
      for (const weeklyWeeks of [1, 2, 4] as const) {
        for (const monthlyMonths of [1, 3, 6] as const) {
          const result = instanceGeneralSettingsSchema.safeParse({
            backupRetention: { dailyDays, weeklyWeeks, monthlyMonths },
          });
          expect(result.success).toBe(true);
        }
      }
    }
  });

  it("rejects non-preset backupRetention values", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: 5, weeklyWeeks: 4, monthlyMonths: 1 },
      }).success,
    ).toBe(false);
    expect(
      instanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: 7, weeklyWeeks: 3, monthlyMonths: 1 },
      }).success,
    ).toBe(false);
    expect(
      instanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 12 },
      }).success,
    ).toBe(false);
  });

  it("rejects negative backupRetention values", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: -1, weeklyWeeks: 4, monthlyMonths: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects non-numeric backupRetention values", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: "seven", weeklyWeeks: 4, monthlyMonths: 1 },
      }).success,
    ).toBe(false);
  });

  it("patch schema accepts partial updates for each new field", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ keyboardShortcuts: true }).success).toBe(true);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ feedbackDataSharingPreference: "prompt" }).success,
    ).toBe(true);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({
        backupRetention: { dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 6 },
      }).success,
    ).toBe(true);
  });

  it("strict schema rejects unknown fields", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({ someUnknownField: true }).success,
    ).toBe(false);
  });
});
