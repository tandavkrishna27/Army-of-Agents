// E3-F034 — a concurrent-claimer race must not be able to leak into the NEXT test.
//
// ★ WHY THIS EXISTS, and why it is a helper rather than three inline characters.
//
// `job-leasing.integration.test.ts` fires N concurrent `service.poll()` calls at ONE
// `execution_targets` row to prove that exactly one claimer wins. It did that through
// `Promise.all`. `Promise.all` REJECTS ON THE FIRST REJECTION AND CANCELS NOTHING: the
// other N-1 polls keep running, keep holding transactions, and keep mutating the database
// AFTER the test that started them has already failed and returned. The next test in the
// file calls `resetRuntimeRows()` and seeds its own fixture straight into that traffic.
//
// The observed consequence (2026-09-02 and 2026-09-03, `verify (4)`, twice in one day) is
// that ONE flaky test reports as TWO failures, and the second one — "chooses the oldest
// compatible attempt…", whose own polls are `await`ed SEQUENTIALLY and therefore cannot be
// self-contending — fails for a reason that is entirely IMPORTED. Six of the seven `55P03`s
// in the failing log carried the SECOND test's name. That is why each occurrence looked
// unlike the last and was re-diagnosed from scratch.
//
// ★★ AND THE CASCADE IS ITSELF NON-DETERMINISTIC: at `a83886308` the same race produced
// ONE failure with no cascade at all, and on PR #340 it produced TWO. How many stragglers
// are still in flight when the failing test returns depends on where in the pool queue the
// rejection landed, so the SHAPE of the report changes between occurrences of the SAME bug.
//
// ★ WHAT THIS CHANGES, PRECISELY. Not what the race asserts — a rejected claimer is STILL a
// test failure, and this helper re-throws it. What changes is WHEN: nothing is reported
// until every claimer has settled, so the failure cannot outlive its own test. `Promise.all`
// and this helper agree on the verdict and disagree only on the timing of the verdict, which
// is exactly the difference between one attributable failure and two confusing ones.
//
// It also NAMES the failure, which is the other half of the cost: the first occurrence took a
// full investigation to attribute, and the second took another one.

/** How many rejected claimers to name in the thrown message before summarising the rest. */
const REPORTED_REASONS = 3;

/**
 * Await EVERY claimer to settle, then re-throw if any of them rejected.
 *
 * The return is the fulfilled values in claimer order, so callers keep index-aligned
 * assertions (claimer `i` produced `results[i]`).
 *
 * @param claimers the already-started promises. They are already running: this helper
 *   changes when they are OBSERVED, never whether they run.
 * @param label what the race is, for the failure message.
 */
export async function settleAllClaimers<T>(
  claimers: ReadonlyArray<Promise<T>>,
  label: string,
): Promise<T[]> {
  const settled = await Promise.allSettled(claimers);
  const rejected = settled
    .map((result, index) => ({ result, index }))
    .filter((entry): entry is { result: PromiseRejectedResult; index: number } =>
      entry.result.status === "rejected");

  if (rejected.length > 0) {
    const named = rejected.slice(0, REPORTED_REASONS)
      .map(({ result, index }) => `  [${index}] ${describeReason(result.reason)}`)
      .join("\n");
    const rest = rejected.length > REPORTED_REASONS
      ? `\n  … and ${rejected.length - REPORTED_REASONS} more`
      : "";
    const error = new Error(
      `${label}: ${rejected.length} of ${claimers.length} concurrent claimers REJECTED ` +
        `(all ${claimers.length} were awaited to settlement first, so nothing from this race ` +
        `is still in flight — E3-F034):\n${named}${rest}`,
    );
    // Keep the first real reason reachable; a `55P03` code on it is the whole diagnosis.
    (error as { cause?: unknown }).cause = rejected[0]?.result.reason;
    throw error;
  }

  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return typeof code === "string" ? `${reason.name}[${code}]: ${reason.message}` : `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}
