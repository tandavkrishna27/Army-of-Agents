// -----------------------------------------------------------------------------
// RealE2bTransport pure helpers (CLI-004/keyed-hardening) — SDK-free + key-free.
//
// `real-transport.ts` imports the `e2b` SDK and is loaded ONLY on the keyed lane,
// so its argv-serialization + not-found classification could not be regression-
// covered by the no-key build. These two decisions are pure functions of their
// inputs, so they live here where the no-key suite can pin them WITHOUT the SDK or
// a key — closing the "the mock never execs a shell, so the real bug hid" gap that
// the first keyed run surfaced (8/18 real-E2B failures).
// -----------------------------------------------------------------------------

/** POSIX single-quote one shell token: wrap in single quotes, closing+escaping any
 * embedded single quote as `'\''`. */
export function shSingleQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Serialize a `command` + `argv` into ONE shell string with every token quoted.
 *
 * The `e2b` SDK's `sandbox.commands.run(cmd)` takes a single command STRING, so an
 * argv array must be collapsed. A naive `[command, ...args].join(" ")` silently
 * destroys argument boundaries: `runCommand({command:"sh", args:["-c","printf 'x' > f"]})`
 * became `sh -c printf 'x' > f`, so `sh -c` received only `printf` and the rest
 * became `$0`/redirections (real-E2B failures: `printf: usage`, empty stdout,
 * `sleep: missing operand`). Quoting each token preserves the argv exactly.
 */
export function shellJoin(command: string, args: readonly string[]): string {
  return [command, ...args].map(shSingleQuote).join(" ");
}

/**
 * Classify an `e2b` SDK error as an absent/not-found target (vs a transient fault),
 * so the cleanup facet's no-existence-oracle guarantee holds against REAL E2B.
 *
 * The first keyed run showed an absent target surfaces NOT as `NotFoundError` but as
 * a base `SandboxError`: e2b's error mapper maps 400→InvalidArgumentError,
 * 404→NotFoundError, 429→RateLimitError, and falls back to
 * `new SandboxError("<status>: <text>")` for ANY unmapped status. A missing/foreign
 * sandbox lookup returns an unmapped 4xx (e.g. 403/409/410) → a base `SandboxError`
 * whose message carries the status. We treat:
 *   - the named not-found / bad-target classes, and
 *   - a base `SandboxError` with a 4xx-prefixed message
 * as not-found; 5xx stays transient. `CommandExitError` is deliberately excluded —
 * its `.message` is "exit status N" (the "command not found" text is in `.stderr`),
 * so a 127 command exit is never mis-read as a sandbox-not-found.
 */
export function isE2bNotFound(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (
    name === "NotFoundError" ||
    name === "SandboxNotFoundError" ||
    name === "FileNotFoundError" ||
    name === "InvalidArgumentError" ||
    name.toLowerCase().includes("notfound")
  ) {
    return true;
  }
  if (name === "SandboxError") {
    const msg = err instanceof Error ? err.message : "";
    const m = /^\s*(\d{3})\s*:/.exec(msg);
    if (m) {
      const status = Number(m[1]);
      if (status >= 400 && status < 500) return true;
    }
  }
  return false;
}
