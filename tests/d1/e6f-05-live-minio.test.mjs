// -----------------------------------------------------------------------------
// E6F-05 — LIVE MinIO artifact round-trip (Linux/CI ONLY — requires Docker + a
// running docker-compose.d1.yml stack with MinIO-over-TLS). DAT-002 slice-7,
// Increment 1: the DEC-03 Linux-CI authority proof that the FROZEN https
// presigned-PUT/GET round-trip works against a REAL MinIO-over-TLS store. Slices
// 1–6 already prove every fail-closed acceptance in-process; this proves the direct-
// to-store BYPASS (bytes never traverse the API body path) + the fenced commit + the
// download round-trip against real object bytes.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-05-live-minio.test.mjs
//
// Without AOA_D1_LIVE=1 it SKIPS cleanly — it is NEVER faked. Bring-up:
//   cp docker/d1/.env.example docker/d1/.env   # DEP-001 admitted digests
//   docker compose -f docker-compose.d1.yml up -d
//
// ── Shape (reuses the E6F-03 substrate) ──────────────────────────────────────
// The two artifact ops (artifact_transfer_grant + artifact_commit) require a LIVE
// FENCE (upload) — so the test first runs the full
//   seed -> enroll -> liveness -> poll -> ack
// path (identical to E6F-03) to mint the fenced 13-field worker identity, then:
//   Assertion 1: grant(upload) -> raw PUT to the presigned https URL (worker ->
//     toxiproxy:19000 -> minio, bypassing the API) -> commit -> `committed`
//     {artifactId, versionNumber>=1} + a persisted job_artifacts row.
//   Assertion 3: grant(download) -> raw GET -> byte-identical bytes.
//
// ── Increment 2 (this file's SECOND test): toxiproxy incomplete-upload ────────
// A RUNTIME `limit_data` toxic on the in-path `worker-to-minio` proxy (injected via
// the toxiproxy admin API from a test-runner step-script — NO compose/json change)
// truncates the presigned PUT, so the store holds a missing/short object. The
// subsequent fenced `artifactCommit` — carrying the manifest's FULL sha256/size —
// MUST reject fail-closed (`malformed` for a missing/short object, or
// `event_hash_mismatch` for an unverifiable/short hash; the frozen 13-code vocab has
// no `upload_incomplete`) and persist NO `job_artifacts` row. The toxic is ALWAYS
// removed in a `finally` so it never leaks into a later serial-campaign test.
//
// ── The checksum header (the #1 risk; see e6f-harness.mjs) ────────────────────
// The presigned PUT URL carries `x-amz-sdk-checksum-algorithm=SHA256` in its query,
// so the raw PUT MUST send `x-amz-checksum-sha256: base64(sha256(body))` (and
// `x-amz-sdk-checksum-algorithm: SHA256`) or MinIO 400s the PUT and the commit's
// headObject-based integrity check fails closed. `putPresignedBytes` computes that
// checksum from the exact bytes it sends; the manifest carries the SAME digest in
// hex (s3-provider converts the store's base64 checksum back to hex to compare).
//
// ── WHY THE GATE TITLE SAYS "CONTROL-PLANE gate" (W18, 2026-09-08) ──────────
// The suite's own title now names what it tests. This is a TRUTH FIX and nothing
// more: no assertion, threshold or pass condition changed with it. What runs here
// is the CONTROL PLANE under a harness that plays the worker itself —
// tests/d1/lib/e6f-harness.mjs:8-9 states it outright: "There is NO live
// worker-daemon loop: enroll/poll/ack are ordinary authenticated HTTP calls the
// harness makes itself." So a green run is evidence about the control plane's
// fenced routes, and is NOT evidence that any worker daemon, device or machine
// ran anything. Naming the half that has NOT run follows the precedent already in
// this tree: scripts/gate-clause-wiring.json's E5-2-fenced-object-commit-worker-half.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  SKIP,
  newScenarioIds,
  generateDeviceKey,
  newEnrollmentCode,
  buildWorkerHello,
  seedScenario,
  stampWorkerLiveness,
  enroll,
  poll,
  ack,
  attemptObjectKey,
  provisionArtifactBucket,
  artifactTransferGrant,
  putPresignedBytes,
  putPresignedBytesAllowError,
  artifactCommit,
  getPresignedBytes,
  queryJobArtifact,
  setToxiproxyToxic,
  removeToxiproxyToxic,
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[A-Za-z0-9_-]{43,}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BUCKET = "aoa-artifacts";

