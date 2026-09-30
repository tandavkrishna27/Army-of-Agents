// -----------------------------------------------------------------------------
// E6-D1-FOUNDATION — reusable harness for the LIVE E6F worker-control suites
// (Linux/CI ONLY — requires Docker + a running docker-compose.d1.yml stack).
//
// This module is the shared substrate for the E6F Tier-2 suites (E6F-03 today;
// e6f-01-lease-races and e6f-04-tenancy later). It drives the control-plane's
// REAL `/api/worker-control/*` HTTP endpoints from inside the stack, simulating a
// worker with HTTP + Ed25519 device proofs. There is NO live worker-daemon loop:
// enroll/poll/ack are ordinary authenticated HTTP calls the harness makes itself.
//
// It exports three families, per the E6-D1-FOUNDATION plan:
//   1. device-proof construction  (generateDeviceKey + the in-container signer)
//   2. the enroll / poll / ack HTTP clients
//   3. the exec-seed helper       (seedScenario + stampWorkerLiveness)
//
// ── Transport ────────────────────────────────────────────────────────────────
// Every node invocation runs INSIDE a compose service via
// `docker compose exec -T <svc> node --input-type=module`, with the ESM source
// piped on STDIN (never argv — the seed + step scripts are multi-line and use
// crypto/fetch/postgres; argv quoting is unusable). The CI HOST orchestrates the
// exec calls; it never talks to postgres or the control-plane directly. The step
// scripts run in `test-runner` (a control-net peer that can reach
// control-plane:3100); the seed/liveness scripts run in `control-plane` (it holds
// the OWNER `DATABASE_URL` + the deployed server dist, incl.
// `@armyofagents/worker-protocol` and the `postgres` driver under WORKDIR /cp-app).
//
// ── Why seed inside the container (not test-support) ─────────────────────────
// Board routes need `actor.type==='board'`. The clean test-support session-mint
// seam is BLOCKED here: `assertTestSupportFlagSafe`
// (server/src/services/test-support-safety.ts) demands a loopback-only bind, but
// the D1 control-plane binds 0.0.0.0 (network-reachable by design), and the stack
// is `AOA_DEPLOYMENT_MODE=authenticated` (unauth'd MCP/board is rejected). So we
// seed by running a script inside the control-plane container whose DATABASE_URL
// is the OWNER role `aoa` — a SUPERUSER in the pgvector image (POSTGRES_USER=aoa),
// which BYPASSES RLS for writes exactly like the in-process integration tests'
// superuser `admin`. The server then READS those rows under aoa_app/aoa_operator
// with per-tenant GUCs via the ordinary deployed RLS policies (unchanged).
//
// ── Placement: direct SQL, not createJobPlacementService.place() ──────────────
// We seed the immutable `job_attempts` placement columns by direct SQL rather than
// composing the trusted placement service in the seed script. Reasons:
//   * `place()` wires resolveOrganizationPolicy/resolveWorkloadPolicy/
//     resolveCredentialBinding closures + a deploymentMode; reproducing that
//     faithfully inside a piped stdin script is far more fragile than SQL.
//   * job_attempts carries NO static-context/eligibility-version column — the poll
//     candidate SELECT (packages/db/.../tenant/job-control.ts lockEligibleLease-
//     Candidates) filters ONLY on the concrete placement columns
//     (status='pending', placement_disposition='selected', placement_mode='active',
//     placement_lease_eligible=true, placement_owner/target_id/target_class/
//     target_scope/target_generation/profile_hash/provider_constraint_hash), all of
//     which SQL can set exactly. The static-context hash is a negative-certificate
//     cache key only, never a candidate filter.
//   * We compute the two load-bearing digests with the SAME primitives the server
//     re-derives at poll time: placement_profile_hash = sha256(canonicalizeJsonV1(
//     registeredProfile)) and placement_provider_constraint_hash = the provider
//     profile's own verified digest = sha256(canonicalProviderConstraintProfile-
//     DigestInputV1(provider)). Both come from @armyofagents/worker-protocol so
//     there is zero canonicalizer drift. ackPlacementCurrent + the candidate SELECT
//     both compare against exactly these.
//
// ── Worker liveness ──────────────────────────────────────────────────────────
// The enroll service inserts the worker row WITHOUT last_seen_at
// (server/src/services/worker-enrollment.ts insertWorker sets enrolledAt only). The
// poll authority (server/src/services/job-leasing.ts authorityCurrent) requires a
// fresh worker.last_seen_at AND target.last_seen_at within maxHeartbeatAgeMs. A real
// daemon establishes that via its session heartbeat before polling; we simulate the
// same liveness with a post-enroll `UPDATE workers/execution_targets SET
// last_seen_at = now()` (stampWorkerLiveness). This weakens NO security check — it
// stamps a timestamp a live worker would stamp itself.
//
// ── Device proof (byte-exact; confirmed against source + vectors) ────────────
// Verifier: server/src/services/worker-device-proof.ts; signer reference:
// packages/worker-daemon/src/identity/device-proof.ts; vectors:
// tests/fixtures/device-proof/v1/vectors.json. The canonical string is the 7 lines
// joined by LF (no trailing newline):
//   1 "AOA-DEVICE-PROOF-V1"
//   2 METHOD.toUpperCase()
//   3 new URL(originalUrl,"https://aoa.invalid").pathname  (INCLUDES the /api prefix)
//   4 sha256hex(exact raw request body bytes)
//   5 correlationId  (== the JSON body's correlationId)
//   6 issuedAt       (ISO millis, round-trips new Date(s).toISOString()===s; ±5min)
//   7 proofId        (^[A-Za-z0-9_-]{8,128}$, unique per request — single-use)
// publicKey header = SPKI DER base64url; deviceThumbprint = sha256hex(DER bytes);
// signature = crypto.sign(null, canonicalBytes, ed25519PrivateKey).base64url. The
// same keypair is reused across enroll+poll+ack (poll/ack bind the session JWT's
// deviceThumbprint to the proof). We build the JSON body ONCE per request and hash
// exactly those bytes, so the server's sha256(rawBody) and
// JSON.stringify(JSON.parse(rawBody))===JSON.stringify(req.body) both hold.
// -----------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE = process.env.AOA_D1_LIVE === "1";
export const SKIP = LIVE
  ? false
  : "requires AOA_D1_LIVE=1 + a running docker-compose.d1.yml stack (Linux/CI only)";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const COMPOSE_FILE = path.join(repoRoot, "docker-compose.d1.yml");

// In-stack service endpoints (see docker-compose.d1.yml networks matrix).
export const CONTROL_PLANE_URL = "http://control-plane:3100";
export const FAKE_PROVIDER_API_URL = "http://fake-provider:8080";
export const FAKE_PROVIDER_CTL_URL = "http://fake-provider:8081";

// DEP-009 — the second interchangeable control-plane replica's in-stack base URL. The
// device proof is host-agnostic (it signs `new URL(url).pathname` only) and both replicas
// share AOA_WORKER_SESSION_SIGNING_KEY, so a session minted at one replica verifies at the
// other — enroll@A / poll@B is a single portable session (replica-agnostic acceptance).
export const CONTROL_PLANE_B_URL = "http://control-plane-b:3100";

/** The worker-control endpoint set for a given control-plane base URL. Parameterizes what
 * WORKER_CONTROL hardcodes to CONTROL_PLANE_URL, so a test can address replica A or B. The
 * enroll/poll/ack/events HTTP clients already accept a `url` param, so no client changes. */
export function workerControlFor(base) {
  return {
    enroll: `${base}/api/worker-control/enroll`,
    poll: `${base}/api/worker-control/poll`,
    ack: (leaseId) => `${base}/api/worker-control/leases/${leaseId}/ack`,
    events: `${base}/api/worker-control/events`,
    artifactTransferGrant: `${base}/api/worker-control/artifact-transfer-grants`,
    artifactCommit: `${base}/api/worker-control/artifact-commits`,
  };
}

export const WORKER_CONTROL = workerControlFor(CONTROL_PLANE_URL);
// DEP-009 — the replica-B endpoint set (same shape, control-plane-b base).
export const WORKER_CONTROL_B = workerControlFor(CONTROL_PLANE_B_URL);

// Single source of truth for the seeded target/worker capability + policy facts.
// The seed embeds POLICY_HASH + WORKER_CAPABILITIES into the registered target
// profile (capabilityCeiling) and the buildWorkerHello() output reuses them for
// reportedCapabilities/policyHash, so the poll-time matcher (workerSatisfies-
// Requirements: effective = ceiling ∩ reported, policyHash equality) is satisfied.
export const POLICY_HASH = "a".repeat(64);
export const WORKER_CAPABILITIES = ["workload.batch", "sandbox.process_isolated"];
// Free capacity: ≥ the bounded provider demand (cpu 1000 / mem 1024 / disk 1024)
// and ≤ the provider ceiling (cpu 2000 / mem 4096 / disk 8192), batchSlots ≥ 1.
export const WORKER_CAPACITY = Object.freeze({
  batchSlots: 2,
  browserSessionSlots: 0,
  serviceSlots: 0,
  freeCpuMillis: 2000,
  freeMemoryMiB: 4096,
  freeDiskMiB: 8192,
});

const RESULT_MARKER = "__E6F_RESULT__";

function uuid() {
  // RFC 4122 v4 (all id columns are UUID-typed).
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fresh, per-run identity so every live run is hermetic (own org/company/target/
 * worker/job/attempt/operation ids + a short slug for human-readable seed names). */
export function newScenarioIds() {
  return {
    slug: randomBytes(4).toString("hex"),
    orgId: uuid(),
    companyId: uuid(),
    targetId: uuid(),
    workerId: uuid(),
    jobId: uuid(),
    attemptId: uuid(),
    operationId: uuid(),
  };
}

/** Host-side Ed25519 device key. The PEM is threaded into each in-container step
 * script (each `docker exec` is a fresh process) so enroll/poll/ack all sign with
 * the SAME key — poll/ack assert proof.deviceThumbprint == the session's. */
export function generateDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: der.toString("base64url"),
    deviceThumbprint: createHash("sha256").update(der).digest("hex"),
  };
}

/** A worker-daemon enrollment code `aoa_enr_<locator>.<secret>` and the sha256-hex
 * of each half (matching server/src/services/worker-enrollment.ts issueTenantCode).
 * The hashes are what the seed inserts into worker_enrollment_code(_routes); the raw
 * code is presented on the `aoa-enrollment-code` header at enroll. */
export function newEnrollmentCode() {
  const locator = randomBytes(18).toString("base64url"); // 24 chars ∈ [16,64]
  const secret = randomBytes(32).toString("base64url"); //  43 chars ∈ [32,128]
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  return {
    code: `aoa_enr_${locator}.${secret}`,
    locatorHash: sha(locator),
    secretHash: sha(secret),
  };
}

/** The dynamic worker self-report (workerHelloV1). Reuses POLICY_HASH +
 * WORKER_CAPABILITIES + WORKER_CAPACITY so it satisfies the seeded target's
 * ceilings at poll-time matching. */
export function buildWorkerHello({ workerId, targetId, deviceGeneration = 1 }) {
  return {
    protocolVersion: 1,
    workerId,
    targetId,
    deviceGeneration,
    agentVersion: "e6f-03-harness",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "worker" },
    reportedCapabilities: [...WORKER_CAPABILITIES],
    capacity: { ...WORKER_CAPACITY },
    policyHash: POLICY_HASH,
  };
}

// ── Low-level in-container node runner ────────────────────────────────────────

/** Run an ESM script inside a compose service (source piped on STDIN). Returns the
 * exit status, raw stdout/stderr, and the parsed `__E6F_RESULT__` line if present. */
