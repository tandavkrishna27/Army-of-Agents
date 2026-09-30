/**
 * Streaming verification-URL detector for interactive CLI logins (Plan 3 / §6.2).
 *
 * `claude login` and `codex login` print an OAuth/device verification URL to
 * stdout (sometimes stderr) and then block waiting for the browser round-trip.
 * We spawn the CLI, tee both streams through this detector, and surface the URL
 * to the founder. Two properties matter:
 *
 *  - **Chunk-boundary safe.** A URL can be split across read chunks, so we
 *    accumulate and only emit once the URL is *terminated* by whitespace or a
 *    quote/angle/backtick — an unterminated tail is treated as "still growing".
 *  - **Idempotent.** Once a URL is found we keep returning it; later log noise
 *    (which may itself contain URLs) never overwrites the login URL.
 *
 * Pure and synchronous — the spawn/lifecycle wiring lives in `streaming-login`.
 */

import { stripVTControlCharacters } from "node:util";

// URLs are only considered complete when followed by a terminator, so a URL cut
// off at a chunk boundary won't match until the rest (and its terminator) arrive.
// Global so we can skip decoy URLs (see below) and take the first *real* one.
const URL_WITH_TERMINATOR =
  /(https?:\/\/[^\s\x00-\x1f\x7f"'<>`]+)(?=[\s\x00-\x1f\x7f"'<>`])/g;

// One-shot variant for `extractVerificationUrl`: a URL at the very end of a
// complete (non-streaming) string is not "still growing" — there is no more
// input coming — so end-of-string is accepted as a terminator too.
const URL_WITH_TERMINATOR_OR_EOS =
  /(https?:\/\/[^\s\x00-\x1f\x7f"'<>`]+)(?=[\s\x00-\x1f\x7f"'<>`]|$)/g;

// Trailing sentence punctuation that a CLI may print right after the URL
// ("…authenticate: https://…/x." ) but that isn't part of the URL.
const TRAILING_PUNCT = /[.,);:!?'"\]]+$/;

// `stripVTControlCharacters` intentionally drops an incomplete control tail.
// In a stream, that tail may sit between two URL fragments; treating the ESC
// as a delimiter would permanently resolve a truncated URL. Wait until the
// CSI/OSC sequence is complete before attempting a match.
const INCOMPLETE_VT_TAIL =
  /(?:\x1b|\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?))$/;

/**
 * Loopback callback servers are NOT the verification URL. `codex login` prints
 * its local callback (`http://localhost:1455.`) BEFORE the real
 * `https://auth.openai.com/…` page, so "first URL wins" would grab the wrong
 * one — skip loopback hosts and take the first remote URL instead.
 *
 * Covers: `localhost` and any `*.localhost` name, the whole `127.0.0.0/8`
 * block, `0.0.0.0`, IPv6 `::1`/`[::1]`, and the IPv4-mapped IPv6 loopback
 * form (`::ffff:127.0.0.1`, which Node's URL parser canonicalizes to hex
 * hextets like `[::ffff:7f00:1]` — decoded below rather than pattern-matched).
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (h === "[::1]" || h === "::1") return true;
  if (h.startsWith("127.")) return true;
  return isIpv4MappedLoopback(h);
}

/**
 * Decodes an IPv6 "IPv4-mapped" hostname (`[::ffff:<hex>:<hex>]`, the form
 * Node's URL parser produces for e.g. `::ffff:127.0.0.1`) back to its first
 * octet and checks the 127.0.0.0/8 loopback range.
 */
function isIpv4MappedLoopback(host: string): boolean {
  const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (!match) return false;
  const high = Number.parseInt(match[1] ?? "", 16);
  if (Number.isNaN(high)) return false;
  const firstOctet = (high >> 8) & 0xff;
  return firstOctet === 127;
}

/**
 * One-shot loopback check for a full URL string (as opposed to
 * `isLoopbackHost`, which takes an already-extracted hostname). Shared by
 * this module's own URL extraction and by adapter-specific auth-failure
 * parsing (e.g. claude-local's `detectClaudeLoginRequired`) that needs to
 * reject a bogus local-callback link surfaced by a looser fallback matcher.
 * Returns `false` (not loopback) for an unparseable URL rather than
 * throwing — callers treat that as "not filtered".
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function findFirstVerificationUrl(text: string, urlRegex: RegExp): string | null {
  // Parse normalized terminal text at this shared boundary so both streaming
  // and one-shot callers reject color/control bytes as URL content. Normalizing
  // accumulated text also handles a control sequence split across chunks.
  const normalized = stripVTControlCharacters(text);
  for (const match of normalized.matchAll(urlRegex)) {
    const url = match[1].replace(TRAILING_PUNCT, "");
    let host: string;
    try {
      host = new URL(url).hostname; // strips port; "[::1]" for IPv6 loopback
    } catch {
      continue;
    }
    if (!isLoopbackHost(host)) return url;
  }
  return null;
}

function firstVerificationUrl(text: string): string | null {
  if (INCOMPLETE_VT_TAIL.test(text)) return null;
  return findFirstVerificationUrl(text, URL_WITH_TERMINATOR);
}

/**
 * One-shot extraction of a verification URL from a complete string (e.g. the
 * full stdout/stderr of a failed CLI invocation). Unlike the streaming
 * detector above, there is no "more chunks coming" concern, so a URL at the
 * very end of the string counts as terminated. Shares the same
 * loopback-skipping and trailing-punctuation-trimming behaviour.
 */
export function extractVerificationUrl(text: string): string | null {
  return findFirstVerificationUrl(text, URL_WITH_TERMINATOR_OR_EOS);
}

// Guard against unbounded growth when the process emits lots of URL-free output.
// A verification URL is short and appears early; keep only a tail large enough
// that a boundary-straddling URL survives the trim.
const MAX_BUFFER = 64 * 1024;
const TAIL_KEEP = 4 * 1024;

export interface LoginUrlDetector {
  /** Feed a stdout/stderr chunk; returns the verification URL once known, else null. */
  push(chunk: string): string | null;
  /** The URL found so far (null until detected). */
  readonly url: string | null;
}

export function createLoginUrlDetector(): LoginUrlDetector {
  let buffer = "";
  let found: string | null = null;

  return {
    push(chunk: string): string | null {
      if (found !== null) return found;
      buffer += chunk;
      const url = firstVerificationUrl(buffer);
      if (url !== null) {
        found = url;
        buffer = "";
        return found;
      }
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.slice(buffer.length - TAIL_KEEP);
      }
      return null;
    },
    get url() {
      return found;
    },
  };
}
