export interface GoalTaskCounts { total: number; done: number; cancelled: number; }

/** done / (total - cancelled), rounded; 0 when the effective denominator is 0. */
export function computeGoalProgressPercent({ total, done, cancelled }: GoalTaskCounts): number {
  const effectiveTotal = total - cancelled;
  if (effectiveTotal <= 0) return 0;
  return Math.round((done / effectiveTotal) * 100);
}