export function dexecModule(service, scriptSource, { timeout = 60_000 } = {}) {
  const res = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", service, "node", "--input-type=module"],
    { input: scriptSource, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 },
  );
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  let result = null;
  const idx = stdout.indexOf(RESULT_MARKER);
  if (idx >= 0) {
    const rest = stdout.slice(idx + RESULT_MARKER.length);
    const nl = rest.indexOf("\n");
    try {
      result = JSON.parse(nl >= 0 ? rest.slice(0, nl) : rest);
    } catch {
      result = null;
    }
  }
  return { status: res.status, error: res.error, stdout, stderr, result };
}

/** Embed a plain-data params object as a JS literal (JSON is a valid JS subset;
 * PEM newlines survive as escaped `\n`). None of our values contain backticks or
 * `${`, so template embedding is safe. */
function embedParams(params) {
  return `const P = ${JSON.stringify(params)};\n`;
}

// The in-container device-proof signer. `String.fromCharCode(10)` is the canonical
// LF join — this avoids ALL newline-escaping ambiguity in the emitted source.
const DEVICE_PROOF_SNIPPET = `
import { createHash, createPrivateKey, sign as edSign, randomUUID, randomBytes } from "node:crypto";
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
function deviceProofHeaders(opts) {
  const pathname = new URL(opts.url).pathname;
  const issuedAt = new Date().toISOString();
  const proofId = "e6f-" + randomBytes(12).toString("base64url");
  const bodyDigest = sha256hex(Buffer.from(opts.bodyString, "utf8"));
  const canonical = [
    "AOA-DEVICE-PROOF-V1",
    opts.method.toUpperCase(),
    pathname,
    bodyDigest,
    opts.correlationId,
    issuedAt,
    proofId,
  ].join(String.fromCharCode(10));
  const key = createPrivateKey(opts.privateKeyPem);
  const signature = edSign(null, Buffer.from(canonical, "utf8"), key).toString("base64url");
  return {
    "aoa-device-proof-version": "1",
    "aoa-device-public-key": opts.publicKeyDer,
    "aoa-device-signature": signature,
    "aoa-device-issued-at": issuedAt,
    "aoa-device-proof-id": proofId,
    "aoa-device-request-id": opts.correlationId,
  };
}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
function safeJson(text) { try { return JSON.parse(text); } catch { return text; } }
`;

// ── Seed + liveness (control-plane container; owner/superuser DB) ─────────────

/** Seed one hermetic org/company/organization-scoped execution target + enrollment
 * code + route + a queued batch job whose attempt is placed lease-eligible to that
 * target. Runs in `control-plane`. Returns { registeredProfileHash, providerDigest,
 * authorityKey } (the values the placement + enroll paths re-derive). */
export function seedScenario({ ids, code, policyHash = POLICY_HASH, capabilityCeiling = WORKER_CAPABILITIES }) {
  const params = {
    orgId: ids.orgId,
    companyId: ids.companyId,
    targetId: ids.targetId,
    jobId: ids.jobId,
    attemptId: ids.attemptId,
    operationId: ids.operationId,
    slug: ids.slug,
    locatorHash: code.locatorHash,
    secretHash: code.secretHash,
    policyHash,
    capabilityCeiling,
  };
  const script = `
import postgres from "postgres";
import { createHash } from "node:crypto";
import { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1 } from "@armyofagents/worker-protocol";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  // Provider-constraint profile — digest is its OWN verified digest (server recomputes
  // the same way via verifyAndBrandProviderConstraintProfileV1 at normalization).
  const providerUnsigned = {
    profileId: "e6f-org-dedicated",
    version: 1,
    maxContinuousRuntimeSeconds: 3600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 8192 },
    maxConcurrentOperations: 8,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  };
  const providerDigest = sha256(Buffer.from(canonicalProviderConstraintProfileDigestInputV1(providerUnsigned)));
  const provider = { ...providerUnsigned, digest: providerDigest };
  const authorityKey = "organization:" + P.orgId;
  // Registered organization-scoped target profile (mirrors the JOB-009 integration
  // test's organizationProfile). registered_profile_hash = sha256(canonicalizeJsonV1(profile)).
  const registeredProfile = {
    protocolVersion: 1,
    targetId: P.targetId,
    targetClass: "organization_dedicated",
    scope: "organization",
    organizationId: P.orgId,
    ownerPrincipalId: null,
    trustCeiling: "organization_isolated",
    credentialCeiling: "organization_brokered",
    dataLocalityCeiling: "organization_target_only",
    providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
    capabilityCeiling: P.capabilityCeiling,
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: P.policyHash,
  };
  const registeredProfileHash = sha256(canonicalizeJsonV1(registeredProfile));

  // companies.issue_prefix is GLOBALLY UNIQUE (companies_issue_prefix_idx), so it
  // must be derived per-scenario, not hardcoded — otherwise two seedScenario callers
  // in the SAME campaign (e.g. E6F-03 + E6F-05, one shared DB) collide on the second
  // insert. Mirror the seedRaceOrg pattern: a slug-derived, length-bounded prefix.
  const issuePrefix = ("E6F" + P.slug).slice(0, 12).toUpperCase();
  await sql\`INSERT INTO organizations (id, name, slug)
    VALUES (\${P.orgId}, \${"E6F Org " + P.slug}, \${"e6f-" + P.slug})\`;
  await sql\`INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (\${P.companyId}, \${P.orgId}, \${"E6F Company " + P.slug}, \${issuePrefix})\`;
  // Organization-scoped registered target (kind/trust must map to targetClass in the
  // resolver: dedicated_worker + dedicated_tenant -> organization_dedicated).
  // capabilities carries the providerConstraints ref the ENROLL RESPONSE builder reads
  // (worker-enrollment.ts providerConstraints(target.capabilities)); provider_constraint_profile
  // is the separate placement/branding column. Both must be set or enrollmentResponseV1Schema
  // rejects the enrolled receipt (no aoa-worker-session header) and every downstream step fails.
  const targetCapabilities = { providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest } };
  await sql\`INSERT INTO execution_targets
    (id, organization_id, scope, target_authority_key, device_generation, slug, kind, trust_class,
     status, capabilities, registered_profile, registered_profile_hash, provider_constraint_profile, last_seen_at)
    VALUES (\${P.targetId}, \${P.orgId}, 'organization', \${authorityKey}, 1, \${"e6f-target-" + P.slug},
      'dedicated_worker', 'dedicated_tenant', 'active', \${sql.json(targetCapabilities)}, \${sql.json(registeredProfile)},
      \${registeredProfileHash}, \${sql.json(provider)}, now())\`;
  // Enrollment route (locator -> candidate org) + single-use code (secret hash).
  await sql\`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
    VALUES (\${P.locatorHash}, \${P.orgId}, now() + interval '10 minutes')\`;
  await sql\`INSERT INTO worker_enrollment_codes
    (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
     expires_at, created_by_principal_kind, created_by_principal_id)
    VALUES (\${P.orgId}, 'organization', \${P.targetId}, \${authorityKey}, \${P.locatorHash}, \${P.secretHash},
      now() + interval '10 minutes', 'user', 'e6f-seed')\`;
  // Queued batch job whose source_intent + input build a valid batch job envelope.
  const sourceIntent = { kind: "one_shot", operationId: P.operationId, operationKind: "readiness_probe" };
  const workload = { command: "true", args: [], stdinArtifactId: null, maxRuntimeSeconds: 600 };
  const requirements = { workloadType: "batch", requiredCapabilities: [] };
  const placementRequest = { policyId: "job-submission-default", policyVersion: 1, requestedTarget: null };
  await sql\`INSERT INTO jobs
    (id, organization_id, company_id, workload_type, source_kind, source_intent, input, input_hash,
     policy_hash, requirements, placement_request, status, available_at)
    VALUES (\${P.jobId}, \${P.orgId}, \${P.companyId}, 'batch', 'one_shot', \${sql.json(sourceIntent)},
      \${sql.json(workload)}, \${"b".repeat(64)}, \${P.policyHash}, \${sql.json(requirements)},
      \${sql.json(placementRequest)}, 'queued', now())\`;
  // Immutable, lease-eligible placement decision (matches job_attempts_placement_atomic_check
  // AND the lockEligibleLeaseCandidates SELECT AND ackPlacementCurrent). profile/provider
  // hashes equal the normalized target's, so the poll re-validation lines up exactly.
  await sql\`INSERT INTO job_attempts
    (id, organization_id, company_id, job_id, attempt_number, status,
     placement_disposition, placement_owner, placement_target_id, placement_target_class,
     placement_target_scope, placement_target_generation, placement_profile_hash,
     placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
     placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
     placement_decided_at)
    VALUES (\${P.attemptId}, \${P.orgId}, \${P.companyId}, \${P.jobId}, 1, 'pending',
      'selected', 'organization_dedicated', \${P.targetId}, 'organization_dedicated',
      'organization', 1, \${registeredProfileHash}, \${providerDigest}, 'primary', 'target_selected',
      'active', true, \${"c".repeat(64)}, \${"d".repeat(64)}, now())\`;

  report({ ok: true, registeredProfileHash, providerDigest, authorityKey });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** Post-enroll worker liveness (see header). Stamps last_seen_at on the enroll-created
 * worker + its target so the FIRST poll's authorityCurrent heartbeat gate passes. */
export function stampWorkerLiveness({ workerId, targetId }) {
  const script = `
import postgres from "postgres";
${embedParams({ workerId, targetId })}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const w = await sql\`UPDATE workers SET last_seen_at = now(), updated_at = now()
    WHERE id = \${P.workerId} AND execution_target_id = \${P.targetId} RETURNING id, status\`;
  const t = await sql\`UPDATE execution_targets SET last_seen_at = now(), updated_at = now()
    WHERE id = \${P.targetId} RETURNING id\`;
  console.log("${RESULT_MARKER}" + JSON.stringify({ workerUpdated: w.length, targetUpdated: t.length }));
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

// ── Worker-control HTTP clients (test-runner container) ──────────────────────

/** Enroll a fresh worker. Presents the raw code + a real device proof over the
 * exact body bytes; returns { status, session, body }. session = the
 * `aoa-worker-session` response header (the JWT poll/ack present as Bearer). */
export function enroll({ url = WORKER_CONTROL.enroll, code, hello, deviceKey }) {
  const params = { url, code, hello, privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "target_enrollment",
  idempotencyKey: randomUUID(),
  hello: P.hello,
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["aoa-enrollment-code"] = P.code;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, session: res.headers.get("aoa-worker-session"), body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Poll for a lease offer. Bearer session JWT + a fresh device proof; returns
 * { status, body } where body is the pollResponseV1 (outcome offer|no_work|drain). */
export function poll({ url = WORKER_CONTROL.poll, session, workerId, targetId, deviceGeneration = 1, capacity = WORKER_CAPACITY, deviceKey }) {
  const params = { url, session, workerId, targetId, deviceGeneration, capacity, privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "worker_poll",
  workerId: P.workerId,
  targetId: P.targetId,
  deviceGeneration: P.deviceGeneration,
  capacity: P.capacity,
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["authorization"] = "Bearer " + P.session;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Acknowledge a lease. The ack URL carries the leaseId (route asserts
 * body.leaseId === :leaseId). Returns { status, body } (leaseAckOperationResponseV1). */
export function ack({ session, workerId, jobId, attempt, leaseId, fenceToken, deviceKey }) {
  const url = WORKER_CONTROL.ack(leaseId);
  const params = { url, session, workerId, jobId, attempt, leaseId, fenceToken, privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "worker_run",
  idempotencyKey: randomUUID(),
  body: {
    protocolVersion: 1,
    workerId: P.workerId,
    jobId: P.jobId,
    attempt: P.attempt,
    leaseId: P.leaseId,
    fenceToken: P.fenceToken,
    ackedAt: new Date().toISOString(),
  },
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["authorization"] = "Bearer " + P.session;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Generic single JSON fetch from a container (used to drive the fake provider). */
export function containerFetch(service, { url, method = "GET", body }) {
  const params = { url, method, body: body ?? null };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const init = { method: P.method, headers: {} };
if (P.body !== null) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(P.body); }
const res = await fetch(P.url, init);
const text = await res.text();
let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
report({ status: res.status, body: parsed });
`;
  return dexecModule(service, script);
}

