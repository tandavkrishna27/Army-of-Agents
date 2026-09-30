/**
 * BRW-003d-5 — the ONE server-authoritative artifact size ceiling.
 *
 * ★ WHY IT IS SHARED. The commit path already enforced a ceiling
 * (`actualSizeBytes > maxArtifactBytes`), but it owned the number privately as a
 * `?? 5 * 1024 ** 3` default — and the production composition root supplies
 * nothing, so 5 GiB was the live value by accident rather than by decision.
 *
 * The grant path enforced NOTHING. Its declared `maxBytes` is bounded only by
 * `Number.MAX_SAFE_INTEGER` in the frozen schema, is passed straight to
 * `presignPut`, and was compared to no server limit at all. So the ceiling could
 * only fire AFTER the bytes were already in the object store, at which point the
 * commit refuses and the uploaded object is an orphan the sweeper has to find.
 *
 * Two enforcement points reading two private numbers is the drift class. One
 * exported constant, imported by both, is the fix — and a test asserts they agree.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 ** 3;
