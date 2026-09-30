/**
 * Throwing env-parse helpers (reimplemented, never imported from the server).
 *
 * Mirrors the shape of `server/src/config/distributed-execution.ts`
 * (`parseBooleanEnv`) and `server/src/config.ts` enum narrowing, but is a pure,
 * self-contained module: it reads nothing from `process.env` itself — the caller
 * supplies the `Env` map — so `loadWorkerConfig` stays a pure, testable parser.
 */

/** A read-only view of environment variables. */
export type Env = Record<string, string | undefined>;

const TRUE_TOKENS = new Set(["1", "true", "yes", "on"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off"]);

/** Parse a boolean env var; throws on an unparseable non-empty value. */
export function parseBooleanEnv(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  if (TRUE_TOKENS.has(raw)) return true;
  if (FALSE_TOKENS.has(raw)) return false;
  throw new Error(`${name}=${JSON.stringify(env[name])} is not a boolean flag`);
}

/** Parse an enum env var narrowed to `allowed`; throws on an out-of-set value. */
export function parseEnumEnv<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  defaultValue?: T,
): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`${name} is required (one of: ${allowed.join(", ")})`);
  }
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name}=${JSON.stringify(env[name])} is not one of: ${allowed.join(", ")}`);
}

/** Parse a bounded integer env var; throws on NaN or out-of-range. */
export function parseIntEnv(
  env: Env,
  name: string,
  opts: { readonly defaultValue: number; readonly min: number; readonly max: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return opts.defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name}=${JSON.stringify(env[name])} is not an integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < opts.min || value > opts.max) {
    throw new Error(
      `${name}=${JSON.stringify(env[name])} is out of range [${opts.min}, ${opts.max}]`,
    );
  }
  return value;
}

/** Parse a bounded float in [0,1] (used for backoff jitter). */
export function parseUnitFloatEnv(env: Env, name: string, defaultValue: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name}=${JSON.stringify(env[name])} is not a number in [0, 1]`);
  }
  return value;
}