// ─────────────────────────────────────────────────────────────────────────────
// E6F-01 lease-race additions (ADDITIVE ONLY — nothing above is modified).
//
// Everything above is the frozen, LIVE-GREEN E6F-03 substrate. The helpers below
// only ADD what the 100-race lease suite needs on top of it; they never change the
// behaviour or signature of any existing export (E6F-03 keeps passing).
//
// ── Why a distinct "race" capacity/provider profile ──────────────────────────
// A single dedicated worker's concurrent in-flight leases are bounded at poll time
// by min(provider.maxConcurrentOperations, hello.capacity.batchSlots) — see
// server/src/services/job-leasing.ts deriveAdmissibleWorkloadTypes +
// snapshotLiveLeaseCapacity (leases in status offered|active both count). Enrollment
// binds EXACTLY ONE worker per execution_target (worker-enrollment.ts
// findWorkerForBinding -> worker_transfer_denied on a second worker), so a target's
// whole job pool is drained by its one worker. To let that one worker hold an entire
// per-target pool of leases at once (submit->placement->lease->ACK, with no job
// COMPLETION step in this gate to free a slot), the race target's server-owned
// provider profile advertises a high maxConcurrentOperations and the worker's hello
// a matching batchSlots — both still schema-valid (maxConcurrentOperations<=10_000;
// batchSlots is a non-negative int) and both fully seed-controlled. E6F-03's
// WORKER_CAPACITY / buildWorkerHello / seedScenario are left exactly as they were.
// ─────────────────────────────────────────────────────────────────────────────

/** The race worker's free-capacity report. Identical to WORKER_CAPACITY except
 * `batchSlots` is raised to `batchSlots` so ONE dedicated worker may hold an entire
 * per-target pool of concurrent leases. freeCpu/mem/disk stay AT the provider ceiling
 * (never above — workerSatisfiesRequirements §7 rejects free > ceiling). */
export function raceCapacity(batchSlots) {
  return {
    batchSlots,
    browserSessionSlots: 0,
    serviceSlots: 0,
    freeCpuMillis: 2000,
    freeMemoryMiB: 4096,
    freeDiskMiB: 8192,
  };
}

/** A workerHelloV1 for a race worker: byte-shape-identical to buildWorkerHello()
 * except the capacity carries the raised `batchSlots`. reportedCapabilities +
 * policyHash stay POLICY_HASH/WORKER_CAPABILITIES so the poll-time capability matcher
 * (effective = ceiling ∩ reported, policyHash equality) is satisfied exactly as in
 * E6F-03. */
export function buildRaceWorkerHello({ workerId, targetId, deviceGeneration = 1, batchSlots }) {
  return {
    protocolVersion: 1,
    workerId,
    targetId,
    deviceGeneration,
    agentVersion: "e6f-01-harness",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "worker" },
    reportedCapabilities: [...WORKER_CAPABILITIES],
    capacity: raceCapacity(batchSlots),
    policyHash: POLICY_HASH,
  };
}

/** Fresh, per-run identity for the race scenario: one org/company + `targetCount`
 * organization-scoped targets (each its own target/worker/enrollment-code) + a
 * per-run globally-unique company issue prefix (E6F-03 hardcodes 'E6F' and never
 * cleans up, so E6F-01 MUST NOT reuse it on the same live stack). */
export function newRaceScenarioIds({ targetCount }) {
  const slug = randomBytes(4).toString("hex");
  return {
    slug,
    orgId: uuid(),
    companyId: uuid(),
    // issue_prefix is globally UNIQUE (companies_issue_prefix_idx); derive a
    // per-run value distinct from E6F-03's 'E6F'. No format constraint on the column.
    issuePrefix: ("E6R" + slug).slice(0, 12).toUpperCase(),
    targets: Array.from({ length: targetCount }, (_unused, index) => ({
      index,
      targetId: uuid(),
      workerId: uuid(),
      slug: `e6r-target-${slug}-${index}`,
      deviceKey: generateDeviceKey(),
      code: newEnrollmentCode(),
    })),
  };
}

/** Seed the ENTIRE race scenario in ONE control-plane exec: one org+company, N
 * organization-scoped registered targets (each a lease-eligible registered profile
 * + enrollment code/route), and M queued batch jobs whose immutable attempts are
 * placed lease-eligible to a specific target (job.targetIndex). Direct SQL under the
 * owner/superuser DATABASE_URL exactly like seedScenario; the server READS these rows
 * under aoa_app via the deployed RLS policies. The two load-bearing digests are the
 * SAME worker-protocol primitives the poll re-derives (zero canonicalizer drift).
 *
 * `jobs` is `[{ jobId, attemptId, targetIndex }]`. Returns per-target
 * { targetId, registeredProfileHash, providerDigest, authorityKey }. */
