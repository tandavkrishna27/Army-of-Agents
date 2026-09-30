import { describe, expect, it } from "vitest";
import { beginUniverseIntakeSchema, universeIntakeSnapshotSchema } from "./universe-intake.js";

describe("Universe intake contracts", () => {
  it("accepts a bounded destination-scoped original", () => {
    expect(beginUniverseIntakeSchema.parse({
      clientKey: "11111111-1111-4111-8111-111111111111",
      destination: { kind: "canvas", conversationId: "22222222-2222-4222-8222-222222222222" },
      filename: "source.txt",
      contentType: "TEXT/PLAIN",
      byteSize: 4,
      sha256: "a".repeat(64),
    }).contentType).toBe("text/plain");
  });

  it("rejects unknown fields and invalid published snapshots", () => {
    expect(() => beginUniverseIntakeSchema.parse({
      clientKey: "11111111-1111-4111-8111-111111111111",
      destination: { kind: "canvas", conversationId: "22222222-2222-4222-8222-222222222222" },
      filename: "source.txt", contentType: "text/plain", byteSize: 4, sha256: "a".repeat(64), extra: true,
    })).toThrow();
    expect(() => universeIntakeSnapshotSchema.parse({
      intakeId: "11111111-1111-4111-8111-111111111111", revision: 1, state: "published",
      receivedParts: [0], expiresAt: new Date().toISOString(), assetId: "not-a-uuid", reason: null,
    })).toThrow();
  });
});
