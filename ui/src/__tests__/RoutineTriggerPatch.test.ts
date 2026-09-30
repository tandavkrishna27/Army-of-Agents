import { describe, expect, it } from "vitest";
import type { RoutineTrigger } from "@armyofagents/shared";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";

function makeScheduleTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: "Daily",
    enabled: true,
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    nextRunAt: null,
    lastFiredAt: null,
    publicId: "pub-1",
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
    ...overrides,
  };
}

function makeWebhookTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    ...makeScheduleTrigger(),
    kind: "webhook",
    cronExpression: null,
    timezone: null,
    signingMode: "hmac_sha256",
    replayWindowSec: 300,
    ...overrides,
  };
}

describe("buildRoutineTriggerPatch — schedule triggers", () => {
  it("preserves an existing schedule trigger timezone when saving edits", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: "UTC" }),
      {
        label: "Daily label edit",
        cronExpression: "0 10 * * *",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: "Daily label edit",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    });
  });

  it("falls back to the local timezone when a schedule trigger has none", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: null }),
      {
        label: "",
        cronExpression: "15 9 * * 1-5",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: null,
      cronExpression: "15 9 * * 1-5",
      timezone: "America/Chicago",
    });
  });

  it("trims whitespace from label and sets null for empty", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger(),
      {
        label: "   ",
        cronExpression: "0 10 * * *",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "UTC",
    );

    expect(patch.label).toBeNull();
  });

  it("includes a non-empty trimmed label", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger(),
      {
        label: "  Weekly sync  ",
        cronExpression: "0 9 * * 1",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "UTC",
    );

    expect(patch.label).toBe("Weekly sync");
  });
});

describe("buildRoutineTriggerPatch — webhook triggers", () => {
  it("includes signingMode and numeric replayWindowSec for webhook triggers", () => {
    const patch = buildRoutineTriggerPatch(
      makeWebhookTrigger(),
      {
        label: "My webhook",
        cronExpression: "",
        signingMode: "bearer",
        replayWindowSec: "600",
      },
      "UTC",
    );

    expect(patch).toMatchObject({
      label: "My webhook",
      signingMode: "bearer",
      replayWindowSec: 600,
    });
    expect(patch).not.toHaveProperty("cronExpression");
    expect(patch).not.toHaveProperty("timezone");
  });

  it("defaults replayWindowSec to 300 when field is empty", () => {
    const patch = buildRoutineTriggerPatch(
      makeWebhookTrigger(),
      {
        label: "",
        cronExpression: "",
        signingMode: "hmac_sha256",
        replayWindowSec: "",
      },
      "UTC",
    );

    expect(patch.replayWindowSec).toBe(300);
  });
});