export function seedRaceScenario({
  orgId,
  companyId,
  slug,
  issuePrefix,
  targets,
  jobs,
  capacityCeiling,
  policyHash = POLICY_HASH,
  capabilityCeiling = WORKER_CAPABILITIES,
}) {
  const params = {
    orgId,
    companyId,
    slug,
    issuePrefix,
    policyHash,
    capabilityCeiling,
    capacityCeiling,
    targets: targets.map((target) => ({
      targetId: target.targetId,
      slug: target.slug,
      locatorHash: target.code.locatorHash,
      secretHash: target.code.secretHash,
    })),
    jobs,
  };
  const script = `
import postgres from "postgres";
import { createHash } from "node:crypto";
import { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1 } from "@armyofagents/worker-protocol";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  // ONE shared provider-constraint profile (its digest is its OWN verified digest).
  // maxConcurrentOperations is raised so one dedicated worker may hold a whole pool.
  const providerUnsigned = {
    profileId: "e6f-org-dedicated",
    version: 1,
    maxContinuousRuntimeSeconds: 3600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 8192 },
    maxConcurrentOperations: P.capacityCeiling,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  };
  const providerDigest = sha256(Buffer.from(canonicalProviderConstraintProfileDigestInputV1(providerUnsigned)));
  const provider = { ...providerUnsigned, digest: providerDigest };
  const authorityKey = "organization:" + P.orgId;

  await sql\`INSERT INTO organizations (id, name, slug)
    VALUES (\${P.orgId}, \${"E6F Race Org " + P.slug}, \${"e6r-" + P.slug})\`;
  await sql\`INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (\${P.companyId}, \${P.orgId}, \${"E6F Race Company " + P.slug}, \${P.issuePrefix})\`;

  // Per-target registered profile (distinct targetId -> distinct registered_profile_hash;
  // jobs are isolated per target by placement_target_id + placement_profile_hash). All
  // organization-scoped targets in one org SHARE authority key 'organization:<org>'
  // (execution_targets_authority_scope_check), which is correct — routing is by target id.
  const targetFacts = [];
  for (let i = 0; i < P.targets.length; i += 1) {
    const t = P.targets[i];
    const registeredProfile = {
      protocolVersion: 1,
      targetId: t.targetId,
      targetClass: "organization_dedicated",
      scope: "organization",
      organizationId: P.orgId,
      ownerPrincipalId: null,
      trustCeiling: "organization_isolated",
      credentialCeiling: "organization_brokered",
      dataLocalityCeiling: "organization_target_only",
      providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
      capabilityCeiling: P.capabilityCeiling,
      deviceGeneration: 1,
      revokedAt: null,
      policyHash: P.policyHash,
    };
    const registeredProfileHash = sha256(canonicalizeJsonV1(registeredProfile));
    const targetCapabilities = { providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest } };
    await sql\`INSERT INTO execution_targets
      (id, organization_id, scope, target_authority_key, device_generation, slug, kind, trust_class,
       status, capabilities, registered_profile, registered_profile_hash, provider_constraint_profile, last_seen_at)
      VALUES (\${t.targetId}, \${P.orgId}, 'organization', \${authorityKey}, 1, \${t.slug},
        'dedicated_worker', 'dedicated_tenant', 'active', \${sql.json(targetCapabilities)}, \${sql.json(registeredProfile)},
        \${registeredProfileHash}, \${sql.json(provider)}, now())\`;
    await sql\`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
      VALUES (\${t.locatorHash}, \${P.orgId}, now() + interval '30 minutes')\`;
    await sql\`INSERT INTO worker_enrollment_codes
      (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
       expires_at, created_by_principal_kind, created_by_principal_id)
      VALUES (\${P.orgId}, 'organization', \${t.targetId}, \${authorityKey}, \${t.locatorHash}, \${t.secretHash},
        now() + interval '30 minutes', 'user', 'e6f-seed')\`;
    targetFacts.push({ targetId: t.targetId, registeredProfileHash, providerDigest, authorityKey });
  }

  // M queued batch jobs, each with an immutable lease-eligible attempt placed to its
  // routed target. idempotency_key/authenticated_* keep their column DEFAULTS (fresh
  // uuid idempotency key per row -> no jobs_submission_idempotency_uq collision).
  const workload = { command: "true", args: [], stdinArtifactId: null, maxRuntimeSeconds: 600 };
  const requirements = { workloadType: "batch", requiredCapabilities: [] };
  const placementRequest = { policyId: "job-submission-default", policyVersion: 1, requestedTarget: null };
  for (let j = 0; j < P.jobs.length; j += 1) {
    const job = P.jobs[j];
    const fact = targetFacts[job.targetIndex];
    const sourceIntent = { kind: "one_shot", operationId: job.jobId, operationKind: "readiness_probe" };
    await sql\`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_intent, input, input_hash,
       policy_hash, requirements, placement_request, status, available_at)
      VALUES (\${job.jobId}, \${P.orgId}, \${P.companyId}, 'batch', 'one_shot', \${sql.json(sourceIntent)},
        \${sql.json(workload)}, \${"b".repeat(64)}, \${P.policyHash}, \${sql.json(requirements)},
        \${sql.json(placementRequest)}, 'queued', now())\`;
    await sql\`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at)
      VALUES (\${job.attemptId}, \${P.orgId}, \${P.companyId}, \${job.jobId}, 1, 'pending',
        'selected', 'organization_dedicated', \${fact.targetId}, 'organization_dedicated',
        'organization', 1, \${fact.registeredProfileHash}, \${fact.providerDigest}, 'primary', 'target_selected',
        'active', true, \${"c".repeat(64)}, \${"d".repeat(64)}, now())\`;
  }

  report({ ok: true, targets: targetFacts, jobCount: P.jobs.length });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script, { timeout: 120_000 });
}

/** Batch post-enroll liveness stamp (see stampWorkerLiveness for the rationale) for
 * MANY worker/target pairs in ONE control-plane exec. Returns totals. */
export function stampWorkersLiveness(pairs) {
  const script = `
import postgres from "postgres";
${embedParams({ pairs })}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  let workerUpdated = 0;
  let targetUpdated = 0;
  for (const pair of P.pairs) {
    const w = await sql\`UPDATE workers SET last_seen_at = now(), updated_at = now()
      WHERE id = \${pair.workerId} AND execution_target_id = \${pair.targetId} RETURNING id\`;
    const t = await sql\`UPDATE execution_targets SET last_seen_at = now(), updated_at = now()
      WHERE id = \${pair.targetId} RETURNING id\`;
    workerUpdated += w.length;
    targetUpdated += t.length;
  }
  console.log("${RESULT_MARKER}" + JSON.stringify({ workerUpdated, targetUpdated, pairs: P.pairs.length }));
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script, { timeout: 60_000 });
}

// ── Concurrent lease-race runner (ALL concurrency lives INSIDE one test-runner
//    exec; the CI host never fans out ~100 `docker exec` calls) ────────────────
//
// Every poll and every ack signs a FRESH single-use device proof (fresh proofId +
// correlationId) with its worker's OWN keypair — the DEVICE_PROOF_SNIPPET's
// randomBytes-per-call is concurrency-safe, so overlapping in-process requests never
// reuse a proofId (the server records them single-use in worker_proof_replays).
//
//   focused: N concurrent polls from ONE worker at ONE seeded job. The target
//            FOR UPDATE serialization + compare-and-set pending->offered +
//            leases_active_per_attempt_idx guarantee EXACTLY ONE poll gets an
//            `offer` and the other N-1 get `no_work` (200, never a 5xx/second offer).
//   drain:   each drain worker loops waves of `waveSize` concurrent polls, acking
//            each offer immediately (chained on its poll, well within the ack
//            deadline), until a wave yields zero offers (pool drained). Drain workers
//            run under one Promise.all so distinct targets truly race concurrently.
//
// Returns { focused, drain } with per-offer leaseId/jobId/attempt + ack status so the
// caller can assert 100 distinct leases/jobs, one winner each, and zero anomalies.
export function runLeaseRace({
  pollUrl = WORKER_CONTROL.poll,
  ackPrefix = `${CONTROL_PLANE_URL}/api/worker-control/leases/`,
  ackSuffix = "/ack",
  deviceGeneration = 1,
  capacity,
  focused,
  drain,
  maxWaves,
  timeout = 300_000,
}) {
  const params = { pollUrl, ackPrefix, ackSuffix, deviceGeneration, capacity, focused, drain, maxWaves };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}

async function pollOnce(w) {
  // Honor the E1 retry contract: a RETRYABLE backpressure response
  // (internal_unavailable / throttled, carrying retryAfterMs) is NOT an anomaly —
  // it is the control-plane shedding load under the 100-race burst, and a real
  // worker waits retryAfterMs and re-polls. Surfacing it as an anomaly is stricter
  // than the protocol guarantees (a runner-load flake). Retry a bounded number of
  // times with a fresh nonce + device proof each attempt (both are single-use); the
  // compare-and-set offerLease means a retry can only win a still-pending job or get
  // no_work, so the "exactly one winner" race invariant is preserved.
  const RETRYABLE = new Set(["internal_unavailable", "throttled"]);
  const MAX_ATTEMPTS = 4;
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const body = {
      protocolVersion: 1,
      correlationId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("base64url"),
      audience: "worker_poll",
      workerId: w.workerId,
      targetId: w.targetId,
      deviceGeneration: P.deviceGeneration,
      capacity: P.capacity,
    };
    const bodyString = JSON.stringify(body);
    const headers = deviceProofHeaders({
      method: "POST", url: P.pollUrl, bodyString, correlationId: body.correlationId,
      privateKeyPem: w.privateKeyPem, publicKeyDer: w.publicKeyDer,
    });
    headers["content-type"] = "application/json";
    headers["authorization"] = "Bearer " + w.session;
    const res = await fetch(P.pollUrl, { method: "POST", headers, body: bodyString });
    const text = await res.text();
    last = { status: res.status, body: safeJson(text) };
    const code = last.body && last.body.code;
    if (last.status < 500 || !RETRYABLE.has(code)) return last;
    if (attempt < MAX_ATTEMPTS - 1) {
      const retryAfterMs = Number(last.body && last.body.retryAfterMs);
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(retryAfterMs) ? retryAfterMs : 200, 500)));
    }
  }
  return last;
}

async function ackOnce(w, offer) {
  const url = P.ackPrefix + offer.leaseId + P.ackSuffix;
  const body = {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString("base64url"),
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: w.workerId,
      jobId: offer.jobId,
      attempt: offer.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ackedAt: new Date().toISOString(),
    },
  };
  const bodyString = JSON.stringify(body);
  const headers = deviceProofHeaders({
    method: "POST", url, bodyString, correlationId: body.correlationId,
    privateKeyPem: w.privateKeyPem, publicKeyDer: w.publicKeyDer,
  });
  headers["content-type"] = "application/json";
  headers["authorization"] = "Bearer " + w.session;
  const res = await fetch(url, { method: "POST", headers, body: bodyString });
  const text = await res.text();
  return { status: res.status, body: safeJson(text) };
}

function offerOf(pollRes) {
  if (pollRes.status === 200 && pollRes.body && pollRes.body.outcome === "offer" && pollRes.body.body) {
    const o = pollRes.body.body;
    return {
      leaseId: o.leaseId,
      fenceToken: o.fenceToken,
      workerId: o.workerId,
      jobId: o.job && o.job.jobId,
      attempt: o.job && o.job.attempt,
    };
  }
  return null;
}
const isNoWork = (r) => r.status === 200 && r.body && r.body.outcome === "no_work";

// Focused single-job race: N concurrent polls, exactly one winner.
const focusedPolls = await Promise.all(
  Array.from({ length: P.focused.concurrency }, () => pollOnce(P.focused)),
);
const focusedOffers = focusedPolls.map(offerOf).filter(Boolean);
const focusedNoWork = focusedPolls.filter(isNoWork).length;
const focusedOther = focusedPolls
  .filter((r) => offerOf(r) === null && !isNoWork(r))
  .map((r) => ({ status: r.status, body: r.body }));
let focusedAck = null;
if (focusedOffers.length === 1) {
  focusedAck = await ackOnce(P.focused, focusedOffers[0]);
}

// Drain: each worker races its own pool; workers run concurrently.
async function drainWorker(w) {
  const offers = [];
  const anomalies = [];
  let pollCount = 0;
  let noWorkCount = 0;
  let waves = 0;
  const cap = P.maxWaves;
  while (waves < cap) {
    waves += 1;
    const waveResults = await Promise.all(
      Array.from({ length: w.waveSize }, async () => {
        const pr = await pollOnce(w);
        pollCount += 1;
        if (isNoWork(pr)) { noWorkCount += 1; return { kind: "no_work" }; }
        const off = offerOf(pr);
        if (off) {
          const ackRes = await ackOnce(w, off);
          return {
            kind: "offer",
            offer: off,
            ackStatus: ackRes.status,
            ackOutcome: ackRes.body && ackRes.body.outcome,
            ackLeaseId: ackRes.body && ackRes.body.leaseId,
            ackBody: ackRes.status === 200 ? null : ackRes.body,
          };
        }
        return { kind: "anomaly", status: pr.status, body: pr.body };
      }),
    );
    let waveOffers = 0;
    for (const r of waveResults) {
      if (r.kind === "offer") { offers.push(r); waveOffers += 1; }
      else if (r.kind === "anomaly") { anomalies.push(r); }
    }
    if (waveOffers === 0) break;
  }
  return { workerId: w.workerId, targetId: w.targetId, offers, anomalies, pollCount, noWorkCount, waves };
}
const drainResults = await Promise.all(P.drain.map(drainWorker));

report({
  focused: {
    totalPolls: focusedPolls.length,
    offers: focusedOffers,
    noWork: focusedNoWork,
    other: focusedOther,
    ack: focusedAck,
  },
  drain: drainResults,
});
`;
  return dexecModule("test-runner", script, { timeout });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEP-009 two-replica concurrency runner (ADDITIVE ONLY — nothing above is modified).
//
// runReplicaRace is a clone of runLeaseRace whose poll/ack requests each carry their OWN
// control-plane base (replica A `http://control-plane:3100` or B `http://control-plane-b:3100`),
// so a single test-runner exec can race concurrent traffic across BOTH replicas over the one
// shared PostgreSQL. ALL concurrency lives INSIDE this one `dexecModule("test-runner")` exec —
// the campaign is `--test-concurrency=1` serial, so a test must not fan out its own
// `docker exec` calls. Every poll and every ack signs a FRESH single-use device proof
// (randomBytes-per-call is concurrency-safe), so overlapping in-process requests never reuse
// a proofId. `requests` is an array of poll specs, each:
//   { replica, pollUrl, ackPrefix, ackSuffix?, session, workerId, targetId, privateKeyPem,
//     publicKeyDer }
// Each spec polls ONCE (honoring the E1 retryable-backpressure contract with a fresh proof);
// on an `offer` it immediately acks via ITS replica's ackPrefix. Returns { results: [...] }
// with per-request { replica, outcome: "offer"|"no_work"|"other", offer?, ackStatus?,
// ackOutcome?, status?, body? } so the caller can assert exactly-one-winner across replicas,
// a shared cap, and a shared rate-limit window.
export function runReplicaRace({ requests, deviceGeneration = 1, capacity, timeout = 180_000 }) {
  const params = { requests, deviceGeneration, capacity };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}

async function pollOnce(spec) {
  // Same retryable-backpressure handling as runLeaseRace: a 5xx internal_unavailable/throttled
  // carrying retryAfterMs is the control-plane shedding load, not an anomaly — retry with a
  // fresh nonce + device proof (both single-use). The compare-and-set offerLease keeps the
  // exactly-one-winner invariant across the retry.
  const RETRYABLE = new Set(["internal_unavailable", "throttled"]);
  const MAX_ATTEMPTS = 4;
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const body = {
      protocolVersion: 1,
      correlationId: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("base64url"),
      audience: "worker_poll",
      workerId: spec.workerId,
      targetId: spec.targetId,
      deviceGeneration: P.deviceGeneration,
      capacity: P.capacity,
    };
    const bodyString = JSON.stringify(body);
    const headers = deviceProofHeaders({
      method: "POST", url: spec.pollUrl, bodyString, correlationId: body.correlationId,
      privateKeyPem: spec.privateKeyPem, publicKeyDer: spec.publicKeyDer,
    });
    headers["content-type"] = "application/json";
    headers["authorization"] = "Bearer " + spec.session;
    const res = await fetch(spec.pollUrl, { method: "POST", headers, body: bodyString });
    const text = await res.text();
    last = { status: res.status, body: safeJson(text) };
    const code = last.body && last.body.code;
    if (last.status < 500 || !RETRYABLE.has(code)) return last;
    if (attempt < MAX_ATTEMPTS - 1) {
      const retryAfterMs = Number(last.body && last.body.retryAfterMs);
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(retryAfterMs) ? retryAfterMs : 200, 500)));
    }
  }
  return last;
}

async function ackOnce(spec, offer) {
  const url = spec.ackPrefix + offer.leaseId + (spec.ackSuffix || "/ack");
  const body = {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString("base64url"),
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: spec.workerId,
      jobId: offer.jobId,
      attempt: offer.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ackedAt: new Date().toISOString(),
    },
  };
  const bodyString = JSON.stringify(body);
  const headers = deviceProofHeaders({
    method: "POST", url, bodyString, correlationId: body.correlationId,
    privateKeyPem: spec.privateKeyPem, publicKeyDer: spec.publicKeyDer,
  });
  headers["content-type"] = "application/json";
  headers["authorization"] = "Bearer " + spec.session;
  const res = await fetch(url, { method: "POST", headers, body: bodyString });
  const text = await res.text();
  return { status: res.status, body: safeJson(text) };
}

