/**
 * @fileoverview Command-bound install consent token for catalog connectors.
 *
 * THIS IS A UX GATE, NOT AUTHORIZATION. It answers exactly one question: "was
 * the founder shown the precise command this install is about to persist, and
 * did they accept THAT one?" It does not decide whether the deployment permits
 * host execution at all — that is D7's `assertTransportAllowed`
 * (`./mcp-connector-transport-gate.ts`), a separate check that runs
 * independently on every write. Neither gate substitutes for the other: a
 * founder can consent to a command they are not authorized to run on a shared
 * host, and an authorized command can still be one they never actually saw.
 * Both run; neither subsumes the other.
 *
 * WHY A TOKEN AND NOT A `confirmed: true` BOOLEAN. A bare boolean proves
 * nothing about WHAT was confirmed. `connectors.json` re-syncs on a 6h TTL, so
 * the entry rendered in the consent dialog and the entry read at install time
 * are two separate reads of a mutable remote file — a classic TOCTOU window. A
 * boolean would let a founder approve `npx -y acme-db-tool` and, milliseconds
 * later, install whatever the re-synced catalog now says, which for a stdio
 * connector means arbitrary code executing on the AoA host with the server's
 * privileges. Binding the HMAC to `(entryId, command, args)` makes the consent
 * unforgeable AND non-transferable: it is only ever valid for the exact argv
 * that was displayed.
 *
 * PAYLOAD FRAMING. The signed payload is `JSON.stringify([exp, entryId,
 * command, args])`. JSON array framing is chosen over string concatenation
 * because concatenation is ambiguous: `${command} ${args.join(" ")}` maps both
 * `["a b"]` and `["a","b"]` to the same bytes, so a token minted for one argv
 * shape would validate the other. JSON escapes and delimits every element, so
 * no attacker-controlled field can impersonate a delimiter. `exp` is INSIDE the
 * payload (not merely a prefix on the wire) so raising it invalidates the mac.
 *
 * WHY THE TYPES ARE RE-CHECKED AT RUNTIME (`assertBindable`). JSON framing is
 * injective ONLY over genuine strings. `JSON.stringify` serialises an in-array
 * `undefined` as `null`, so `args: ["a", undefined]` and `args: ["a", null]`
 * produce byte-identical payloads — an actual cross-command collision, and the
 * one way a token minted for one argv could validate another. Both inputs
 * violate the declared type, but callers hand this untrusted request bodies
 * where TypeScript guarantees nothing, so the invariant is enforced rather than
 * assumed. Mint throws and verify fails closed on the same condition, so verify
 * can never accept a shape mint would have refused.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Long enough to read a consent dialog, short enough that a stolen token dies fast. */
export const CONSENT_TOKEN_TTL_MS = 15 * 60_000;

/** sha256 hex digest length. */
const MAC_HEX_LENGTH = 64;
const MAC_RE = /^[0-9a-f]{64}$/;
const EXPIRY_RE = /^\d+$/;

export interface ConsentCommand {
  command: string;
  /** Absent is normalised to `[]` — and that empty array is itself bound. */
  args?: string[];
}

export type ConsentFailureReason =
  | "no_secret"
  | "malformed"
  | "signature_mismatch"
  | "expired";

export interface ConsentVerifyResult {
  ok: boolean;
  reason?: ConsentFailureReason;
}

/**
 * Resolve the server-side HMAC secret.
 *
 * Deliberately reuses the EXISTING convention (`BETTER_AUTH_SECRET`, falling
 * back to `AOA_AGENT_JWT_SECRET`) rather than introducing a third signing env
 * var — identical to `installStateSecret()` in `./github-app.ts`. Both names
 * are already documented in `docs/deploy/environment-variables.md` and
 * provisioned by `pnpm aoa onboard`, so no operator action is added and CI's
 * brand-check undocumented-env guard has nothing new to catch.
 */
export function resolveConsentSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET?.trim() || process.env.AOA_AGENT_JWT_SECRET?.trim();
  if (!s) {
    throw new Error(
      "BETTER_AUTH_SECRET (or AOA_AGENT_JWT_SECRET) must be set to sign connector install consent",
    );
  }
  return s;
}

/**
 * True only when every signed field is a real string (and `args` a real array
 * of them). See the `assertBindable` note in the file header: this is what
 * makes the JSON framing injective, and therefore what makes "a token is only
 * valid for the command it was minted for" actually true.
 */
function isBindable(entryId: string, cmd: ConsentCommand): boolean {
  if (typeof entryId !== "string" || typeof cmd?.command !== "string") return false;
  const args = cmd.args ?? [];
  return Array.isArray(args) && args.every((a) => typeof a === "string");
}

function signingInput(expiryMs: number, entryId: string, cmd: ConsentCommand): string {
  return JSON.stringify([expiryMs, entryId, cmd.command, cmd.args ?? []]);
}

function mac(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/**
 * Mint a token proving the founder was shown `cmd` for `entryId`.
 *
 * Throws on an empty secret rather than silently minting a token anyone can
 * forge — a consent token signed with `""` is worse than no gate at all,
 * because it looks like one.
 */
export function mintConsentToken(
  secret: string,
  entryId: string,
  cmd: ConsentCommand,
  nowMs: number,
): string {
  if (!secret) throw new Error("consent token requires a non-empty signing secret");
  if (!isBindable(entryId, cmd)) {
    throw new Error("consent token requires a string entryId, command and args");
  }
  const exp = nowMs + CONSENT_TOKEN_TTL_MS;
  return `${exp}.${mac(secret, signingInput(exp, entryId, cmd))}`;
}

/**
 * Verify a token against the command the caller is ACTUALLY about to install.
 *
 * Never throws, for any input — callers hand it raw request bodies. Signature
 * is checked before expiry so a tampered `exp` reports `signature_mismatch`
 * (the honest failure) instead of masquerading as a clock problem.
 */
export function verifyConsentToken(
  secret: string,
  entryId: string,
  cmd: ConsentCommand,
  token: string,
  nowMs: number,
): ConsentVerifyResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  // Fail closed on exactly the condition mint refuses, so verify can never
  // accept a payload shape that mint would not have produced.
  if (!isBindable(entryId, cmd)) return { ok: false, reason: "malformed" };
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const expRaw = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  // Strict shapes up front. Rejecting non-hex here is what keeps
  // `timingSafeEqual` from ever seeing mismatched buffer lengths (it THROWS on
  // those) — `Buffer.from(x, "hex")` silently truncates at the first invalid
  // pair, so length-checking the decoded buffer alone would not be enough.
  if (!EXPIRY_RE.test(expRaw)) return { ok: false, reason: "malformed" };
  if (provided.length !== MAC_HEX_LENGTH || !MAC_RE.test(provided)) {
    return { ok: false, reason: "malformed" };
  }

  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };

  const expected = mac(secret, signingInput(exp, entryId, cmd));
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (nowMs > exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
