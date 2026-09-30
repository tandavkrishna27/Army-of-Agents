// WRK-017 — D1 harness (DEP-002 / DEP-003) ONLY: register ONE worker's enrolment authority
// from inside the PRIVILEGED migrate job, so a real container can ENROL during bring-up.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Until WRK-017 no real worker container had ever enrolled in CI. `tests/d1/lib/
// e6f-harness.mjs` says so in its own header: "There is NO live worker-daemon loop:
// enroll/poll/ack are ordinary authenticated HTTP calls the harness makes itself." Both D1
// workers booted `mounted_secret` and idled as `docker exec` network vantage points, and
// `/enrollment-code` was, in the compose's words, "only the SOURCE at load (not read)" —
// no volume even mounted it.
//
// Turning one worker into a real enroller needs two database facts that MUST EXIST BEFORE
// THAT WORKER'S FIRST BOOT:
//
//   1. an ACTIVE `execution_targets` row whose id is the worker's own target id, and
//   2. a single-use enrolment code bound to that target, plus its locator route.
//
// "Before the first boot" is not a preference. A `file_record` enrol failure that is not
// the narrow already-had-identity network case calls `proc.exit(1)`
// (`packages/worker-daemon/src/bin/worker-daemon.ts`), the D1 workers declare no `restart:`
// policy, and `docker compose up -d --wait` therefore FAILS. The pre-existing seed path
// (`seedScenario`) runs via `docker compose exec` AFTER the stack is up, so it is
// structurally too late: one `up --wait` cannot both seed and enrol.
//
// The migrate job is the one place that is early enough. It is a run-to-completion service
// holding the OWNER `DATABASE_URL` directly on data-net, and every other service gates on
// its `service_completed_successfully`. So the seed lands here, beside
// `provision-d1-serving-roles.mjs`, under the same STRICT gate: it runs only when
// `AOA_D1_SEED_WORKER_ENROLMENT=1`, which only `docker-compose.d1.yml` sets. It is inert on
// every non-D1 deploy path, and `migrate-entrypoint.sh` skips it otherwise.
//
// ── One artifact, read twice — why the ticket is a committed fixture ─────────
// The enrolment TICKET (`docker/d1/worker-b.enrollment-ticket`) is committed and bind-mounted
// READ-ONLY into two places: this job, which DECODES it to learn which code to authorize, and
// the worker, at the path its `AOA_WORKER_ENROLLMENT_CODE_FILE` names. Nothing generates it at
// runtime, so there is exactly ONE source of truth for the target id and the code, and a
// pre-merge guard (`docker/d1/__tests__/enrolment-seed.test.mjs`) can check that source
// against the worker's committed profile and against the two decoders that must accept it.
// A runtime-minted ticket would need a shared volume, would be unverifiable before merge, and
// would swap this file's determinism for a second thing that can drift.
//
// The code inside it is a THROWAWAY D1-harness credential with no authority outside this
// closed, four-internal-network stack — the same class as the committed self-signed TLS key
// under `docker/d1/certs/` and the literal `BETTER_AUTH_SECRET` in the compose. It is
// base64url-wrapped inside the ticket, so it does not appear as a literal `aoa_enr_…` string.
//
// ── The TTL, stated plainly ──────────────────────────────────────────────────
// The product TTL is 10 minutes (`server/src/services/worker-enrollment.ts` CODE_TTL_MS) and
// the enrol path enforces it against `expires_at` on BOTH the route and the code row. This
// seed writes a LONGER expiry (default 120 minutes) because it runs at migrate time while the
// worker enrols only after the control plane has booted and gone healthy — minutes on a warm
// runner, longer on a cold one. A 10-minute fixture would make the lane flaky and would prove
// nothing extra: expiry is a server property with its own unit and integration coverage, and
// this lane is proving CUSTODY plus the POSIX enrolment-input path. The value is an explicit
// input so it is visible rather than assumed.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Mirrors `packages/worker-daemon/src/enrollment/ticket.ts` ENROLLMENT_TICKET_PREFIX. */
export const ENROLLMENT_TICKET_PREFIX = "aoa_tkt_";
/** Mirrors that file's ENROLLMENT_TICKET_VERSION. */
export const ENROLLMENT_TICKET_VERSION = 1;
/** Mirrors that file's MAX_TICKET_BODY_LENGTH. */
export const MAX_TICKET_BODY_LENGTH = 512;
/** Mirrors `parseCode` in `server/src/services/worker-enrollment.ts` — the split this seed
 * must perform identically, because the two halves are hashed independently. */
