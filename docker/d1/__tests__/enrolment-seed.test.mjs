// -----------------------------------------------------------------------------
// WRK-017 — the PRE-MERGE half of "a real container enrols on d1".
//
//   node --test docker/d1/__tests__/enrolment-seed.test.mjs
//
// The live half runs only in the D1 merge-train lane, which fires on PUSH to the
// integration branch — i.e. AFTER merge. So everything about the enrolment fixture that CAN
// be checked from a plain checkout is checked here, in `policy`, on every PR.
//
// Three couplings are load-bearing and all three are invisible to a reader:
//
//   1. `docker/control-plane/seed-d1-worker-enrolment.mjs` carries a MIRROR of the daemon's
//      ticket codec, because the control-plane image must not contain `packages/worker-daemon`
//      (E4-D01). A mirror with no pin is a mirror that drifts, and the drift presents as a
//      container crash-loop found only by a live bring-up.
//   2. The seed splits the code into two halves and hashes each; the SERVER re-derives the
//      same split at enrol time. A different split is not a loud failure — it is a plain
//      `unauthorized`, which on a first boot is `proc.exit(1)` and a failed `up --wait`.
//   3. The committed ticket, the committed worker profile, and the compose mounts must all
//      name the same target. Two of those are files nobody diffs against each other.
//
// Non-vacuousness is the point: every constant assertion below is paired with a rejection
// case, so a decoder that accepted everything would fail this file.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENROLLMENT_TICKET_PREFIX,
  ENROLLMENT_TICKET_VERSION,
  MAX_TICKET_BODY_LENGTH,
  ENROLLMENT_CODE_RE,
  decodeEnrollmentTicket,
  hashEnrollmentCode,
  deriveRegisteredProfile,
  targetAuthorityKey,
  EnrolmentSeedError,
} from "../../control-plane/seed-d1-worker-enrolment.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const TICKET_FILE = "docker/d1/worker-b.enrollment-ticket";
const PROFILE_FILE = "docker/d1/worker-b.profile.json";
const DAEMON_CODEC = "packages/worker-daemon/src/enrollment/ticket.ts";
const SERVER_ENROLMENT = "server/src/services/worker-enrollment.ts";

const ticketText = read(TICKET_FILE).trim();
const profile = JSON.parse(read(PROFILE_FILE));

// === The committed fixture is a valid ticket for the committed profile =======

test("the committed ticket decodes and names the worker's own target", () => {
  const ticket = decodeEnrollmentTicket(ticketText);
  assert.equal(ticket.v, ENROLLMENT_TICKET_VERSION);
  assert.equal(
    ticket.targetId,
    profile.targetId,
    "the ticket's targetId must equal the target id the shipped worker profile declares; " +
      "a mismatch authorizes a code for one target while the worker helloes about another, " +
      "which the server answers `unauthorized` and the daemon turns into exit 1",
  );
});

test("the committed ticket file is a single line with no stray whitespace", () => {
  const raw = read(TICKET_FILE);
  assert.equal(raw.split("\n").filter((l) => l.trim() !== "").length, 1);
  assert.ok(raw.startsWith(ENROLLMENT_TICKET_PREFIX), "ticket must start with the prefix, unindented");
});

test("the committed ticket's code matches the SERVER's own parseCode regex", () => {
  // Read the server's literal, so a change to the accepted code shape fails HERE rather than
  // as an `unauthorized` on a live stack.
  const serverSrc = read(SERVER_ENROLMENT);
  const literal = /\/\^aoa_enr_\(\[A-Za-z0-9_-\]\{16,64\}\)\\\.\(\[A-Za-z0-9_-\]\{32,128\}\)\$\//.exec(serverSrc);
  assert.ok(literal, `${SERVER_ENROLMENT} no longer contains the parseCode regex this fixture was built for`);
  const serverRe = new RegExp("^aoa_enr_([A-Za-z0-9_-]{16,64})\\.([A-Za-z0-9_-]{32,128})$");
  const { code } = decodeEnrollmentTicket(ticketText);
  assert.ok(serverRe.test(code), "the committed code does not match the server's accepted shape");
  assert.equal(String(ENROLLMENT_CODE_RE), String(serverRe), "the seed's mirror of the server regex has drifted");
});

test("hashEnrollmentCode splits and hashes EXACTLY as the server's parseCode does", () => {
  const { code } = decodeEnrollmentTicket(ticketText);
  const [locator, secret] = code.slice("aoa_enr_".length).split(".");
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  const hashes = hashEnrollmentCode(code);
  // sha256 of each half as a UTF-8 STRING — not of decoded base64url bytes. The server does
  // `sha256(match[1])` / `sha256(match[2])` on the captured strings.
  assert.equal(hashes.locatorHash, sha(locator));
  assert.equal(hashes.secretHash, sha(secret));
  assert.match(hashes.locatorHash, /^[0-9a-f]{64}$/, "worker_enrollment_codes_digest_check requires 64 lowercase hex");
  assert.match(hashes.secretHash, /^[0-9a-f]{64}$/);
});

// === The mirror is pinned to the daemon's own source =========================

