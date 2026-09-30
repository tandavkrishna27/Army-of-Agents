// -----------------------------------------------------------------------------
// E6F-14 — LIVE orphan sweep (Linux/CI ONLY — requires Docker + a running
// docker-compose.d1.yml stack with MinIO-over-TLS).
//
// WHAT THIS PROVES, AND WHY IT IS WORTH A LIVE LANE. DAT-009 slice 2 built the
// orphan-sweep decision and runner; DAT-011 wired the trigger. Both were unit-proven
// and their wiring only GREP-verified, and both result docs said so outright:
// "no integration test proves a real orphan is deleted end to end … that belongs
// with the D1 lane". This is that test.
//
// THE ORPHAN, in the shape production creates it:
//   The artifact-transfer fence is checked ONLY AT MINT (artifact-transfer-grant.ts
//   `lockActiveFence`), and the issued grant carries NO fence material — the frozen
//   schema is `.strict()` and has no workerId/leaseId/fenceToken. So the presigned
//   PUT keeps working after the lease dies: S3 knows nothing about fences. The bytes
//   land in the ORDINARY attempt prefix, commit then refuses `stale_fence`, and
//   before DAT-009 nothing ever collected them — `deleteObject` had two call sites
//   in the whole repo, both task attachments, and no lifecycle rule exists.
//
// WHY THE INTENT IS AGED BEFORE THE REFUSAL. The sweep trigger is debounced per
// organization (5 min), and the commit refusal itself consumes the slot. Ageing the
// intent first means the single trigger this test fires has something to collect.
// It is also a REAL production ordering: a slow worker whose 300s grant expired
// before it got around to committing. The eligibility rule is NOT weakened — it is
// still strictly-after-`expiresAt`; only the row's own value is moved.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-14-orphan-sweep.test.mjs
//
// Without AOA_D1_LIVE=1 it SKIPS cleanly — it is NEVER faked.
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
  artifactCommit,
  queryJobArtifact,
  ageArtifactGrantIntent,
  artifactObjectExists,
} from "./lib/e6f-harness.mjs";

const FENCE = /^[A-Za-z0-9_-]{43,}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BUCKET = "aoa-artifacts";

function stepResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

/** The sweep is fire-and-forget, so the commit response can return before it finishes.
 * Poll rather than sleep a fixed amount: a fixed sleep is either flaky or slow, and
 * this reports the LAST observed state on failure so a live CI failure is diagnosable
 * in one pass. */
function waitForObjectGone(objectKey, { attempts = 20, everyMs = 500 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = stepResult(artifactObjectExists({ objectKey }), `object-exists#${i}`);
    if (last.exists === false) return { gone: true, last, polls: i + 1 };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, everyMs);
  }
  return { gone: false, last, polls: attempts };
}

