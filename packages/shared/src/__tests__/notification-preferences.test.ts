import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesSchema,
  updateNotificationPreferencesSchema,
} from "../notification-preferences.js";

describe("notification preferences", () => {
  it("returns realtime toast defaults for every semantic type", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES.rules.length).toBeGreaterThan(0);
    expect(
      DEFAULT_NOTIFICATION_PREFERENCES.rules.every((rule) => rule.deliveryMode === "realtime"),
    ).toBe(true);
    expect(
      DEFAULT_NOTIFICATION_PREFERENCES.rules.every((rule) => rule.toastEnabled === true),
    ).toBe(true);
  });

  it("rejects duplicate semantic type rules", () => {
    const [first] = DEFAULT_NOTIFICATION_PREFERENCES.rules;
    expect(() =>
      updateNotificationPreferencesSchema.parse({
        rules: [first, first],
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects invalid quiet-hours clock values", () => {
    expect(() =>
      notificationPreferencesSchema.parse({
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        quietHours: { enabled: true, start: "25:00", end: "09:00", timezone: "UTC" },
      }),
    ).toThrow();
  });

  it("rejects invalid IANA timezones", () => {
    expect(() =>
      notificationPreferencesSchema.parse({
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "Mars/Base" },
      }),
    ).toThrow(/timezone/i);
  });

  it("requires complete nested quiet-hours objects in patches", () => {
    expect(() =>
      updateNotificationPreferencesSchema.parse({
        quietHours: { enabled: true },
      }),
    ).toThrow();
  });
});