/** Assert a `docker exec` step produced a parseable __E6F_RESULT__; else surface the
 * raw stdout/stderr so a live CI failure is diagnosable in one pass. */
function stepResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

test("E6F-05 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) live MinIO: grant(upload) -> PUT -> commit -> grant(download) -> GET round-trip", { skip: SKIP }, () => {
  const ids = newScenarioIds();
  const deviceKey = generateDeviceKey();
  const code = newEnrollmentCode();
  const hello = buildWorkerHello({ workerId: ids.workerId, targetId: ids.targetId });

  // 0. Self-provision the artifact bucket via the control-plane's OWN S3 client
  //    (internal https endpoint + AWS_* creds + NODE_EXTRA_CA_CERTS). Idempotent.
  const provisioned = stepResult(provisionArtifactBucket({ bucket: BUCKET }), "provision-bucket");
  assert.equal(provisioned.ok, true, `bucket provisioning failed: ${JSON.stringify(provisioned)}`);

  // 1. Seed org/company/target + enrollment code/route + queued batch job with a
  //    lease-eligible placement (control-plane container, owner DB).
  const seed = stepResult(seedScenario({ ids, code }), "seed");
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`);

  // 2. ENROLL over the real device-proof scheme -> 200 + a worker session JWT.
  const enrolled = stepResult(enroll({ code: code.code, hello, deviceKey }), "enroll");
  assert.equal(enrolled.status, 200, `enroll expected 200, got ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);
  assert.ok(typeof enrolled.session === "string" && enrolled.session.length > 0, "enroll must return an aoa-worker-session header");

  // 3. Worker liveness (enroll leaves last_seen_at NULL; the poll authority gate needs it fresh).
  const liveness = stepResult(stampWorkerLiveness({ workerId: ids.workerId, targetId: ids.targetId }), "liveness");
  assert.equal(liveness.workerUpdated, 1, `expected the enrolled worker row to be stamped: ${JSON.stringify(liveness)}`);

  // 4. POLL -> exactly one lease offer for the placed job (the live fence).
  const polled = stepResult(
    poll({ session: enrolled.session, workerId: ids.workerId, targetId: ids.targetId, deviceKey }),
    "poll",
  );
  assert.equal(polled.status, 200, `poll expected 200, got ${polled.status}: ${JSON.stringify(polled.body)}`);
  assert.equal(polled.body.outcome, "offer", `poll must return an offer, got: ${JSON.stringify(polled.body)}`);
  const offer = polled.body.body;
  assert.match(offer.fenceToken, FENCE, `offer fenceToken shape: ${offer.fenceToken}`);
  assert.match(offer.leaseId, UUID, `offer leaseId shape: ${offer.leaseId}`);
  const attempt = offer.job.attempt;

  // 5. ACK the lease -> the fence is now active (upload grants require a live fence).
  const acked = stepResult(
    ack({
      session: enrolled.session,
      workerId: ids.workerId,
      jobId: ids.jobId,
      attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      deviceKey,
    }),
    "ack",
  );
  assert.equal(acked.status, 200, `ack expected 200, got ${acked.status}: ${JSON.stringify(acked.body)}`);
  assert.equal(acked.body.outcome, "acknowledged", `ack outcome: ${JSON.stringify(acked.body)}`);

  // ── The artifact payload (a fixed, hermetic per-run blob) ───────────────────
  const artifactId = randomUUID();
  const objectKey = attemptObjectKey({
    organizationId: ids.orgId,
    jobId: ids.jobId,
    attempt,
    suffix: `output/artifact-${randomBytes(4).toString("hex")}.bin`,
  });
  const bodyBytes = Buffer.from(`DAT-002 live-minio round-trip payload ${randomUUID()}\n${randomBytes(64).toString("hex")}`, "utf8");
  const bodyBase64 = bodyBytes.toString("base64");
  const sha256Hex = createHash("sha256").update(bodyBytes).digest("hex");
  const sizeBytes = bodyBytes.length;
  assert.match(sha256Hex, HEX64, "computed manifest sha256 must be 64 hex chars");

  const fence = {
    workerId: ids.workerId,
    jobId: ids.jobId,
    attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
  };

  // ── ASSERTION 1: upload grant -> direct PUT (bypass) -> fenced commit ────────

  // 6. UPLOAD grant: a live fence + this-org prefix -> upload_granted with a scoped
  //    presigned https PUT URL (host = toxiproxy:19000, path-style).
  const uploadGrant = stepResult(
    artifactTransferGrant({
      session: enrolled.session,
      operation: "upload",
      ...fence,
      artifactId,
      expectedObjectKey: objectKey,
      expectedSha256: sha256Hex,
      maxBytes: sizeBytes,
      deviceKey,
    }),
    "upload-grant",
  );
  assert.equal(uploadGrant.status, 200, `upload grant expected 200, got ${uploadGrant.status}: ${JSON.stringify(uploadGrant.body)}`);
  assert.equal(uploadGrant.body.outcome, "upload_granted", `upload grant outcome: ${JSON.stringify(uploadGrant.body)}`);
  const putUrl = uploadGrant.body.grant.url;
  assert.ok(putUrl.startsWith("https://"), `presigned PUT url must be https: ${putUrl}`);
  assert.equal(uploadGrant.body.grant.method, "PUT", "upload grant method");
  assert.equal(uploadGrant.body.grant.objectKey, objectKey, "upload grant echoes the scoped object key");

  // 7. Direct raw-bytes PUT to the presigned URL (bytes bypass the control-plane
  //    API). The step-script computes + sends the x-amz-checksum-sha256 header.
  const put = stepResult(putPresignedBytes({ url: putUrl, bodyBase64 }), "put-bytes");
  assert.ok(
    put.status === 200 || put.status === 204,
    `presigned PUT must succeed (200/204); got ${put.status}: ${put.body}`,
  );
  assert.equal(put.sha256Hex, sha256Hex, "the PUT step-script hashed the SAME bytes the manifest declares");

  // 8. COMMIT the manifest: fence-first verified commit -> committed{artifactId, versionNumber>=1}.
  const manifest = {
    protocolVersion: 1,
    organizationId: ids.orgId,
    companyId: ids.companyId,
    jobId: ids.jobId,
    attempt,
    artifactId,
    kind: "other",
    sensitivity: "restricted",
    retention: "run",
    objectKey,
    sizeBytes,
    sha256: sha256Hex,
    contentType: "application/octet-stream",
    createdAt: new Date().toISOString(),
  };
  const committed = stepResult(
    artifactCommit({ session: enrolled.session, ...fence, manifest, deviceKey }),
    "commit",
  );
  assert.equal(committed.status, 200, `commit expected 200, got ${committed.status}: ${JSON.stringify(committed.body)}`);
  assert.equal(committed.body.outcome, "committed", `commit must succeed against the real object: ${JSON.stringify(committed.body)}`);
  assert.equal(committed.body.artifactId, artifactId, "commit echoes the artifact id");
  assert.ok(Number.isInteger(committed.body.versionNumber) && committed.body.versionNumber >= 1, `versionNumber must be a positive int: ${committed.body.versionNumber}`);

  // 9. The commit PERSISTED a job_artifacts row (owner-DB read-back).
  const persisted = stepResult(queryJobArtifact({ organizationId: ids.orgId, jobId: ids.jobId, identifier: artifactId }), "query-row");
  // DAT-009 slice 2 — the mint now also records a `status='granted'` INTENT row, so the
  // natural key legitimately carries TWO rows (granted + committed) on a successful commit:
  // the partial-unique keys are disjoint by design. This assertion always MEANT "exactly one
  // COMMITTED row" (see its own message); it counted all rows only because intents did not
  // exist. Filtering is therefore a correction, not a relaxation — and the intent row is
  // asserted below rather than ignored.
  const committedRows = persisted.rows.filter((r) => r.status === "committed");
  assert.equal(committedRows.length, 1, `expected exactly one committed job_artifacts row: ${JSON.stringify(persisted)}`);
  assert.equal(
    persisted.rows.filter((r) => r.status === "granted").length, 1,
    `the mint must also have recorded exactly one grant intent: ${JSON.stringify(persisted)}`,
  );
  // DAT-009 slice 2 — `rows[0]` is now the GRANTED intent (insertion order), not the
  // committed row. Every assertion below is about the COMMITTED artifact, so it must read
  // the committed row explicitly rather than rely on ordering that no longer holds.
  const row = committedRows[0];
  assert.equal(row.status, "committed", `row status: ${JSON.stringify(row)}`);
  assert.equal(row.object_key, objectKey, "row object_key");
  assert.equal(Number(row.size_bytes), sizeBytes, "row size_bytes");
  assert.equal(row.sha256, sha256Hex, "row sha256 (hex)");
  assert.ok(Number(row.version_number) >= 1, "row version_number");

  // ── ASSERTION 3: download grant -> direct GET -> byte-identical bytes ────────

  // 10. DOWNLOAD grant (tenant-scoped + committed-object existence; survives lease loss).
  const downloadGrant = stepResult(
    artifactTransferGrant({
      session: enrolled.session,
      operation: "download",
      ...fence,
      artifactId,
      expectedObjectKey: objectKey,
      expectedSha256: sha256Hex,
      maxBytes: sizeBytes,
      deviceKey,
    }),
    "download-grant",
  );
  assert.equal(downloadGrant.status, 200, `download grant expected 200, got ${downloadGrant.status}: ${JSON.stringify(downloadGrant.body)}`);
  assert.equal(downloadGrant.body.outcome, "download_granted", `download grant outcome: ${JSON.stringify(downloadGrant.body)}`);
  const getUrl = downloadGrant.body.grant.url;
  assert.ok(getUrl.startsWith("https://"), `presigned GET url must be https: ${getUrl}`);
  assert.equal(downloadGrant.body.grant.method, "GET", "download grant method");

  // 11. Direct raw-bytes GET -> byte-identical to what was PUT.
  const got = stepResult(getPresignedBytes({ url: getUrl }), "get-bytes");
  assert.equal(got.status, 200, `presigned GET expected 200, got ${got.status}`);
  assert.equal(got.sizeBytes, sizeBytes, "downloaded size matches the uploaded size");
  assert.equal(got.bodyBase64, bodyBase64, "downloaded bytes are byte-identical to the uploaded bytes");
});