test("E6F-14 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) live orphan sweep: fence lost mid-flight -> commit refuses -> the object is DELETED", { skip: SKIP }, () => {
  const ids = newScenarioIds();
  const deviceKey = generateDeviceKey();
  const code = newEnrollmentCode();
  const hello = buildWorkerHello({ workerId: ids.workerId, targetId: ids.targetId });

  const provisioned = stepResult(provisionArtifactBucket({ bucket: BUCKET }), "provision-bucket");
  assert.equal(provisioned.ok, true, `bucket provisioning failed: ${JSON.stringify(provisioned)}`);

  const seed = stepResult(seedScenario({ ids, code }), "seed");
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`);

  const enrolled = stepResult(enroll({ code: code.code, hello, deviceKey }), "enroll");
  assert.equal(enrolled.status, 200, `enroll expected 200, got ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);

  const liveness = stepResult(stampWorkerLiveness({ workerId: ids.workerId, targetId: ids.targetId }), "liveness");
  assert.equal(liveness.workerUpdated, 1, `expected the enrolled worker row to be stamped: ${JSON.stringify(liveness)}`);

  const polled = stepResult(poll({ session: enrolled.session, workerId: ids.workerId, targetId: ids.targetId, deviceKey }), "poll");
  assert.equal(polled.body.outcome, "offer", `poll must return an offer: ${JSON.stringify(polled.body)}`);
  const offer = polled.body.body;
  assert.match(offer.fenceToken, FENCE, `offer fenceToken shape: ${offer.fenceToken}`);
  const attempt = offer.job.attempt;

  const acked = stepResult(
    ack({ session: enrolled.session, workerId: ids.workerId, jobId: ids.jobId, attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey }),
    "ack",
  );
  assert.equal(acked.body.outcome, "acknowledged", `ack outcome: ${JSON.stringify(acked.body)}`);

  const artifactId = randomUUID();
  const objectKey = attemptObjectKey({
    organizationId: ids.orgId,
    jobId: ids.jobId,
    attempt,
    suffix: `output/orphan-${randomBytes(4).toString("hex")}.bin`,
  });
  const bodyBytes = Buffer.from(`E6F-14 orphan payload ${randomUUID()}\n${randomBytes(64).toString("hex")}`, "utf8");
  const sha256Hex = createHash("sha256").update(bodyBytes).digest("hex");
  assert.match(sha256Hex, HEX64, "computed sha256 must be 64 hex chars");
  const fence = { workerId: ids.workerId, jobId: ids.jobId, attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken };

  // 1. Mint the upload grant under a LIVE fence.
  const uploadGrant = stepResult(
    artifactTransferGrant({
      session: enrolled.session, operation: "upload", ...fence, artifactId,
      expectedObjectKey: objectKey, expectedSha256: sha256Hex, maxBytes: bodyBytes.length, deviceKey,
    }),
    "upload-grant",
  );
  assert.equal(uploadGrant.body.outcome, "upload_granted", `upload grant: ${JSON.stringify(uploadGrant.body)}`);

  // 2. ★ DAT-009 slice 2 — the mint must have recorded a durable GRANT INTENT.
  //    Before that ticket the mint recorded nothing at all, and the storage port has no
  //    list operation, so an orphan was undiscoverable by any means.
  const afterGrant = stepResult(queryJobArtifact({ organizationId: ids.orgId, jobId: ids.jobId, identifier: artifactId }), "intent-row");
  const granted = afterGrant.rows.filter((r) => r.status === "granted");
  assert.equal(granted.length, 1, `mint must record exactly one granted intent: ${JSON.stringify(afterGrant)}`);
  assert.equal(granted[0].object_key, objectKey, "the intent records the object key the sweep will delete");

  // 3. The bytes land — the object now exists in the store.
  const put = stepResult(putPresignedBytes({ url: uploadGrant.body.grant.url, bodyBase64: bodyBytes.toString("base64") }), "put-bytes");
  assert.ok(put.status === 200 || put.status === 204, `presigned PUT must succeed; got ${put.status}: ${put.body}`);
  const present = stepResult(artifactObjectExists({ objectKey }), "object-present");
  assert.equal(present.exists, true, `the uploaded object must exist before the sweep: ${JSON.stringify(present)}`);

  // 4. Age the intent past its expiry (see the header for why this comes first).
  const aged = stepResult(ageArtifactGrantIntent({ organizationId: ids.orgId, jobId: ids.jobId, identifier: artifactId, secondsAgo: 120 }), "age-intent");
  assert.equal(aged.rows.length, 1, `ageing must move exactly the granted intent: ${JSON.stringify(aged)}`);

  // 5. Present a NON-CURRENT fence on the commit — the guard sees exactly what a
  //    superseded worker's fence looks like, and answers `stale_fence`.
  //
  //    The FIRST attempt here back-dated the lease deadlines instead, and the commit
  //    SUCCEEDED: back-dating `expires_at` alone does not refuse, because the reaper is
  //    what converts an overdue lease into a terminal one (which is why e6f-09 pairs the
  //    two). The assertion covering it was `assert.ok(expired, …)` — vacuously true for
  //    any object — so it reported success while proving nothing. Both mistakes are the
  //    same class this suite exists to catch.
  //
  //    The presigned URL is UNAFFECTED by any of this. That is the whole hazard: the
  //    grant carries no fence material, so the bytes are already in the store.
  const staleFence = { ...fence, fenceToken: randomBytes(32).toString("base64url") };

  // 6. Commit must refuse — and refusing is what fires the sweep trigger.
  const manifest = {
    protocolVersion: 1,
    organizationId: ids.orgId, companyId: ids.companyId, jobId: ids.jobId, attempt,
    artifactId, objectKey, sha256: sha256Hex, sizeBytes: bodyBytes.length,
    contentType: "application/octet-stream", kind: "log", sensitivity: "restricted", retention: "run",
    // REQUIRED by the frozen manifest schema. Omitting it made the first live run answer
    // `malformed` rather than `rejected` — a protocol-level refusal that never reached the
    // fence check at all, so the test proved nothing about stale_fence.
    createdAt: new Date().toISOString(),
  };
  const committed = stepResult(artifactCommit({ session: enrolled.session, ...staleFence, manifest, deviceKey }), "commit");
  // ★ A stale fence is refused at the AUTH layer, not as a `rejected` OUTCOME. Run 3 proved
  // it: `resolveWorkerFenceContext` looks the lease up BY the presented fence token, so a
  // superseded fence finds no row and throws `JobLeasingError("stale_fence")`, which the
  // route renders as a top-level DENIAL envelope (`code`), never `{outcome:"rejected"}`.
  //
  // That distinction is not cosmetic — it is a PRODUCTION DEFECT this test found. The sweep
  // trigger sat in the catch around `commitArtifactVersion`, which this path never reaches,
  // so the sweep never fired on the very event it was designed for. Fixed in
  // artifact-commit.ts; asserted here so it cannot silently regress.
  assert.equal(
    committed.body.code, "stale_fence",
    `commit must be DENIED stale_fence after fence loss: ${JSON.stringify(committed.body)}`,
  );
  assert.equal(
    committed.body.outcome, undefined,
    `a stale fence is an auth-layer DENIAL, not a rejected outcome: ${JSON.stringify(committed.body)}`,
  );

  // 7. ★ THE PROOF: the orphaned object is actually GONE from the store.
  const swept = waitForObjectGone(objectKey);
  assert.equal(
    swept.gone, true,
    `the orphaned object must be deleted by the sweep within ${swept.polls} polls; last=${JSON.stringify(swept.last)}`,
  );

  // 8. And the intent row is marked, not silently dropped — so the deletion is auditable.
  const afterSweep = stepResult(queryJobArtifact({ organizationId: ids.orgId, jobId: ids.jobId, identifier: artifactId }), "intent-after");
  assert.equal(
    afterSweep.rows.some((r) => r.status === "swept"), true,
    `the intent must be transitioned to 'swept': ${JSON.stringify(afterSweep)}`,
  );
  assert.equal(
    afterSweep.rows.some((r) => r.status === "committed"), false,
    "a refused commit must NOT have produced a committed row",
  );
});