export const ENROLLMENT_CODE_RE = /^aoa_enr_([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,128})$/;

export class EnrolmentSeedError extends Error {
  constructor(constraint) {
    // The CONSTRAINT NAME only, never the offending value: the input is a ticket carrying a
    // live bearer credential, and this message can reach a CI log.
    super(`enrolment seed rejected: ${constraint}`);
    this.name = "EnrolmentSeedError";
  }
}

/**
 * Decode a committed enrolment ticket into `{ v, targetId, code }`.
 *
 * A DELIBERATE MIRROR of `decodeEnrollmentTicket`
 * (`packages/worker-daemon/src/enrollment/ticket.ts`), not an import: the control-plane image
 * does not contain `packages/worker-daemon` and must not (E4-D01;
 * `docker/images/__tests__/dockerfile-static.test.mjs` asserts the Dockerfile never names it).
 * The exhaustive key-set check is kept rather than a destructure for the same reason the
 * original gives — a destructure silently accepts extra fields.
 *
 * The mirror is pinned by `docker/d1/__tests__/enrolment-seed.test.mjs`, which reads the
 * daemon's own source and fails if the constants above stop matching it. Without that pin a
 * codec change would land as a container crash-loop found only by a live bring-up.
 */
export function decodeEnrollmentTicket(raw) {
  if (typeof raw !== "string" || !raw.startsWith(ENROLLMENT_TICKET_PREFIX)) {
    throw new EnrolmentSeedError("missing or wrong ticket prefix");
  }
  const body = raw.slice(ENROLLMENT_TICKET_PREFIX.length);
  if (body.length === 0 || body.length > MAX_TICKET_BODY_LENGTH) {
    throw new EnrolmentSeedError("ticket body length out of bounds");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new EnrolmentSeedError("ticket body is not base64url");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new EnrolmentSeedError("ticket body is not decodable JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnrolmentSeedError("ticket body is not a JSON object");
  }
  const keys = Object.keys(parsed).sort();
  const expected = ["code", "targetId", "v"];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new EnrolmentSeedError("ticket has an unexpected key set");
  }
  if (parsed.v !== ENROLLMENT_TICKET_VERSION) {
    throw new EnrolmentSeedError("unsupported ticket version");
  }
  if (typeof parsed.targetId !== "string" || !parsed.targetId) {
    throw new EnrolmentSeedError("ticket targetId is missing");
  }
  if (typeof parsed.code !== "string" || !ENROLLMENT_CODE_RE.test(parsed.code)) {
    throw new EnrolmentSeedError("ticket code does not match the enrollment code shape");
  }
  return { v: parsed.v, targetId: parsed.targetId, code: parsed.code };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Split a code into the two independently-hashed halves the database stores.
 *
 * Byte-for-byte what `parseCode` (`server/src/services/worker-enrollment.ts`) does at enrol
 * time: `sha256` of each half as a UTF-8 STRING, never of decoded bytes. Getting that wrong
 * is not a loud failure — it is a code the server refuses as `unauthorized`, which for a
 * first boot is `proc.exit(1)` and a failed bring-up.
 */
export function hashEnrollmentCode(code) {
  const match = ENROLLMENT_CODE_RE.exec(code);
  if (!match) throw new EnrolmentSeedError("code does not match the enrollment code shape");
  return { locatorHash: sha256(match[1]), secretHash: sha256(match[2]) };
}

/**
 * The provider-constraint profile the seeded target ratifies.
 *
 * Copied in shape from `seedScenario` (`tests/d1/lib/e6f-harness.mjs`) because that exact
 * object is already known to pass `canonicalProviderConstraintProfileDigestInputV1` on the
 * live stack; only `profileId`/`version` come from the worker's own committed profile.
 * Placement consistency (locality tags against the profile's `dataLocalityCeiling`, etc.) is
 * deliberately out of scope: this ticket reaches ENROL, not dispatch, and the enrol response
 * reads only `target.capabilities.providerConstraints`.
 */
export function buildProviderConstraintProfile(profileId, version) {
  return {
    profileId,
    version,
    maxContinuousRuntimeSeconds: 3600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 8192 },
    maxConcurrentOperations: 8,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  };
}