function offerOf(pollRes) {
  if (pollRes.status === 200 && pollRes.body && pollRes.body.outcome === "offer" && pollRes.body.body) {
    const o = pollRes.body.body;
    return {
      leaseId: o.leaseId,
      fenceToken: o.fenceToken,
      workerId: o.workerId,
      jobId: o.job && o.job.jobId,
      attempt: o.job && o.job.attempt,
    };
  }
  return null;
}
const isNoWork = (r) => r.status === 200 && r.body && r.body.outcome === "no_work";

// Race EVERY request concurrently across the two replicas inside this ONE exec.
const results = await Promise.all(P.requests.map(async (spec) => {
  const pr = await pollOnce(spec);
  if (isNoWork(pr)) return { replica: spec.replica, outcome: "no_work" };
  const off = offerOf(pr);
  if (off) {
    const ackRes = await ackOnce(spec, off);
    return {
      replica: spec.replica,
      outcome: "offer",
      offer: off,
      ackStatus: ackRes.status,
      ackOutcome: ackRes.body && ackRes.body.outcome,
      ackLeaseId: ackRes.body && ackRes.body.leaseId,
      ackBody: ackRes.status === 200 ? null : ackRes.body,
    };
  }
  return { replica: spec.replica, outcome: "other", status: pr.status, body: pr.body };
}));

report({ results });
`;
  return dexecModule("test-runner", script, { timeout });
}

// ─────────────────────────────────────────────────────────────────────────────
// E6F-04 available-path tenancy additions (ADDITIVE ONLY — nothing above is
// modified). Everything above is the frozen LIVE-GREEN E6F-03/E6F-01 substrate;
// this helper only ADDS the per-org seed the tenancy matrix needs and never
// changes the behaviour or signature of any existing export.
//
// ── Why a NEW org-seed instead of reusing seedScenario ───────────────────────
// seedScenario hardcodes companies.issue_prefix = 'E6F' — a globally UNIQUE column
// (companies_issue_prefix_idx). E6F-04 seeds TWO independent orgs AND runs on the
// same live stack as E6F-03 (which already took 'E6F'), so it cannot call
// seedScenario even once without a unique-violation. seedTenancyOrg is a
// byte-faithful copy of the seedScenario org/target/code/job/attempt SQL with two
// additions the matrix requires:
//   1. a per-run UNIQUE `issuePrefix` (the caller mints e.g. 'E64…' per org), and
//   2. zero-or-more EXTRA valid enrollment codes for the SAME org-scoped target
//      (route -> this org + code -> this target). These are the A2 enroll-attack
//      codes: a genuinely VALID Org-A code presented with a foreign/nonexistent
//      hello.targetId. Because the code pins stored.executionTargetId = this
//      target, worker-enrollment.ts findTargetByAuthority looks up THIS target
//      under THIS org and then rejects on `request.hello.targetId !== target.id`
//      with plain "unauthorized" — identical for a foreign vs a missing targetId
//      (E4-D11: no target_revoked-vs-not_found distinction).
// The provider/registered-profile/target/job/attempt SQL is identical to
// seedScenario, so the two load-bearing digests (registered_profile_hash =
// sha256(canonicalizeJsonV1(profile)); placement_provider_constraint_hash = the
// provider profile's own verified digest) are re-derived with the SAME
// worker-protocol primitives the poll re-derives — zero canonicalizer drift.
//
// Seeds under the OWNER/superuser DATABASE_URL (bypasses RLS for WRITES) exactly
// like seedScenario; the SERVER then READS these rows under aoa_app with the
// per-tenant GUC via the deployed RLS policies — that read path is precisely what
// E6F-04 proves. The seed deliberately does NOT set the GUC.
//
// Returns { ok, registeredProfileHash, providerDigest, authorityKey }.
export function seedTenancyOrg({
  ids,
  code,
  issuePrefix,
  extraCodes = [],
  policyHash = POLICY_HASH,
  capabilityCeiling = WORKER_CAPABILITIES,
}) {
  const params = {
    orgId: ids.orgId,
    companyId: ids.companyId,
    targetId: ids.targetId,
    jobId: ids.jobId,
    attemptId: ids.attemptId,
    operationId: ids.operationId,
    slug: ids.slug,
    issuePrefix,
    locatorHash: code.locatorHash,
    secretHash: code.secretHash,
    // Only the two hashes cross the boundary; the raw code halves never leave the host.
    extraCodes: extraCodes.map((extra) => ({ locatorHash: extra.locatorHash, secretHash: extra.secretHash })),
    policyHash,
    capabilityCeiling,
  };
  const script = `
import postgres from "postgres";
import { createHash } from "node:crypto";
import { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1 } from "@armyofagents/worker-protocol";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  // Provider-constraint profile — digest is its OWN verified digest (identical to
  // seedScenario; the server recomputes the same way at normalization).
  const providerUnsigned = {
    profileId: "e6f-org-dedicated",
    version: 1,
    maxContinuousRuntimeSeconds: 3600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 8192 },
    maxConcurrentOperations: 8,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  };
  const providerDigest = sha256(Buffer.from(canonicalProviderConstraintProfileDigestInputV1(providerUnsigned)));
  const provider = { ...providerUnsigned, digest: providerDigest };
  const authorityKey = "organization:" + P.orgId;
  const registeredProfile = {
    protocolVersion: 1,
    targetId: P.targetId,
    targetClass: "organization_dedicated",
    scope: "organization",
    organizationId: P.orgId,
    ownerPrincipalId: null,
    trustCeiling: "organization_isolated",
    credentialCeiling: "organization_brokered",
    dataLocalityCeiling: "organization_target_only",
    providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
    capabilityCeiling: P.capabilityCeiling,
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: P.policyHash,
  };
  const registeredProfileHash = sha256(canonicalizeJsonV1(registeredProfile));

  await sql\`INSERT INTO organizations (id, name, slug)
    VALUES (\${P.orgId}, \${"E6F-04 Org " + P.slug}, \${"e64-" + P.slug})\`;
  await sql\`INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (\${P.companyId}, \${P.orgId}, \${"E6F-04 Company " + P.slug}, \${P.issuePrefix})\`;
  const targetCapabilities = { providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest } };
  await sql\`INSERT INTO execution_targets
    (id, organization_id, scope, target_authority_key, device_generation, slug, kind, trust_class,
     status, capabilities, registered_profile, registered_profile_hash, provider_constraint_profile, last_seen_at)
    VALUES (\${P.targetId}, \${P.orgId}, 'organization', \${authorityKey}, 1, \${"e64-target-" + P.slug},
      'dedicated_worker', 'dedicated_tenant', 'active', \${sql.json(targetCapabilities)}, \${sql.json(registeredProfile)},
      \${registeredProfileHash}, \${sql.json(provider)}, now())\`;
  // Primary enrollment code: route (locator -> this org) + single-use code (secret hash).
  await sql\`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
    VALUES (\${P.locatorHash}, \${P.orgId}, now() + interval '30 minutes')\`;
  await sql\`INSERT INTO worker_enrollment_codes
    (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
     expires_at, created_by_principal_kind, created_by_principal_id)
    VALUES (\${P.orgId}, 'organization', \${P.targetId}, \${authorityKey}, \${P.locatorHash}, \${P.secretHash},
      now() + interval '30 minutes', 'user', 'e6f-seed')\`;
  // Extra VALID codes for the SAME org-scoped target (the A2 enroll-attack codes).
  // Each is a real, routable Org-scoped code — the ONLY thing "wrong" at attack time
  // is the worker-supplied hello.targetId, so the denial exercises the tenant-scoped
  // findTargetByAuthority path (not a "route not found" short-circuit).
  for (const extra of P.extraCodes) {
    await sql\`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
      VALUES (\${extra.locatorHash}, \${P.orgId}, now() + interval '30 minutes')\`;
    await sql\`INSERT INTO worker_enrollment_codes
      (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
       expires_at, created_by_principal_kind, created_by_principal_id)
      VALUES (\${P.orgId}, 'organization', \${P.targetId}, \${authorityKey}, \${extra.locatorHash}, \${extra.secretHash},
        now() + interval '30 minutes', 'user', 'e6f-seed')\`;
  }
  // Queued batch job + immutable lease-eligible placement (identical to seedScenario).
  const sourceIntent = { kind: "one_shot", operationId: P.operationId, operationKind: "readiness_probe" };
  const workload = { command: "true", args: [], stdinArtifactId: null, maxRuntimeSeconds: 600 };
  const requirements = { workloadType: "batch", requiredCapabilities: [] };
  const placementRequest = { policyId: "job-submission-default", policyVersion: 1, requestedTarget: null };
  await sql\`INSERT INTO jobs
    (id, organization_id, company_id, workload_type, source_kind, source_intent, input, input_hash,
     policy_hash, requirements, placement_request, status, available_at)
    VALUES (\${P.jobId}, \${P.orgId}, \${P.companyId}, 'batch', 'one_shot', \${sql.json(sourceIntent)},
      \${sql.json(workload)}, \${"b".repeat(64)}, \${P.policyHash}, \${sql.json(requirements)},
      \${sql.json(placementRequest)}, 'queued', now())\`;
  await sql\`INSERT INTO job_attempts
    (id, organization_id, company_id, job_id, attempt_number, status,
     placement_disposition, placement_owner, placement_target_id, placement_target_class,
     placement_target_scope, placement_target_generation, placement_profile_hash,
     placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
     placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
     placement_decided_at)
    VALUES (\${P.attemptId}, \${P.orgId}, \${P.companyId}, \${P.jobId}, 1, 'pending',
      'selected', 'organization_dedicated', \${P.targetId}, 'organization_dedicated',
      'organization', 1, \${registeredProfileHash}, \${providerDigest}, 'primary', 'target_selected',
      'active', true, \${"c".repeat(64)}, \${"d".repeat(64)}, now())\`;

  report({ ok: true, registeredProfileHash, providerDigest, authorityKey });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAT-002 slice-7 — live-MinIO artifact round-trip additions (ADDITIVE ONLY —
// nothing above is modified). These ADD the two frozen artifact ops
// (artifact_transfer_grant + artifact_commit) as e6f HTTP clients (clones of ack()
// with the new route + inner body + device proof), a control-plane bucket
// self-provisioner, a test-runner raw-bytes PUT/GET pair that talks DIRECTLY to the
// presigned https URL, and a control-plane owner-DB job_artifacts probe. They never
// change the behaviour or signature of any existing export.
//
// ── The checksum header (the #1 live-run risk) ───────────────────────────────
// s3-provider.presign binds `ChecksumAlgorithm:"SHA256"` into the signed PUT but
// returns `headers:{}` — so the presigned PUT URL carries
// `x-amz-sdk-checksum-algorithm=SHA256` in its query and the raw PUT MUST send the
// actual checksum as request headers or MinIO 400s the PUT. `putPresignedBytes`
// computes `x-amz-checksum-sha256 = base64(sha256(body))` INSIDE the step-script
// (from the exact bytes it is about to send) and sends BOTH
// `x-amz-checksum-sha256` and `x-amz-sdk-checksum-algorithm: SHA256`. It also
// returns the hex digest so the caller uses the SAME hash for the grant request +
// the commit manifest (manifest.sha256 is hex; headObject's stored base64 checksum
// is converted back to hex server-side and compared).
// ─────────────────────────────────────────────────────────────────────────────

/** The ordinary attempt object-key prefix (mirrors worker-protocol
 * expectedAttemptObjectPrefix). objectKey = prefix + a safe non-empty suffix. */
export function attemptObjectKey({ organizationId, jobId, attempt, suffix }) {
  return `organizations/${organizationId}/jobs/${jobId}/attempts/${attempt}/${suffix}`;
}

/** Request an artifact transfer grant (operation: "upload" | "download"). Bearer
 * session JWT + a fresh device proof over the exact body bytes; runs in test-runner.
 * Returns { status, body } where body is the artifactTransferGrantOperationResponseV1
 * (outcome upload_granted | download_granted | rejected). */
export function artifactTransferGrant({
  url = WORKER_CONTROL.artifactTransferGrant,
  session,
  operation,
  workerId,
  jobId,
  attempt,
  leaseId,
  fenceToken,
  artifactId,
  expectedObjectKey,
  expectedSha256,
  maxBytes,
  deviceKey,
}) {
  const params = {
    url, session, operation, workerId, jobId, attempt, leaseId, fenceToken, artifactId,
    expectedObjectKey, expectedSha256, maxBytes,
    privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer,
  };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "worker_run",
  idempotencyKey: randomUUID(),
  body: {
    protocolVersion: 1,
    operation: P.operation,
    workerId: P.workerId,
    jobId: P.jobId,
    attempt: P.attempt,
    leaseId: P.leaseId,
    fenceToken: P.fenceToken,
    artifactId: P.artifactId,
    expectedObjectKey: P.expectedObjectKey,
    expectedSha256: P.expectedSha256,
    maxBytes: P.maxBytes,
  },
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["authorization"] = "Bearer " + P.session;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Commit a verified artifact manifest. Bearer session JWT + a fresh device proof;
 * runs in test-runner. `manifest` is the FULL frozen artifactManifestV1 object.
 * Returns { status, body } (artifactCommitOperationResponseV1: committed | rejected). */
export function artifactCommit({
  url = WORKER_CONTROL.artifactCommit,
  session,
  workerId,
  jobId,
  attempt,
  leaseId,
  fenceToken,
  manifest,
  deviceKey,
}) {
  const params = {
    url, session, workerId, jobId, attempt, leaseId, fenceToken, manifest,
    privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer,
  };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "worker_run",
  idempotencyKey: randomUUID(),
  body: {
    protocolVersion: 1,
    workerId: P.workerId,
    jobId: P.jobId,
    attempt: P.attempt,
    leaseId: P.leaseId,
    fenceToken: P.fenceToken,
    manifest: P.manifest,
  },
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["authorization"] = "Bearer " + P.session;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Self-provision the artifact bucket using the control-plane's OWN S3 client (the
 * same @aws-sdk/client-s3 the server uses, resolving the internal https endpoint +
 * the AWS_* env creds + NODE_EXTRA_CA_CERTS). Idempotent (an already-owned bucket is
 * a success). Runs in control-plane. Returns { ok, created }. */
export function provisionArtifactBucket({ bucket = "aoa-artifacts" } = {}) {
  const params = { bucket };
  const script = `
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const client = new S3Client({
  region: process.env.AOA_STORAGE_S3_REGION || "us-east-1",
  endpoint: process.env.AOA_STORAGE_S3_ENDPOINT,
  forcePathStyle: true,
});
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: P.bucket }));
    report({ ok: true, created: false });
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: P.bucket }));
      report({ ok: true, created: true });
    } catch (error) {
      const name = error && error.name ? error.name : String(error);
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
        report({ ok: true, created: false });
      } else {
        report({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    }
  }
} finally {
  client.destroy();
}
`;
  return dexecModule("control-plane", script);
}

/** Direct raw-bytes PUT to a presigned upload URL (the direct-to-store bypass — the
 * bytes NEVER traverse the control-plane API). Computes the SHA256 checksum INSIDE the
 * step-script from the exact bytes it sends and sets both the
 * `x-amz-checksum-sha256` (base64) and `x-amz-sdk-checksum-algorithm: SHA256` headers
 * the signed PUT's query demands. `bodyBase64` is the exact object body (base64 so the
 * bytes survive JSON embedding). Runs in test-runner. Returns
 * { status, sha256Hex, sha256B64, sizeBytes, body }. */
export function putPresignedBytes({ url, bodyBase64 }) {
  const params = { url, bodyBase64 };
  const script = `
