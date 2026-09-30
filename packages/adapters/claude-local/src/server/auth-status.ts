/**
 * Reads `claude auth status`, which reports whether CREDENTIALS EXIST locally —
 * not whether they still work. A revoked token still yields `loggedIn: true`;
 * that mismatch is precisely the trap this exists to expose. Pair it with the
 * hello probe: status says who is signed in, the probe says whether it works.
 *
 * Parsing only. The caller owns spawning, so this stays synchronously testable.
 */

export interface ClaudeAuthStatus {
  /** Credentials are present on disk. Says nothing about validity. */
  loggedIn: boolean;
  /** Account label to show the founder ("ada@example.com"), when known. */
  account: string | null;
}

const SIGNED_OUT: ClaudeAuthStatus = { loggedIn: false, account: null };

function toStatus(parsed: unknown): ClaudeAuthStatus | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const loggedIn = obj.loggedIn === true;
  const email = typeof obj.email === "string" && obj.email.trim() ? obj.email.trim() : null;
  return { loggedIn, account: loggedIn ? email : null };
}

/**
 * Scans right-to-left for the last balanced `{...}` object in `text`, so
 * trailing noise AFTER the JSON payload (e.g. a warning line that itself
 * contains braces, "warn: check {config}") doesn't get swept into the slice
 * and break parsing. Tries each candidate end brace from the rightmost
 * inward until one parses as valid JSON.
 */
function parseLastBalancedObject(text: string): unknown {
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, end + 1));
          } catch {
            break; // not valid JSON for this bracket pair; keep scanning left
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Never throws: an older CLI without `auth status` prints usage text, and the
 * probe must degrade to signed-out copy rather than crash mid-verification.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  const text = (stdout ?? "").trim();
  if (!text) return { ...SIGNED_OUT };

  // The CLI may emit warnings around the JSON, so take the outermost object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { ...SIGNED_OUT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    // The outermost slice can overshoot when trailing noise after the real
    // JSON payload also contains braces. Fall back to scanning for the last
    // balanced object instead of giving up.
    parsed = parseLastBalancedObject(text);
  }

  return toStatus(parsed) ?? { ...SIGNED_OUT };
}

/** Argv for the status probe. Kept here so the probe and tests agree. */
export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status"] as const;
