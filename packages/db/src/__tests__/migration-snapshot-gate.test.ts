import { describe, expect, it, vi } from "vitest";
import {
  assertMigrationSnapshotGate,
  isUndefinedTableError,
  readCompanyCountForSnapshotGate,
  readRecordedSnapshotsForSnapshotGate,
  shouldBlockForMissingSnapshot,
  SnapshotGateError,
} from "../migration-snapshot-gate.js";

describe("migration snapshot gate database reads", () => {
  it.each([
    ["direct", Object.assign(new Error("missing"), { code: "42P01" })],
    ["wrapped", { cause: Object.assign(new Error("missing"), { code: "42P01" }) }],
    ["nested", { cause: { cause: { code: "42P01" } } }],
  ])("recognizes %s undefined-table errors", (_label, error) => {
    expect(isUndefinedTableError(error)).toBe(true);
  });

  it.each(["42501", "08006", "57014"])(
    "does not classify SQLSTATE %s as a fresh schema",
    (code) => {
      expect(isUndefinedTableError({ code })).toBe(false);
    },
  );

  it("handles cyclic causes without hanging or misclassifying", () => {
    const error: { code: string; cause?: unknown } = { code: "08006" };
    error.cause = error;
    expect(isUndefinedTableError(error)).toBe(false);
  });

  it("returns zero only when the companies table is genuinely absent", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    await expect(
      readCompanyCountForSnapshotGate(async () => Promise.reject(missing)),
    ).resolves.toBe(0);
  });

  it.each(["42501", "08006", "57014"])(
    "rethrows company-count SQLSTATE %s instead of bypassing the gate",
    async (code) => {
      const error = Object.assign(new Error(`database error ${code}`), { code });
      await expect(
        readCompanyCountForSnapshotGate(async () => Promise.reject(error)),
      ).rejects.toBe(error);
    },
  );

  it("reads populated counts from direct and driver-wrapped row shapes", async () => {
    await expect(readCompanyCountForSnapshotGate(async () => [{ count: 5 }])).resolves.toBe(5);
    await expect(
      readCompanyCountForSnapshotGate(async () => ({ rows: [{ count: "7" }] })),
    ).resolves.toBe(7);
  });

  it.each([
    undefined,
    [],
    { rows: [] },
    { rows: [{ count: null }] },
    { rows: [{ count: "" }] },
    { rows: [{ count: false }] },
    { rows: [{ count: "not-a-number" }] },
  ])("rejects malformed company count %#", async (result) => {
    await expect(readCompanyCountForSnapshotGate(async () => result)).rejects.toThrow(
      "Could not read a valid companies count",
    );
  });

  it("reads and validates durable snapshot markers", async () => {
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => [
        { general: { migrationSnapshots: ["0188"] } },
      ]),
    ).resolves.toEqual(["0188"]);
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => ({ rows: [{ general: {} }] })),
    ).resolves.toEqual([]);
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => [
        { general: { migrationSnapshots: "0188" } },
      ]),
    ).rejects.toThrow("Could not read migration snapshot markers");
  });

  it("treats only a missing instance_settings table as no marker", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => Promise.reject(missing)),
    ).resolves.toEqual([]);
    const denied = Object.assign(new Error("permission denied"), { code: "42501" });
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => Promise.reject(denied)),
    ).rejects.toBe(denied);
  });

  it("fails closed if the canonical settings query returns more than one row", async () => {
    await expect(
      readRecordedSnapshotsForSnapshotGate(async () => [
        { general: { migrationSnapshots: ["0188"] } },
        { general: {} },
      ]),
    ).rejects.toThrow("unique canonical instance settings row");
  });
});

describe("shouldBlockForMissingSnapshot", () => {
  const base = {
    deploymentMode: "cloud_auth" as const,
    pendingMigrationTags: ["0188_organizations.sql"],
    companyCount: 5,
    recordedSnapshots: [] as string[],
  };

  it("blocks cloud_auth + populated + 0188 pending + no snapshot", () => {
    expect(shouldBlockForMissingSnapshot(base)).toBe(true);
  });

  it("blocks unknown deployment context instead of defaulting to trusted", () => {
    expect(
      shouldBlockForMissingSnapshot({ ...base, deploymentMode: "unknown" }),
    ).toBe(true);
  });

  it("allows once the 0188 snapshot marker is recorded", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, recordedSnapshots: ["0188"] })).toBe(false);
  });

  it("allows on an empty companies table", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, companyCount: 0 })).toBe(false);
  });

  it("no-ops for explicit self-hosted deployment modes", () => {
    expect(
      shouldBlockForMissingSnapshot({ ...base, deploymentMode: "local_trusted" }),
    ).toBe(false);
    expect(
      shouldBlockForMissingSnapshot({ ...base, deploymentMode: "authenticated" }),
    ).toBe(false);
  });

  it("allows when 0188 is not pending", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, pendingMigrationTags: [] })).toBe(false);
  });
});

describe("assertMigrationSnapshotGate", () => {
  it("blocks an unknown manual caller before migration apply", async () => {
    await expect(
      assertMigrationSnapshotGate({
        pendingMigrationTags: ["0188_organizations.sql"],
        queryCompanyCount: async () => [{ count: 2 }],
        queryRecordedSnapshots: async () => [{ general: {} }],
      }),
    ).rejects.toBeInstanceOf(SnapshotGateError);
  });

  it("allows an unknown manual caller after the marker is recorded", async () => {
    await expect(
      assertMigrationSnapshotGate({
        pendingMigrationTags: ["0188_organizations.sql"],
        queryCompanyCount: async () => [{ count: 2 }],
        queryRecordedSnapshots: async () => [
          { general: { migrationSnapshots: ["0188"] } },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it("does no database work for explicit self-hosted mode or unrelated migrations", async () => {
    const queryCompanyCount = vi.fn();
    const queryRecordedSnapshots = vi.fn();
    await assertMigrationSnapshotGate({
      deploymentMode: "authenticated",
      pendingMigrationTags: ["0188_organizations.sql"],
      queryCompanyCount,
      queryRecordedSnapshots,
    });
    await assertMigrationSnapshotGate({
      deploymentMode: "cloud_auth",
      pendingMigrationTags: ["0198_ambitious_lilandra.sql"],
      queryCompanyCount,
      queryRecordedSnapshots,
    });
    expect(queryCompanyCount).not.toHaveBeenCalled();
    expect(queryRecordedSnapshots).not.toHaveBeenCalled();
  });
});