test("the seed's ticket-codec constants still match the daemon's", () => {
  const daemon = read(DAEMON_CODEC);
  assert.ok(
    daemon.includes(`export const ENROLLMENT_TICKET_PREFIX = "${ENROLLMENT_TICKET_PREFIX}"`),
    `${DAEMON_CODEC} changed the ticket prefix; the control-plane seed mirrors it and must be updated`,
  );
  assert.ok(
    daemon.includes(`export const ENROLLMENT_TICKET_VERSION = ${ENROLLMENT_TICKET_VERSION}`),
    `${DAEMON_CODEC} changed the ticket version; the seed mirrors it`,
  );
  assert.ok(
    daemon.includes(`const MAX_TICKET_BODY_LENGTH = ${MAX_TICKET_BODY_LENGTH}`),
    `${DAEMON_CODEC} changed the ticket body bound; the seed mirrors it`,
  );
  assert.ok(
    daemon.includes(`const EXPECTED_KEYS = ["code", "targetId", "v"]`),
    `${DAEMON_CODEC} changed the exhaustive ticket key set; the seed mirrors it`,
  );
});

// === Non-vacuousness: the seed's decoder actually refuses ====================

const encode = (obj) => ENROLLMENT_TICKET_PREFIX + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const goodCode = decodeEnrollmentTicket(ticketText).code;
const goodTarget = profile.targetId;

for (const [name, raw] of [
  ["missing prefix", encode({ v: 1, targetId: goodTarget, code: goodCode }).slice(8)],
  ["wrong prefix", `aoa_xxx_${encode({ v: 1, targetId: goodTarget, code: goodCode }).slice(8)}`],
  ["empty body", ENROLLMENT_TICKET_PREFIX],
  ["non-base64url body", `${ENROLLMENT_TICKET_PREFIX}not base64!`],
  ["body over the bound", ENROLLMENT_TICKET_PREFIX + "a".repeat(MAX_TICKET_BODY_LENGTH + 1)],
  ["not a JSON object", encode([1, 2, 3])],
  ["an extra key", encode({ v: 1, targetId: goodTarget, code: goodCode, extra: "x" })],
  ["a missing key", encode({ v: 1, targetId: goodTarget })],
  ["an unsupported version", encode({ v: 2, targetId: goodTarget, code: goodCode })],
  ["a non-string targetId", encode({ v: 1, targetId: 7, code: goodCode })],
  ["a code with no dot", encode({ v: 1, targetId: goodTarget, code: "aoa_enr_abcdefghijklmnopqrst" })],
  ["a code with a too-short secret", encode({ v: 1, targetId: goodTarget, code: "aoa_enr_abcdefghijklmnopqrst.short" })],
  ["a code with the wrong prefix", encode({ v: 1, targetId: goodTarget, code: goodCode.replace("aoa_enr_", "aoa_xxx_") })],
]) {
  test(`REJECT: a ticket with ${name}`, () => {
    assert.throws(() => decodeEnrollmentTicket(raw), EnrolmentSeedError, `"${name}" was ACCEPTED`);
  });
}

test("REJECT: a decoder error never echoes the ticket or the code", () => {
  try {
    decodeEnrollmentTicket(encode({ v: 1, targetId: goodTarget, code: "aoa_enr_bad" }));
    assert.fail("expected a rejection");
  } catch (err) {
    assert.ok(!err.message.includes(goodCode));
    assert.ok(!err.message.includes("aoa_enr_bad"));
  }
});

// === The derived target row is consistent with the shipped profile ===========

test("targetAuthorityKey matches the execution_targets scope check for this profile", () => {
  assert.equal(targetAuthorityKey(profile), `organization:${profile.organizationId}`);
  assert.equal(targetAuthorityKey({ scope: "platform" }), "platform");
  assert.throws(() => targetAuthorityKey({ scope: "owner" }), EnrolmentSeedError);
  assert.throws(() => targetAuthorityKey({ scope: "organization" }), EnrolmentSeedError);
});

test("deriveRegisteredProfile substitutes ONLY the provider digest", () => {
  const digest = "f".repeat(64);
  const derived = deriveRegisteredProfile(profile, digest);
  assert.equal(derived.providerConstraints.digest, digest);
  assert.notEqual(profile.providerConstraints.digest, digest, "the committed placeholder must be a placeholder");
  assert.equal(derived.providerConstraints.profileId, profile.providerConstraints.profileId);
  assert.equal(derived.providerConstraints.version, profile.providerConstraints.version);
  for (const key of Object.keys(profile)) {
    if (key === "providerConstraints") continue;
    assert.deepEqual(derived[key], profile[key], `deriveRegisteredProfile altered ${key}`);
  }
  assert.deepEqual(Object.keys(derived).sort(), Object.keys(profile).sort());
});

// === worker-a is the NEGATIVE CONTROL and must have no ticket ================

test("worker-a ships no enrolment ticket (the control must be unable to enrol)", () => {
  assert.throws(
    () => read("docker/d1/worker-a.enrollment-ticket"),
    /ENOENT/,
    "worker-a is the negative control: a ticket for it would make the control able to enrol too",
  );
});
