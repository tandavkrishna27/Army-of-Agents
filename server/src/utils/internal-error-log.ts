/**
 * JOB-002-safe fields for logging an otherwise-SWALLOWED internal error on a
 * worker-control (or other sensitive) path.
 *
 * The worker-control production log transport DELIBERATELY omits every error
 * payload — message, nested cause, SQL, and caller/tenant data — because those
 * strings can carry credentials or tenant rows (see
 * `__tests__/worker-control-log-redaction.integration.test.ts`, JOB-002). Before
 * this helper, the internal-error catches logged ONLY a `reasonCode`, which made a
 * 5xx a debugging black hole: an operator could not tell a permission error from a
 * unique violation from a schema-parse error from a storage-config error.
 *
 * This returns ONLY non-sensitive CLASSIFIERS — never the message, cause message,
 * SQL, or any value off the wire:
 *   - `errName`   the error CLASS name.
 *   - `errCode`   a stable code: a Postgres SQLSTATE (e.g. `42501`
 *                 insufficient_privilege, `23505` unique_violation, `42P01`
 *                 undefined_table) or a Node/system code (e.g. `ECONNREFUSED`).
 *                 drizzle-orm wraps postgres-js errors and puts the SQLSTATE on
 *                 `.cause.code`, so BOTH the top-level and the cause's code are
 *                 checked (mirrors `services/db-errors.ts` `isUniqueViolation`,
 *                 `err.code ?? err.cause?.code`). Only the CODE is read from the
 *                 cause — never its message.
 *   - `errStatus` an HTTP status for the AoA `HttpError` family
 *                 (`unprocessable()` → 422, etc.), which does not set a distinct
 *                 `.name` and carries no `.code`. A bounded integer classifier.
 *
 * The code is length-bounded and the status range-bounded so a library that
 * misuses `.code`/`.status` to carry a payload cannot smuggle data through it.
 */
export function internalErrorLogFields(
  error: unknown,
): { errName?: string; errCode?: string; errStatus?: number } {
  const fields: { errName?: string; errCode?: string; errStatus?: number } = {};
  if (error instanceof Error) {
    // `.name` is normally the class name, but a custom Error could set it to
    // arbitrary text; bound it (as with the code) so it cannot carry a payload.
    if (typeof error.name === "string" && error.name.length > 0) {
      fields.errName = error.name.slice(0, 200);
    }
    const code =
      readCode((error as { code?: unknown }).code) ??
      readCode((error as { cause?: { code?: unknown } }).cause?.code);
    if (code !== undefined) fields.errCode = code;
    const status =
      readStatus((error as { status?: unknown }).status) ??
      readStatus((error as { statusCode?: unknown }).statusCode);
    if (status !== undefined) fields.errStatus = status;
  } else {
    // A non-Error throw (string/number/object). Record only its JS type — never
    // its value, which could itself be sensitive.
    fields.errName = typeof error;
  }
  return fields;
}

/** A stable classification code (SQLSTATE / Node code), bounded so it cannot carry a payload. */
function readCode(code: unknown): string | undefined {
  if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return undefined;
}

/** A well-formed HTTP status code, or undefined. */
function readStatus(status: unknown): number | undefined {
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  return undefined;
}
