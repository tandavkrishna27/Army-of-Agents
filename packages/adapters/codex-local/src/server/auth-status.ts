/**
 * Reads `codex login status`, which reports whether CREDENTIALS EXIST locally —
 * not whether they still work. A revoked token still yields `loggedIn: true`;
 * that mismatch is precisely the trap this exists to expose. Pair it with the
 * hello probe: status says who is signed in, the probe says whether it works.
 *
 * Unlike `claude auth status` (JSON), `codex login status` prints PROSE:
 *
 *   Logged in using ChatGPT
 *   Logged in using an API key
 *   Not logged in
 *
 * There is no email in the output, so the "account" here is the auth METHOD
 * ("ChatGPT", "an API key"), not a person — callers must phrase copy
 * accordingly ("signed in using ChatGPT", not "signed in as ChatGPT").
 *
 * Parsing only. The caller owns spawning, so this stays synchronously testable.
 */

export interface CodexAuthStatus {
  /** Credentials are present on disk. Says nothing about validity. */
  loggedIn: boolean;
  /** Auth method label to show the founder ("ChatGPT", "an API key"), when known. */
  account: string | null;
}

// Checked BEFORE the logged-in patterns below: "Not logged in" contains
// "logged in" as a substring, so order matters.
const NOT_LOGGED_IN_RE = /not\s+logged\s+in/i;
const LOGGED_IN_USING_RE = /logged\s+in\s+using\s+(.+)/i;
const LOGGED_IN_RE = /\blogged\s+in\b/i;

/**
 * Never throws: an older/broken CLI (`error: unknown command 'login'`) or
 * unrecognised output must degrade to signed-out copy rather than crash mid
 * verification. Always returns a freshly constructed object — never a shared
 * reference callers could accidentally mutate into each other.
 *
 * Scans ALL non-empty lines for the first status-shaped one, rather than
 * only examining the first line: a banner ahead of the real status line
 * (e.g. a deprecation warning) must not shadow it and report signed-out for
 * a user whose session is actually expired. Per-line, "not logged in" is
 * still checked before "logged in" — that ordering trap (the former
 * contains the latter as a substring) applies within each line too.
 */
export function parseCodexAuthStatus(stdout: string | null | undefined): CodexAuthStatus {
  const lines = (stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (NOT_LOGGED_IN_RE.test(line)) return { loggedIn: false, account: null };

    const usingMatch = LOGGED_IN_USING_RE.exec(line);
    if (usingMatch) {
      const method = usingMatch[1].trim().replace(/[.\s]+$/, "");
      return { loggedIn: true, account: method || null };
    }

    if (LOGGED_IN_RE.test(line)) return { loggedIn: true, account: null };
  }

  return { loggedIn: false, account: null };
}

/** Argv for the status probe. Kept here so the probe and tests agree. */
export const CODEX_AUTH_STATUS_ARGS = ["login", "status"] as const;