import { createHash } from "node:crypto";
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const bodyBytes = Buffer.from(P.bodyBase64, "base64");
const sha256Hex = createHash("sha256").update(bodyBytes).digest("hex");
const sha256B64 = createHash("sha256").update(bodyBytes).digest("base64");
const headers = {
  "x-amz-checksum-sha256": sha256B64,
  "x-amz-sdk-checksum-algorithm": "SHA256",
};
const res = await fetch(P.url, { method: "PUT", headers, body: bodyBytes });
const text = await res.text();
report({ status: res.status, sha256Hex, sha256B64, sizeBytes: bodyBytes.length, body: text.slice(0, 2000) });
`;
  return dexecModule("test-runner", script);
}

/** Direct GET from a presigned download URL. Runs in test-runner. Returns
 * { status, bodyBase64, sizeBytes } (the received bytes, base64-encoded, so the caller
 * can assert byte-identity against what was PUT). */
export function getPresignedBytes({ url }) {
  const params = { url };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const res = await fetch(P.url, { method: "GET" });
const buf = Buffer.from(await res.arrayBuffer());
report({ status: res.status, bodyBase64: buf.toString("base64"), sizeBytes: buf.length });
`;
  return dexecModule("test-runner", script);
}

/** Read the committed job_artifacts row back under the OWNER DB (control-plane), to
 * assert the commit PERSISTED a row (assertion 1). Returns { rows: [...] }. */
export function queryJobArtifact({ organizationId, jobId, identifier }) {
  const params = { organizationId, jobId, identifier };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await sql\`SELECT id, identifier, object_key, size_bytes, sha256, version_number, status, attempt
    FROM job_artifacts
    WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId} AND identifier = \${P.identifier}\`;
  console.log("${RESULT_MARKER}" + JSON.stringify({ rows: rows.map((r) => ({ ...r })) }));
} catch (error) {
  console.log("${RESULT_MARKER}" + JSON.stringify({ rows: [], error: String(error && error.message ? error.message : error) }));
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAT-009/DAT-011 — orphan-sweep additions (ADDITIVE ONLY).
//
// These let a test prove the ORPHAN path end to end against the live stack: mint a
// grant, PUT the bytes, lose the fence, watch the commit refuse `stale_fence`, age the
// grant intent past its expiry, and assert the sweep actually DELETED the object from
// MinIO. Until now the sweep was unit-proven and its wiring only grep-verified.
// ─────────────────────────────────────────────────────────────────────────────

/** Age a `status='granted'` intent row so its grant is past expiry.
 *
 * The production TTL ceiling is 300s and a test cannot wait five minutes. Ageing the
 * ROW is the honest substitute: it moves the same value the sweep reads, rather than
 * weakening the eligibility rule (which is strictly-after-`expiresAt`, deliberately). */
export function ageArtifactGrantIntent({ organizationId, jobId, identifier, secondsAgo = 60 }) {
  const params = { organizationId, jobId, identifier, secondsAgo };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await sql\`UPDATE job_artifacts
    SET expires_at = clock_timestamp() - (\${P.secondsAgo} * interval '1 second')
    WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}
      AND identifier = \${P.identifier} AND status = 'granted'
    RETURNING id, expires_at, status\`;
  console.log("${RESULT_MARKER}" + JSON.stringify({ rows: rows.map((r) => ({ ...r })) }));
} catch (error) {
  console.log("${RESULT_MARKER}" + JSON.stringify({ rows: [], error: String(error && error.message ? error.message : error) }));
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** Does `objectKey` still exist in the artifact bucket? Runs in control-plane, which
 * holds the S3 endpoint + credentials. `exists:false` on a 404/NotFound is the ANSWER,
 * not an error — that is precisely what a swept orphan looks like. */
export function artifactObjectExists({ objectKey }) {
  const params = { objectKey };
  const script = `
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
${embedParams(params)}
function report(v) { console.log("${RESULT_MARKER}" + JSON.stringify(v)); }
const client = new S3Client({
  endpoint: process.env.AOA_STORAGE_S3_ENDPOINT,
  region: process.env.AOA_STORAGE_S3_REGION || "us-east-1",
  forcePathStyle: true,
});
try {
  const out = await client.send(new HeadObjectCommand({
    Bucket: process.env.AOA_STORAGE_S3_BUCKET,
    Key: P.objectKey,
  }));
  report({ exists: true, contentLength: out.ContentLength ?? null });
} catch (error) {
  const name = String(error && error.name ? error.name : "");
  const status = error?.$metadata?.httpStatusCode ?? null;
  if (name === "NotFound" || status === 404) { report({ exists: false, status }); }
  else { report({ exists: null, error: String(error && error.message ? error.message : error), name, status }); }
}
`;
  return dexecModule("control-plane", script);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAT-002 slice-7 — Increment 2: toxiproxy incomplete-upload additions (ADDITIVE
// ONLY — nothing above is modified). These ADD a RUNTIME toxiproxy-admin client
// (set/remove a toxic on the in-path `worker-to-minio` proxy) and a fault-tolerant
// raw-bytes PUT so the caller can prove that a TRUNCATED upload never commits. No
// compose / toxiproxy.json / server change: the toxic is injected + removed at
// RUNTIME via the toxiproxy admin API from a test-runner step-script.
//
// ── Why `limit_data`, `upstream`, and a small byte cap ───────────────────────
// The presigned PUT body flows worker(client) -> minio(upstream server), so the
// data being written to the store travels on the proxy's `upstream` stream. The
// `limit_data` toxic closes the connection once `attributes.bytes` have crossed
// that stream, so a cap well below the object size truncates the write. toxiproxy
// is L4 and forwards OPAQUE TLS bytes, so the cap counts TLS-record bytes, not
// plaintext body bytes — a very small cap (e.g. 64) severs the connection during
// the TLS handshake, so the PUT typically fails at the network layer and NO object
// is stored; a cap that lands after the handshake would instead leave a short
// object. BOTH outcomes make the subsequent fenced commit fail closed (a missing
// or short object → `malformed`; an unverifiable/short-hash object →
// `event_hash_mismatch`), which is exactly the invariant under test. The admin
// port is toxiproxy's default 8474 (the compose command sets no `-port`); the
// test-runner reaches it as a control-net peer.
//
// ── The toxic MUST be removed (the campaign is serial) ───────────────────────
// The d1 campaign runs `--test-concurrency=1`, so a LEAKED toxic on
// `worker-to-minio` would truncate every later test's presigned PUT/GET and break
// the shared stack. Callers therefore ALWAYS remove the toxic in a `finally`.
// `removeToxiproxyToxic` treats a 404 as success (idempotent removal — an
// already-absent toxic is a satisfied post-condition).
// ─────────────────────────────────────────────────────────────────────────────

const TOXIPROXY_ADMIN_URL = "http://toxiproxy:8474";

/** Inject a runtime toxic on a toxiproxy proxy via the admin API (POST
 * /proxies/<proxy>/toxics). `toxic` is the full admin-API body, e.g.
 * `{ name, type: "limit_data", stream: "upstream", attributes: { bytes: 64 } }`.
 * Runs in test-runner (a control-net peer that can reach toxiproxy:8474). Returns
 * { ok, status, body } — `ok` is true only for a 2xx create. */
export function setToxiproxyToxic({ proxy, toxic, adminUrl = TOXIPROXY_ADMIN_URL }) {
  const params = { url: `${adminUrl}/proxies/${proxy}/toxics`, toxic };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
function safeJson(text) { try { return JSON.parse(text); } catch { return text; } }
try {
  const res = await fetch(P.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(P.toxic),
  });
  const text = await res.text();
  report({ ok: res.ok, status: res.status, body: safeJson(text) });
} catch (error) {
  report({ ok: false, status: 0, body: String(error && error.message ? error.message : error) });
}
`;
  return dexecModule("test-runner", script);
}

