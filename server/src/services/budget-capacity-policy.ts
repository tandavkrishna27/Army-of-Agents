export type CapacityExposure = {
  policyId: string;
  scopeType: string;
  scopeId: string;
  limitCents: number;
  postedCents: number;
  outstandingCents: number;
  requestedCents: number | null;
};
export type CapacityAdmission =
  | { outcome: "admitted"; remainingCents: number }
  | {
      outcome: "denied";
      policyId: string;
      remainingCents: number;
      requiredCents: number;
    }
  | { outcome: "unknown"; reason: "unbounded_exposure" | "no_policy" };
export function evaluateCapacityAdmission(
  exposures: CapacityExposure[]
): CapacityAdmission {
  if (!exposures.length) return { outcome: "unknown", reason: "no_policy" };
  if (exposures.some((row) => row.requestedCents === null))
    return { outcome: "unknown", reason: "unbounded_exposure" };
  let tightest = Number.POSITIVE_INFINITY;
  for (const row of exposures) {
    const remaining = Math.max(
      0,
      row.limitCents - row.postedCents - row.outstandingCents
    );
    if ((row.requestedCents as number) > remaining)
      return {
        outcome: "denied",
        policyId: row.policyId,
        remainingCents: remaining,
        requiredCents: row.requestedCents as number,
      };
    tightest = Math.min(tightest, remaining - (row.requestedCents as number));
  }
  return { outcome: "admitted", remainingCents: tightest };
}