// ── ASSERTION 2: toxiproxy incomplete-upload -> commit rejects fail-closed ────
// A truncated PUT (a runtime `limit_data` toxic on `worker-to-minio`) leaves the
// store with a missing/short object; the fenced commit carrying the FULL manifest
// hash/size MUST reject (`malformed` | `event_hash_mismatch`) and persist NO row.
// The toxic is injected + torn down at runtime via the toxiproxy ADMIN API — no
// compose / toxiproxy.json / server change — and is ALWAYS removed in a `finally`
// so it can never leak into a later serial-campaign test (--test-concurrency=1).
const PROXY = "worker-to-minio";
const TOXIC_NAME = "e6f05-truncate-upload";

test("E6F-05 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) live MinIO: toxiproxy-truncated upload never commits (fail-closed on hash/size)", { skip: SKIP }, () => {
  const ids = newScenarioIds();
  const deviceKey = generateDeviceKey();
  const code = newEnrollmentCode();
  const hello = buildWorkerHello({ workerId: ids.workerId, targetId: ids.targetId });

  // 0. Bucket (idempotent — the increment-1 test may have already created it).
  const provisioned = stepResult(provisionArtifactBucket({ bucket: BUCKET }), "provision-bucket");
  assert.equal(provisioned.ok, true, `bucket provisioning failed: ${JSON.stringify(provisioned)}`);

  // 1-5. A FRESH fenced worker identity (own org/company/target/job) so this test is
  //      hermetic and order-independent from the round-trip test above.
  const seed = stepResult(seedScenario({ ids, code }), "seed");
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`);

  const enrolled = stepResult(enroll({ code: code.code, hello, deviceKey }), "enroll");
  assert.equal(enrolled.status, 200, `enroll expected 200, got ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);
  assert.ok(typeof enrolled.session === "string" && enrolled.session.length > 0, "enroll must return an aoa-worker-session header");

  const liveness = stepResult(stampWorkerLiveness({ workerId: ids.workerId, targetId: ids.targetId }), "liveness");
  assert.equal(liveness.workerUpdated, 1, `expected the enrolled worker row to be stamped: ${JSON.stringify(liveness)}`);

  const polled = stepResult(
    poll({ session: enrolled.session, workerId: ids.workerId, targetId: ids.targetId, deviceKey }),
    "poll",
  );
  assert.equal(polled.status, 200, `poll expected 200, got ${polled.status}: ${JSON.stringify(polled.body)}`);
  assert.equal(polled.body.outcome, "offer", `poll must return an offer, got: ${JSON.stringify(polled.body)}`);
  const offer = polled.body.body;
  const attempt = offer.job.attempt;

  const acked = stepResult(
    ack({
      session: enrolled.session,
      workerId: ids.workerId,
      jobId: ids.jobId,
      attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      deviceKey,
    }),
    "ack",
  );
  assert.equal(acked.status, 200, `ack expected 200, got ${acked.status}: ${JSON.stringify(acked.body)}`);
  assert.equal(acked.body.outcome, "acknowledged", `ack outcome: ${JSON.stringify(acked.body)}`);

  // ── The payload: a fixed 256-byte body; the toxic caps the upstream at 64 bytes ──
  const artifactId = randomUUID();
  const objectKey = attemptObjectKey({
    organizationId: ids.orgId,
    jobId: ids.jobId,
    attempt,
    suffix: `output/truncated-${randomBytes(4).toString("hex")}.bin`,
  });
  // Exactly 256 bytes (128 hex bytes -> 256 hex chars). The manifest declares this
  // FULL size/sha; the store never receives all of it, so the commit must fail closed.
  const bodyBytes = Buffer.from(randomBytes(128).toString("hex"), "utf8");
  const bodyBase64 = bodyBytes.toString("base64");
  const sha256Hex = createHash("sha256").update(bodyBytes).digest("hex");
  const sizeBytes = bodyBytes.length;
  assert.equal(sizeBytes, 256, "truncation body must be exactly 256 bytes");
  assert.match(sha256Hex, HEX64, "computed manifest sha256 must be 64 hex chars");

  const fence = {
    workerId: ids.workerId,
    jobId: ids.jobId,
    attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
  };

  // 6. UPLOAD grant (valid prefix + tenant, so the ONLY thing wrong is the truncated
  //    bytes — the rejection isolates to hash/size, never wrong_prefix/tenant_mismatch).
  const uploadGrant = stepResult(
    artifactTransferGrant({
      session: enrolled.session,
      operation: "upload",
      ...fence,
      artifactId,
      expectedObjectKey: objectKey,
      expectedSha256: sha256Hex,
      maxBytes: sizeBytes,
      deviceKey,
    }),
    "upload-grant",
  );
  assert.equal(uploadGrant.status, 200, `upload grant expected 200, got ${uploadGrant.status}: ${JSON.stringify(uploadGrant.body)}`);
  assert.equal(uploadGrant.body.outcome, "upload_granted", `upload grant outcome: ${JSON.stringify(uploadGrant.body)}`);
  const putUrl = uploadGrant.body.grant.url;
  assert.ok(putUrl.startsWith("https://"), `presigned PUT url must be https: ${putUrl}`);

  // 7. Inject the truncating toxic, do the (doomed) PUT, and ALWAYS remove the toxic.
  //    limit_data / upstream / bytes:64 severs the worker->minio write well below the
  //    256-byte body (over TLS it typically breaks the handshake, so the PUT fails at
  //    the network layer and no object is stored; either way the store has no
  //    committable object). The finally guarantees the toxic never leaks.
  const toxicSet = stepResult(
    setToxiproxyToxic({
      proxy: PROXY,
      toxic: { name: TOXIC_NAME, type: "limit_data", stream: "upstream", attributes: { bytes: 64 } },
    }),
    "set-toxic",
  );
  assert.equal(toxicSet.ok, true, `toxic injection must succeed: ${JSON.stringify(toxicSet)}`);

  let removeRes;
  try {
    // Fault-tolerant PUT: a truncating toxic frequently makes fetch itself reject.
    // A thrown PUT (put.threw) OR a non-2xx PUT are BOTH acceptable here — the point
    // is only that no complete, committable object reaches the store.
    const put = stepResult(putPresignedBytesAllowError({ url: putUrl, bodyBase64 }), "put-truncated");
    assert.equal(put.sha256Hex, sha256Hex, "the PUT step-script hashed the SAME bytes the manifest declares");
    assert.ok(
      put.threw === true || put.status !== 200,
      `a truncated upload must NOT report a clean 200 PUT: ${JSON.stringify(put)}`,
    );
  } finally {
    // CRITICAL: remove the toxic no matter what — a leaked toxic on the shared
    // worker-to-minio proxy would corrupt every later serial-campaign test's S3 path.
    removeRes = stepResult(removeToxiproxyToxic({ proxy: PROXY, name: TOXIC_NAME }), "remove-toxic");
  }
  assert.equal(removeRes.ok, true, `the toxic MUST be removed (204/404) so it never leaks: ${JSON.stringify(removeRes)}`);

  // 8. COMMIT the FULL manifest against the missing/short stored object. The commit's
  //    headObject uses the control-plane's INTERNAL minio endpoint (not toxiproxy), so
  //    the now-removed toxic never affected it. It must reject fail-closed.
  const manifest = {
    protocolVersion: 1,
    organizationId: ids.orgId,
    companyId: ids.companyId,
    jobId: ids.jobId,
    attempt,
    artifactId,
    kind: "other",
    sensitivity: "restricted",
    retention: "run",
    objectKey,
    sizeBytes,
    sha256: sha256Hex,
    contentType: "application/octet-stream",
    createdAt: new Date().toISOString(),
  };
  const committed = stepResult(
    artifactCommit({ session: enrolled.session, ...fence, manifest, deviceKey }),
    "commit-after-truncation",
  );
  assert.equal(committed.status, 200, `commit expected 200 (a fail-closed rejection is still a 200), got ${committed.status}: ${JSON.stringify(committed.body)}`);
  assert.equal(committed.body.outcome, "rejected", `an incomplete upload must NEVER commit: ${JSON.stringify(committed.body)}`);
  // Accept EITHER reason: a missing/short object -> `malformed` (headObject !exists,
  // or declared-vs-actual size mismatch); an unverifiable/short-hash object ->
  // `event_hash_mismatch`. MinIO's exact behavior on a TLS-truncated presigned PUT is
  // not knowable locally (Linux-CI-only), so both fail-closed reasons are valid.
  assert.ok(
    committed.body.reason === "malformed" || committed.body.reason === "event_hash_mismatch",
    `reject reason must be malformed or event_hash_mismatch (fail-closed on hash/size); got ${JSON.stringify(committed.body)}`,
  );

  // 9. NO job_artifacts row was persisted (every reject path throws BEFORE the insert).
  const persisted = stepResult(queryJobArtifact({ organizationId: ids.orgId, jobId: ids.jobId, identifier: artifactId }), "query-row");
  // DAT-009 slice 2 — same correction as the round-trip test above, and here it is the
  // MORE interesting case: a truncated upload leaves the `granted` intent behind, and that
  // is exactly right. That intent IS the orphan record, and it is what lets the sweep
  // collect bytes a failed commit left in the store. Asserting it turns what would have
  // been a weakening into a strengthening.
  assert.equal(
    persisted.rows.filter((r) => r.status === "committed").length, 0,
    `an incomplete upload must persist NO COMMITTED job_artifacts row: ${JSON.stringify(persisted)}`,
  );
  assert.equal(
    persisted.rows.filter((r) => r.status === "granted").length, 1,
    `the grant intent must remain so the orphan is collectable: ${JSON.stringify(persisted)}`,
  );
});