/** Remove a runtime toxic (DELETE /proxies/<proxy>/toxics/<name>). Idempotent: a
 * 204 (removed) OR a 404 (already absent) both satisfy the "no leaked toxic"
 * post-condition. Runs in test-runner. Returns { ok, status }. */
export function removeToxiproxyToxic({ proxy, name, adminUrl = TOXIPROXY_ADMIN_URL }) {
  const params = { url: `${adminUrl}/proxies/${proxy}/toxics/${name}` };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
try {
  const res = await fetch(P.url, { method: "DELETE" });
  await res.text();
  report({ ok: res.status === 204 || res.status === 404, status: res.status });
} catch (error) {
  report({ ok: false, status: 0, error: String(error && error.message ? error.message : error) });
}
`;
  return dexecModule("test-runner", script);
}

/** Fault-tolerant raw-bytes PUT to a presigned upload URL. Identical wire shape to
 * `putPresignedBytes` (computes + sends the x-amz-checksum-sha256 / -sdk-checksum-
 * algorithm headers the signed PUT's query demands), but CATCHES a network-level
 * failure instead of crashing the step-script — a truncating toxic frequently
 * severs the TLS connection so `fetch` itself rejects. Runs in test-runner. Returns
 * { threw, error?, status?, sha256Hex, sha256B64, sizeBytes, body? } — the caller
 * accepts EITHER a thrown PUT or a non-2xx PUT, since both leave the store without a
 * committable object. */
export function putPresignedBytesAllowError({ url, bodyBase64 }) {
  const params = { url, bodyBase64 };
  const script = `
import { createHash } from "node:crypto";
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const bodyBytes = Buffer.from(P.bodyBase64, "base64");
const sha256Hex = createHash("sha256").update(bodyBytes).digest("hex");
const sha256B64 = createHash("sha256").update(bodyBytes).digest("base64");
const headers = {
  "x-amz-checksum-sha256": sha256B64,
  "x-amz-sdk-checksum-algorithm": "SHA256",
};
try {
  const res = await fetch(P.url, { method: "PUT", headers, body: bodyBytes });
  const text = await res.text();
  report({ threw: false, status: res.status, sha256Hex, sha256B64, sizeBytes: bodyBytes.length, body: text.slice(0, 2000) });
} catch (error) {
  report({ threw: true, error: String(error && error.message ? error.message : error), sha256Hex, sha256B64, sizeBytes: bodyBytes.length });
}
`;
  return dexecModule("test-runner", script);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEP-005 — network-failure + clock-control additions (ADDITIVE ONLY — nothing
// above is modified). These ADD the four primitives the three lease-fault demos
// (e6f-09) need on top of the frozen E6F substrate: a SQL clock helper that back-
// dates the durable lease deadline columns, a client for the DORMANT flag-gated
// reaper trigger, a Toxiproxy proxy-toggle (a clean bidirectional link sever the
// latency/limit toxics cannot do), a stable-idempotencyKey terminal-event upload
// client (+ its worker-protocol digest builder), and a one-shot owner-DB probe of
// the whole convergence picture for a job. They never change the behaviour or
// signature of any existing export.
//
// ── Clock control: back-date the durable lease deadline row (D1) ──────────────
// The control plane's ONLY time source is the Postgres clock_timestamp() re-read
// per locked mutation; there is no injectable clock / shortenable-deadline config
// in the running stack. (STALE PREMISE, CORRECTED: this note used to continue "and the
// reaper has no live trigger — so a back-dated lease never converges on its own".
// MIG-002 `c341cf680` started a LIVE background lease reaper on every control-plane
// replica, so a back-dated lease CAN now converge on its own, on a cadence that drops to
// 1 second after any productive tick. Back-dating is still the deterministic lever for
// CROSSING the deadline; what it no longer buys is exclusivity over who reaps.)
// The sole deterministic, sleep-free lever is to rewrite
// the row (the proven idiom from job-reconciliation.integration.test.ts). Column
// subtlety (load-bearing): back-date ack_deadline for the pre-ACK/offered case (leave
// expires_at future), expires_at for the expired/active case, and ALWAYS keep
// ack_deadline < expires_at (leases_authority_atomic_check). The back-date is ALWAYS
// clock_timestamp()-relative (server clock), NEVER a host Date.
//
// ── Reaper trigger + partition (D2/D4) ───────────────────────────────────────
// reapOrganization() drives the dormant POST /api/worker-control/_test/reap (gated on
// AOA_DISTRIBUTED_EXECUTION_ENABLED, which is true on the D1 control plane). It is
// device/board-auth-free and reaches control-plane:3100 DIRECTLY (not through
// toxiproxy:13100), so cutting worker-to-control-plane never blocks the reap the demo
// fires. setProxyEnabled() severs/restores a whole link via the Toxiproxy 2.x proxy-
// update endpoint (POST /proxies/<name> {enabled}); for degraded/latency cuts use the
// existing setToxiproxyToxic (timeout/reset_peer) instead.
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS_URL = `${CONTROL_PLANE_URL}/api/worker-control/events`;
const REAP_URL = `${CONTROL_PLANE_URL}/api/worker-control/_test/reap`;

/** Back-date the durable lease deadline column(s) so the reaper treats the worker as
 * gone. Runs in control-plane under the OWNER DSN (seeding channel). Back-dates ONLY
 * the column(s) whose interval is supplied — `ackDeadlineIntervalSec` (the pre-ACK /
 * offered case) and/or `expiresAtIntervalSec` (the expired / active case) — ALWAYS via
 * clock_timestamp() (server-relative), NEVER a host Date. The caller MUST keep
 * ack_deadline < expires_at: for the expired/active case pass BOTH with
 * ackDeadlineIntervalSec > expiresAtIntervalSec (e.g. 2 and 1, as the proven idiom
 * does). Returns { updated } — the row count touched. */
export function expireLeaseDeadlines({ leaseId, ackDeadlineIntervalSec, expiresAtIntervalSec }) {
  const setAck = ackDeadlineIntervalSec !== undefined && ackDeadlineIntervalSec !== null;
  const setExpires = expiresAtIntervalSec !== undefined && expiresAtIntervalSec !== null;
  if (!setAck && !setExpires) {
    throw new Error("expireLeaseDeadlines: supply ackDeadlineIntervalSec and/or expiresAtIntervalSec");
  }
  // Coerce to positive integers before embedding as an interval literal (no untrusted
  // value ever reaches SQL as text — the leaseId binds as a parameter, the interval is
  // a validated integer).
  const ackSec = setAck ? Math.max(1, Math.floor(Number(ackDeadlineIntervalSec))) : null;
  const expiresSec = setExpires ? Math.max(1, Math.floor(Number(expiresAtIntervalSec))) : null;
  const params = { leaseId, ackSec, expiresSec };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  // postgres.js cannot compose interval literals via fragments cleanly, so build the
  // whole UPDATE with make_interval(secs => $n) — a parameterized, injection-safe
  // interval. Back-date ONLY the requested column(s); always stamp updated_at.
  let row;
  if (P.ackSec !== null && P.expiresSec !== null) {
    row = await sql\`UPDATE leases SET
      ack_deadline = clock_timestamp() - make_interval(secs => \${P.ackSec}),
      expires_at = clock_timestamp() - make_interval(secs => \${P.expiresSec}),
      updated_at = clock_timestamp() WHERE id = \${P.leaseId} RETURNING id\`;
  } else if (P.ackSec !== null) {
    row = await sql\`UPDATE leases SET
      ack_deadline = clock_timestamp() - make_interval(secs => \${P.ackSec}),
      updated_at = clock_timestamp() WHERE id = \${P.leaseId} RETURNING id\`;
  } else {
    row = await sql\`UPDATE leases SET
      expires_at = clock_timestamp() - make_interval(secs => \${P.expiresSec}),
      updated_at = clock_timestamp() WHERE id = \${P.leaseId} RETURNING id\`;
  }
  report({ ok: true, updated: row.length });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** Clear a retried job's backoff so its next attempt is immediately offerable. allocateRetry
 * stamps jobs.available_at = now + an exponential backoff, and the poll/offer predicate selects
 * only jobs with available_at <= now (job-control.ts), so an immediate poll after a reap
 * correctly returns no_work. Back-date jobs.available_at (deterministic clock control, the same
 * approach as expireLeaseDeadlines) so a retry converges under a poll without a sleep. Runs in
 * control-plane. Returns { ok, updated }. */
export function advanceJobAvailableAt({ jobId, secondsAgo = 1 }) {
  // secondsAgo coerces to a positive integer before embedding as an interval literal (the jobId
  // binds as a parameter; the interval is a validated integer — injection-safe).
  const params = { jobId, secs: Math.max(1, Math.floor(Number(secondsAgo))) };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const row = await sql\`UPDATE jobs SET
    available_at = clock_timestamp() - make_interval(secs => \${P.secs}),
    updated_at = clock_timestamp() WHERE id = \${P.jobId} RETURNING id\`;
  report({ ok: true, updated: row.length });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** Fire ONE synchronous reap for an org via the dormant flag-gated trigger. Runs in
 * test-runner (a control-net peer reaching control-plane:3100 DIRECTLY — not through
 * toxiproxy:13100 — so a worker-to-control-plane cut never blocks it). Returns
 * { status, body } where body is the ReapExpiredLeasesResult (200) or a 404 if the
 * distributed-execution flag is off (dormant). */
export function reapOrganization({ organizationId, limit }) {
  const params = { url: REAP_URL, body: limit !== undefined ? { organizationId, limit } : { organizationId } };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
function safeJson(text) { try { return JSON.parse(text); } catch { return text; } }
const res = await fetch(P.url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(P.body),
});
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** Enable/disable a whole Toxiproxy proxy (clean bidirectional link sever/restore) via
 * the 2.x proxy-update endpoint (POST /proxies/<name> {enabled}). Confirmed against the
 * pinned image ghcr.io/shopify/toxiproxy:2.9.0. Runs in test-runner. Returns
 * { ok, status, body }. Callers ALWAYS restore (enabled:true) in a finally — the
 * campaign is serial (--test-concurrency=1) so a leaked disable would break the stack. */
export function setProxyEnabled({ proxy, enabled, adminUrl = TOXIPROXY_ADMIN_URL }) {
  const params = { url: `${adminUrl}/proxies/${proxy}`, enabled: Boolean(enabled) };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
function safeJson(text) { try { return JSON.parse(text); } catch { return text; } }
try {
  const res = await fetch(P.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: P.enabled }),
  });
  const text = await res.text();
  report({ ok: res.ok, status: res.status, body: safeJson(text) });
} catch (error) {
  report({ ok: false, status: 0, body: String(error && error.message ? error.message : error) });
}
`;
  return dexecModule("test-runner", script);
}

/** The in-compose LISTEN address of each Toxiproxy-fronted link (host:port reachable
 * from test-runner). Lets a test OBSERVE a link cut, not merely toggle it. */
export const TOXIPROXY_LISTEN = {
  "worker-to-control-plane": "toxiproxy:13100",
  // DEP-009 — the per-replica worker→control-plane-b link, so a replica-loss cut is
  // OBSERVABLE via a poll THROUGH this listen port (not merely toggled).
  "worker-to-control-plane-b": "toxiproxy:13101",
  "worker-to-minio": "toxiproxy:19000",
  "control-plane-to-postgres": "toxiproxy:15432",
};

/** Probe whether a Toxiproxy-fronted link is reachable FROM test-runner by issuing a
 * short HTTP GET through the proxy's LISTEN port (NOT the direct upstream). When the
 * proxy is disabled the TCP connect is refused → { reachable:false }; when enabled the
 * upstream answers with any HTTP status → { reachable:true, status }. This makes a link
 * cut genuinely OBSERVABLE (invariant 1) rather than a decorative toggle. HTTP upstreams
 * only (worker-to-control-plane). Runs in test-runner. */
