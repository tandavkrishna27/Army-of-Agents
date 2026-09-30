/**
 * Pure utility functions for plugin rollback logic.
 * Separated from the DB-coupled service to avoid ESM cycle issues in tests.
 */

export function keepLatestN<T extends { id: string; createdAt: Date }>(
  snapshots: T[],
  n: number,
): { toKeep: T[]; toDelete: T[] } {
  const sorted = [...snapshots].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return {
    toKeep: sorted.slice(0, n),
    toDelete: sorted.slice(n),
  };
}