/**
 * Derive the ratified `registered_profile` from the worker's OWN committed profile file.
 *
 * Reading `docker/d1/worker-*.profile.json` rather than restating its ids is what keeps three
 * things from drifting apart: the target id in the database, the target id in the ticket, and
 * the target id the shipped worker profile declares.
 *
 * The ONE substitution is `providerConstraints.digest`. The committed profile carries a
 * placeholder (`"1111…"` / `"2222…"`) and the row must carry a digest that is genuinely the
 * provider profile's own verified digest, so the substitution is explicit here rather than
 * silent in SQL.
 */
export function deriveRegisteredProfile(fileProfile, providerDigest) {
  return {
    ...fileProfile,
    providerConstraints: {
      profileId: fileProfile.providerConstraints.profileId,
      version: fileProfile.providerConstraints.version,
      digest: providerDigest,
    },
  };
}

/** `organization` ⇒ `organization:<uuid>`; `platform` ⇒ `platform`. Mirrors the
 * `execution_targets_authority_scope_check` constraint. */
export function targetAuthorityKey(profile) {
  if (profile.scope === "platform") return "platform";
  if (profile.scope === "organization") {
    if (!profile.organizationId) throw new EnrolmentSeedError("organization-scoped profile has no organizationId");
    return `organization:${profile.organizationId}`;
  }
  throw new EnrolmentSeedError(`unsupported target scope ${JSON.stringify(profile.scope)}`);
}