export function probeProxyReachable({ proxy, path = "/health", timeoutMs = 3000 }) {
  const hostPort = TOXIPROXY_LISTEN[proxy];
  if (!hostPort) throw new Error(`probeProxyReachable: unknown proxy "${proxy}"`);
  const params = { url: `http://${hostPort}${path}`, timeoutMs };
  const script = `
${embedParams(params)}
function report(value) { console.log("${RESULT_MARKER}" + JSON.stringify(value)); }
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), P.timeoutMs);
try {
  const res = await fetch(P.url, { method: "GET", signal: ctl.signal });
  report({ reachable: true, status: res.status });
} catch (error) {
  report({ reachable: false, error: String(error && error.message ? error.message : error) });
} finally {
  clearTimeout(timer);
}
`;
  return dexecModule("test-runner", script);
}

/** Fill each event's `eventDigest` = sha256hex(canonicalEventDigestInputV1(event))
 * using the FROZEN worker-protocol canonicalizer (available in control-plane, NOT in
 * test-runner — so the digest is never hand-rolled). `events` is an array of complete
 * wire events WITHOUT eventDigest (the digest input strips eventDigest anyway). Runs in
 * control-plane. Returns { ok, events: [...with eventDigest] }. */
export function computeEventDigests({ events }) {
  const params = { events };
  const script = `
import { createHash } from "node:crypto";
import { canonicalEventDigestInputV1 } from "@armyofagents/worker-protocol";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
try {
  const withDigest = P.events.map((event) => ({
    ...event,
    eventDigest: createHash("sha256").update(canonicalEventDigestInputV1(event)).digest("hex"),
  }));
  report({ ok: true, events: withDigest });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
}
`;
  return dexecModule("control-plane", script);
}

/** Upload a terminal/attempt event batch over the real fenced /worker-control/events
 * path (Bearer session JWT + a fresh device proof), matching the frozen
 * eventUploadOperationRequestV1 envelope. `batch` is the FULL workerEventBatchV1
 * (delivery identity + events each carrying eventDigest, from computeEventDigests).
 * `idempotencyKey` is optional but STABLE across calls for the lost-ACK replay demo
 * (pass the same key twice → the idempotency-replay path). Runs in test-runner.
 * Returns { status, body } (eventUploadOperationResponseV1 with the cumulative ack). */
export function uploadEvents({ url = EVENTS_URL, session, batch, idempotencyKey = null, deviceKey }) {
  const params = { url, session, batch, idempotencyKey, privateKeyPem: deviceKey.privateKeyPem, publicKeyDer: deviceKey.publicKeyDer };
  const script = `
${DEVICE_PROOF_SNIPPET}
${embedParams(params)}
const body = {
  protocolVersion: 1,
  correlationId: randomUUID(),
  issuedAt: new Date().toISOString(),
  nonce: randomBytes(16).toString("base64url"),
  audience: "worker_run",
  idempotencyKey: P.idempotencyKey !== null ? P.idempotencyKey : randomUUID(),
  body: P.batch,
};
const bodyString = JSON.stringify(body);
const headers = deviceProofHeaders({
  method: "POST", url: P.url, bodyString, correlationId: body.correlationId,
  privateKeyPem: P.privateKeyPem, publicKeyDer: P.publicKeyDer,
});
headers["content-type"] = "application/json";
headers["authorization"] = "Bearer " + P.session;
const res = await fetch(P.url, { method: "POST", headers, body: bodyString });
const text = await res.text();
report({ status: res.status, body: safeJson(text) });
`;
  return dexecModule("test-runner", script);
}

/** One-shot owner-DB probe of the WHOLE convergence picture for a job: its lease rows,
 * attempt rows, job status/dead-letter reason, and the job_events + projection-receipt
 * counts. Runs in control-plane under the owner DSN (bypasses RLS like the seed). One
 * probe drives all three e6f-09 demos' assertions. Returns
 * { ok, job, attempts, leases, events, projections }. */
export function queryLeaseFaultState({ organizationId, jobId }) {
  const params = { organizationId, jobId };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const leases = await sql\`SELECT id, status FROM leases
    WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}
    ORDER BY created_at, id\`;
  const attempts = await sql\`SELECT attempt_number AS "attemptNumber", status FROM job_attempts
    WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}
    ORDER BY attempt_number\`;
  const [job] = await sql\`SELECT status, dead_letter_reason AS "deadLetterReason" FROM jobs
    WHERE organization_id = \${P.organizationId} AND id = \${P.jobId}\`;
  const [events] = await sql\`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE event_type = 'terminal')::int AS terminal
    FROM job_events WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}\`;
  const [projections] = await sql\`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE projection_kind = 'attempt_terminal')::int AS terminal
    FROM job_projection_receipts WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}\`;
  report({ ok: true, job: job ?? null, attempts, leases, events, projections });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** DEP-009 — race the SHARED Organization-capacity claim across concurrent contenders to
 * prove the advisory lock serializes count-then-claim so the cap is never exceeded. Uses the
 * EXACT authority admitAttemptCapacity composes into submitJobWithinTenant: one
 * `pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(org))` per tx, count the
 * 'held' attempts, and claim (unclaimed->held) only if under the cap. The claims run
 * concurrently over DISTINCT connections in ONE control-plane exec — the advisory lock is
 * process-agnostic (it serializes at PostgreSQL), so N connections contend exactly as N
 * replicas would. The production wiring (submit → admitAttemptCapacity) is proven separately
 * by job-submit-capacity-admission.integration; this demonstrates the cross-replica
 * serialization live. `attemptIds` must be pre-seeded 'unclaimed' attempts for the org.
 * Sets organizations.concurrency_cap = `cap` first. Returns { ok, admitted, held } — how many
 * claims won and how many attempts ended 'held' (must both equal `cap` when attemptIds > cap). */
export function raceOrgCapacityClaims({ organizationId, attemptIds, cap, workloadType = "batch" }) {
  const params = { organizationId, attemptIds, cap, workloadType };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
// One connection per contender so the claims truly race under the shared advisory lock.
const conns = P.attemptIds.map(() => postgres(process.env.DATABASE_URL, { max: 1 }));
const owner = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await owner\`UPDATE organizations SET concurrency_cap = \${P.cap} WHERE id = \${P.organizationId}\`;
  const claimOne = async (sql, attemptId) => sql.begin(async (tx) => {
    // Same key + shape as org-concurrency.admitAttemptCapacity (count-then-claim).
    await tx\`SELECT pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(\${P.organizationId}))\`;
    const [{ held }] = await tx\`SELECT count(*)::int AS held FROM job_attempts
      WHERE organization_id = \${P.organizationId} AND capacity_claim_state = 'held'\`;
    if (held >= P.cap) return { admitted: false };
    const rows = await tx\`UPDATE job_attempts SET capacity_claim_state = 'held',
        capacity_workload_type = \${P.workloadType}, capacity_claimed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = \${attemptId} AND organization_id = \${P.organizationId}
        AND capacity_claim_state = 'unclaimed' RETURNING id\`;
    return { admitted: rows.length === 1 };
  });
  const outcomes = await Promise.all(P.attemptIds.map((id, i) => claimOne(conns[i], id)));
  const admitted = outcomes.filter((o) => o.admitted).length;
  const [{ held }] = await owner\`SELECT count(*)::int AS held FROM job_attempts
    WHERE organization_id = \${P.organizationId} AND capacity_claim_state = 'held'\`;
  report({ ok: true, admitted, held });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await Promise.all([...conns, owner].map((c) => c.end({ timeout: 5 }).catch(() => {})));
}
`;
  return dexecModule("control-plane", script);
}

/** DEP-009 — owner-DB probe (bypasses RLS, like queryLeaseFaultState) of the SHARED
 * worker-poll admission rate-limit counter for one org. Returns every fixed-window row
 * (there is ONE per window across BOTH replicas), so a test can assert that concurrent A+B
 * polls landed in ONE window row (shared, not process-local). Runs in control-plane.
 * Returns { ok, windows: [{ windowStart, requestCount }], totalRows, totalRequests }. */
export function queryAdmissionRateWindows({ organizationId }) {
  const params = { organizationId };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await sql\`SELECT window_start AS "windowStart", request_count AS "requestCount"
    FROM worker_admission_rate_limits WHERE organization_id = \${P.organizationId}
    ORDER BY window_start\`;
  const totalRequests = rows.reduce((sum, r) => sum + Number(r.requestCount), 0);
  report({ ok: true, windows: rows, totalRows: rows.length, totalRequests });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** DEP-007 — owner-DB probe (bypasses RLS, like queryLeaseFaultState) that reconstructs
 * the DURABLE end-to-end trace for one job: the job's execution SOURCE (jobs.source_kind
 * = the exec-source end of exec-source→job→attempt→lease→sandbox) plus every job_events
 * row ORDERED BY the contiguous `sequence`, each carrying its attempt/lease and — for the
 * attempt_started event — the terminal `sandboxId` parsed from the event jsonb payload
 * (sandboxId is payload-only; there is no column/FK for it, D1/§7.7). Runs in
 * control-plane. Returns { ok, job:{sourceKind,companyId,status}, events:[...] }. */
export function queryJobEventTrace({ organizationId, jobId }) {
  const params = { organizationId, jobId };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const [job] = await sql\`SELECT source_kind AS "sourceKind", company_id AS "companyId", status
    FROM jobs WHERE organization_id = \${P.organizationId} AND id = \${P.jobId}\`;
  const events = await sql\`SELECT
      sequence,
      event_type AS "eventType",
      attempt_id AS "attemptId",
      attempt_number AS "attemptNumber",
      lease_id AS "leaseId",
      company_id AS "companyId",
      organization_id AS "organizationId",
      job_id AS "jobId",
      event->'payload'->>'sandboxId' AS "sandboxId"
    FROM job_events
    WHERE organization_id = \${P.organizationId} AND job_id = \${P.jobId}
    ORDER BY sequence\`;
  report({ ok: true, job: job ?? null, events });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}

/** DEP-007 — a NON-OWNER read of `job_events` under the bounded `aoa_app` serving role
 * (AOA_APP_DATABASE_URL: NOSUPERUSER/NOBYPASSRLS), scoped to `scopeOrganizationId` via
 * the transaction-local `aoa.organization_id` GUC — the SAME isolation filter
 * runInTenant writes (with_tenant_tx). A scope that is NOT the job's owning org returns
 * ZERO rows under FORCE RLS even though the job_id matches (tenant ids never leak to a
 * foreign reader); scoping to the owning org returns the real count (positive control).
 * Runs in control-plane (the only container with the aoa_app DSN). Returns { ok, total }. */
export function queryJobEventsAsApp({ jobId, scopeOrganizationId }) {
  const params = { jobId, scopeOrganizationId };
  const script = `
import postgres from "postgres";
${embedParams(params)}
const report = (value) => console.log("${RESULT_MARKER}" + JSON.stringify(value));
const sql = postgres(process.env.AOA_APP_DATABASE_URL, { max: 1 });
try {
  const rows = await sql.begin(async (tx) => {
    // is_local => true: scoped to THIS transaction, cannot leak across pooled conns.
    await tx\`select set_config('aoa.organization_id', \${P.scopeOrganizationId}, true)\`;
    return tx\`SELECT count(*)::int AS total FROM job_events WHERE job_id = \${P.jobId}\`;
  });
  report({ ok: true, total: rows[0].total });
} catch (error) {
  report({ ok: false, error: String(error && error.message ? error.message : error) });
} finally {
  await sql.end({ timeout: 5 });
}
`;
  return dexecModule("control-plane", script);
}
