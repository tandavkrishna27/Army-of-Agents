// packages/worker-daemon/src/enrollment/ticket.ts
//
// DSK-001 (I8) — the enrollment ticket a founder pastes into a desktop.
//
// `aoa_tkt_<base64url(JSON({v, targetId, code}))>` — three fields and nothing
// else. Pure: no `process`, no `node:fs`, no clock. It lives in the daemon
// package because it is protocol, not custody, and it imports only
// `@armyofagents/worker-protocol`, so the two-dependency pin is untouched.
//
// Two design choices carry weight.
//
// **"And nothing else" is an exhaustive key check, not a destructure.** A
// destructure silently ignores unexpected fields, so a ticket carrying extra data
// would be accepted and that data would flow onward unexamined. Comparing the
// sorted key list for equality is the only shape that makes "nothing else" a
// property a test can fail.
//
// **No rejection ever echoes its input.** The ticket embeds an enrollment CODE —
// a live bearer credential with a 10-minute server-side TTL
// (`server/src/services/worker-enrollment.ts:22`). An error that interpolates
// what it was handed puts that credential wherever the error lands: a log line,
// a crash report, a support bundle. Every message below names the constraint that
// failed and nothing more. Note this is a stronger rule than the daemon logger's
// redaction, which keys on FIELD NAMES and cannot help with a value pasted into
// an error string.

import { targetIdSchema } from "@armyofagents/worker-protocol";

export const ENROLLMENT_TICKET_PREFIX = "aoa_tkt_";

/** The ticket's ONLY version. A different one is a deliberate migration. */
export const ENROLLMENT_TICKET_VERSION = 1;

/**
 * Bounded before decoding. A ticket is ~120 bytes; 512 is generous. The bound is
 * checked FIRST so a multi-megabyte paste costs a regex test rather than a
 * base64 allocation and a JSON parse.
 */
const MAX_TICKET_BODY_LENGTH = 512;
const BODY_RE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The client mirror of the server's own code shape
 * (`server/src/services/worker-enrollment.ts:81`). Rejecting client-side turns a
 * network round trip — and a consumed single-use code — into an instant local
 * error.
 */
const CODE_RE = /^aoa_enr_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}$/;

/** Exactly these keys, sorted, so the comparison is order-independent. */
const EXPECTED_KEYS = ["code", "targetId", "v"];

export interface EnrollmentTicket {
  readonly v: number;
  readonly targetId: string;
  readonly code: string;
}

export class EnrollmentTicketError extends Error {
  constructor(constraint: string) {
    // The message is the CONSTRAINT NAME only — never the offending value.
    super(`enrollment ticket rejected: ${constraint}`);
    this.name = "EnrollmentTicketError";
  }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Fixed key order, so the same ticket always encodes to the same bytes. A
 * stable encoding means a founder comparing two tickets is comparing content.
 */
export function encodeEnrollmentTicket(ticket: EnrollmentTicket): string {
  const payload = JSON.stringify({
    v: ticket.v,
    targetId: ticket.targetId,
    code: ticket.code,
  });
  return ENROLLMENT_TICKET_PREFIX + toBase64Url(payload);
}

export function decodeEnrollmentTicket(raw: string): EnrollmentTicket {
  if (typeof raw !== "string" || !raw.startsWith(ENROLLMENT_TICKET_PREFIX)) {
    throw new EnrollmentTicketError("missing or wrong prefix");
  }
  const body = raw.slice(ENROLLMENT_TICKET_PREFIX.length);
  // Bound BEFORE decoding — never allocate from unbounded input.
  if (body.length === 0 || body.length > MAX_TICKET_BODY_LENGTH) {
    throw new EnrollmentTicketError("body length out of bounds");
  }
  if (!BODY_RE.test(body)) {
    throw new EnrollmentTicketError("body is not base64url");
  }

  let text: string;
  try {
    text = fromBase64Url(body);
  } catch {
    throw new EnrollmentTicketError("body is not decodable base64url");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnrollmentTicketError("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnrollmentTicketError("body is not a JSON object");
  }

  // The exhaustive check. Equality, not a subset test — an extra key is a
  // rejection, which is what makes "and nothing else" real.
  const keys = Object.keys(parsed).sort();
  if (keys.length !== EXPECTED_KEYS.length || keys.some((k, i) => k !== EXPECTED_KEYS[i])) {
    throw new EnrollmentTicketError("unexpected key set");
  }

  const { v, targetId, code } = parsed as Record<string, unknown>;
  if (v !== ENROLLMENT_TICKET_VERSION) {
    throw new EnrollmentTicketError("unsupported version");
  }
  if (typeof targetId !== "string" || !targetIdSchema.safeParse(targetId).success) {
    throw new EnrollmentTicketError("targetId is not a valid target id");
  }
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    throw new EnrollmentTicketError("code does not match the enrollment code shape");
  }

  return { v, targetId, code };
}