/** Strip exactly one trailing newline, mirroring the daemon's reader. */
function trimTicketText(text) {
  return text.trim();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new EnrolmentSeedError(`${name} is required`);
  }
  return value;
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const profilePath = requireEnv("AOA_D1_SEED_WORKER_PROFILE_FILE");
  const ticketPath = requireEnv("AOA_D1_SEED_ENROLMENT_TICKET_FILE");
  const ttlRaw = process.env.AOA_D1_SEED_ENROLMENT_TTL_MINUTES ?? "120";
  const ttlMinutes = Number(ttlRaw);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw new EnrolmentSeedError("AOA_D1_SEED_ENROLMENT_TTL_MINUTES must be an integer in [1,1440]");
  }

  // Imported lazily so the pure exports above stay importable by the guard self-test on a
  // plain checkout, where `postgres` and the built worker-protocol dist are not resolvable
  // from this directory. Inside the image both live under /cp-app/node_modules.
  const { default: postgres } = await import("postgres");
  const { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1 } =
    await import("@armyofagents/worker-protocol");

  const fileProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  const ticket = decodeEnrollmentTicket(trimTicketText(readFileSync(ticketPath, "utf8")));
  // The ticket and the profile must name the SAME target, or the seed would authorize a code
  // for one target while the worker presents a hello for another — which the server answers
  // `unauthorized`, i.e. a failed bring-up with a misleading cause. Checked here as well as in
  // the pre-merge guard, because this is the copy that runs against what is actually mounted.
  if (ticket.targetId !== fileProfile.targetId) {
    throw new EnrolmentSeedError("ticket targetId does not match the mounted worker profile targetId");
  }
  const code = hashEnrollmentCode(ticket.code);

  const provider = buildProviderConstraintProfile(
    fileProfile.providerConstraints.profileId,
    fileProfile.providerConstraints.version,
  );
  const providerDigest = sha256(Buffer.from(canonicalProviderConstraintProfileDigestInputV1(provider)));
  const providerProfile = { ...provider, digest: providerDigest };
  const registeredProfile = deriveRegisteredProfile(fileProfile, providerDigest);
  const registeredProfileHash = sha256(canonicalizeJsonV1(registeredProfile));
  const authorityKey = targetAuthorityKey(fileProfile);

  // `capabilities.providerConstraints` is what the ENROL RESPONSE builder reads
  // (`worker-enrollment.ts` providerConstraints(target.capabilities)). Without it
  // `enrollmentResponseV1Schema` rejects the response and the worker never receives a session.
  const capabilities = {
    providerConstraints: {
      profileId: providerProfile.profileId,
      version: providerProfile.version,
      digest: providerDigest,
    },
  };

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Idempotent throughout. The migrate job is declared idempotent and non-destructive, and a
    // re-run must not mint a second competing route for the same locator.
    if (fileProfile.organizationId) {
      await sql`INSERT INTO organizations (id, name, slug)
        VALUES (${fileProfile.organizationId}, ${"D1 Worker Enrolment"}, ${"d1-worker-enrolment"})
        ON CONFLICT (id) DO NOTHING`;
    }
    await sql`INSERT INTO execution_targets
      (id, organization_id, scope, target_authority_key, device_generation, slug, kind, trust_class,
       status, capabilities, registered_profile, registered_profile_hash, provider_constraint_profile,
       last_seen_at)
      VALUES (${fileProfile.targetId}, ${fileProfile.organizationId ?? null}, ${fileProfile.scope},
        ${authorityKey}, ${fileProfile.deviceGeneration}, ${"d1-enrolling-worker"},
        'dedicated_worker', 'dedicated_tenant', 'active', ${sql.json(capabilities)},
        ${sql.json(registeredProfile)}, ${registeredProfileHash}, ${sql.json(providerProfile)}, now())
      ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
      VALUES (${code.locatorHash}, ${fileProfile.organizationId ?? null},
        now() + make_interval(mins => ${ttlMinutes}))
      ON CONFLICT (locator_hash) DO NOTHING`;
    // No ON CONFLICT: `worker_enrollment_codes_locator_uq` makes a duplicate insert a hard
    // error, and on the ONE path where this job legitimately re-runs (a re-migrate against an
    // already-seeded database) the route insert above has already no-op'd, so this would be the
    // second row for the same locator — a state the enrol path cannot disambiguate. Guarded by
    // the NOT EXISTS instead of swallowed, so a genuine duplicate still fails the job closed.
    await sql`INSERT INTO worker_enrollment_codes
      (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
       expires_at, created_by_principal_kind, created_by_principal_id)
      SELECT ${fileProfile.organizationId ?? null}, ${fileProfile.scope}, ${fileProfile.targetId},
        ${authorityKey}, ${code.locatorHash}, ${code.secretHash},
        now() + make_interval(mins => ${ttlMinutes}), 'user', 'd1-worker-enrolment-seed'
      WHERE NOT EXISTS (
        SELECT 1 FROM worker_enrollment_codes WHERE locator_hash = ${code.locatorHash}
      )`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  // NEVER the code and never the ticket. `targetId` is an opaque id the server logs too.
  console.log(
    `seed-d1-worker-enrolment: target ${fileProfile.targetId} (${fileProfile.scope}) registered ACTIVE; ` +
      `single-use enrolment code authorized for ${ttlMinutes}m`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
