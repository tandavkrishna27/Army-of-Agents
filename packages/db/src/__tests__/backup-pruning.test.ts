import { describe, it, expect } from "vitest";
import { pruneOldBackups } from "../backup-lib.js";
import type { BackupRetentionPolicy } from "@armyofagents/shared";

const POLICY: BackupRetentionPolicy = { dailyDays: 7, weeklyWeeks: 2, monthlyMonths: 1 };
const NOW = new Date("2026-04-27T12:00:00Z");

function daysAgo(n: number, hourOffset = 10): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hourOffset, 0, 0, 0);
  return d;
}

function makeBackup(path: string, daysBack: number, hourOffset = 10) {
  return { path, createdAt: daysAgo(daysBack, hourOffset) };
}

describe("pruneOldBackups", () => {
  it("handles empty input", () => {
    const { keep, remove } = pruneOldBackups([], POLICY, NOW);
    expect(keep).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("keeps newest per day in daily tier and removes duplicates", () => {
    const backups = [
      { path: "today-late.sql.gz", createdAt: new Date("2026-04-27T10:00:00Z") },
      { path: "today-early.sql.gz", createdAt: new Date("2026-04-27T05:00:00Z") },
      { path: "yesterday.sql.gz", createdAt: new Date("2026-04-26T10:00:00Z") },
    ];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep).toContain("today-late.sql.gz");
    expect(remove).toContain("today-early.sql.gz");
    expect(keep).toContain("yesterday.sql.gz");
  });

  it("keeps all unique daily backups within the daily window", () => {
    const backups = [0, 1, 2, 3, 4, 5, 6].map((d) => makeBackup(`day-${d}.sql.gz`, d));
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep.length).toBe(7);
    expect(remove.length).toBe(0);
  });

  it("keeps newest per ISO-week in weekly tier", () => {
    // Beyond the 7-day daily window, in the 2-week weekly window.
    // Days 8-21 fall in the weekly tier (dayCutoff=7d back, weekCutoff=7+14=21d back).
    // Two backups in different weeks — both should be kept (one per week).
    const backups = [
      makeBackup("week1-newest.sql.gz", 8),
      makeBackup("week1-older.sql.gz", 9),
      makeBackup("week2-newest.sql.gz", 15),
      makeBackup("week2-older.sql.gz", 16),
    ];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep).toContain("week1-newest.sql.gz");
    expect(remove).toContain("week1-older.sql.gz");
    expect(keep).toContain("week2-newest.sql.gz");
    expect(remove).toContain("week2-older.sql.gz");
  });

  it("keeps newest per calendar-month in monthly tier", () => {
    // With NOW=2026-04-27, POLICY dailyDays=7, weeklyWeeks=2, monthlyMonths=1:
    //   dayCutoff   = 2026-04-20
    //   weekCutoff  = 2026-04-06
    //   monthCutoff = 2026-03-06
    // Monthly tier covers 2026-03-06 to 2026-04-06.
    // Two backups in April (just within weekly window boundary: 2026-04-02)
    // and two in March (2026-03-13 and 2026-03-10) — the April pair falls
    // in the weekly tier; they shouldn't appear here. Instead use dates
    // that are clearly in the monthly tier: ~22-50 days back, two different months.
    //
    // 22d back = 2026-04-05 (monthly tier — just before weekCutoff 2026-04-06)
    // 24d back = 2026-04-03 (monthly tier)
    // Both are in April 2026 → only the newest (22d) is kept.
    //
    // 44d back = 2026-03-14 (monthly tier — between weekCutoff and monthCutoff)
    // 47d back = 2026-03-11 (monthly tier)
    // Both are in March 2026 → only the newest (44d) is kept.
    const backups = [
      makeBackup("april-newest.sql.gz", 22),
      makeBackup("april-older.sql.gz", 24),
      makeBackup("march-newest.sql.gz", 44),
      makeBackup("march-older.sql.gz", 47),
    ];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep).toContain("april-newest.sql.gz");
    expect(remove).toContain("april-older.sql.gz");
    expect(keep).toContain("march-newest.sql.gz");
    expect(remove).toContain("march-older.sql.gz");
  });

  it("removes backups older than the monthly cutoff", () => {
    // Monthly cutoff for POLICY with monthlyMonths=1:
    // dayCutoff = 7d, weekCutoff = 7+14=21d, monthCutoff = 21d + ~30d = ~51d
    const backups = [
      makeBackup("very-old-1.sql.gz", 60),
      makeBackup("very-old-2.sql.gz", 90),
      makeBackup("recent.sql.gz", 2),
    ];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep).toContain("recent.sql.gz");
    expect(remove).toContain("very-old-1.sql.gz");
    expect(remove).toContain("very-old-2.sql.gz");
  });

  it("handles single backup — always kept if within any retention window", () => {
    const backups = [makeBackup("only-backup.sql.gz", 1)];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    expect(keep).toContain("only-backup.sql.gz");
    expect(remove).toHaveLength(0);
  });

  it("returns correct split: keep + remove cover all inputs with no overlap", () => {
    const backups = [
      makeBackup("a.sql.gz", 0),
      makeBackup("b.sql.gz", 0, 5), // same day as a, should be removed
      makeBackup("c.sql.gz", 10),   // weekly tier
      makeBackup("d.sql.gz", 100),  // beyond monthly cutoff
    ];
    const { keep, remove } = pruneOldBackups(backups, POLICY, NOW);
    const allPaths = backups.map((b) => b.path);
    const covered = [...keep, ...remove].sort();
    expect(covered).toEqual(allPaths.sort());
    // No overlap
    const keepSet = new Set(keep);
    for (const p of remove) {
      expect(keepSet.has(p)).toBe(false);
    }
  });

  it("respects policy with larger daily window", () => {
    const bigPolicy: BackupRetentionPolicy = { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 3 };
    // 10 unique daily backups — all within 14-day window, all should be kept
    const backups = Array.from({ length: 10 }, (_, i) => makeBackup(`day-${i}.sql.gz`, i));
    const { keep, remove } = pruneOldBackups(backups, bigPolicy, NOW);
    expect(keep.length).toBe(10);
    expect(remove.length).toBe(0);
  });
});
