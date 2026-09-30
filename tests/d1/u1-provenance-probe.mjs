// -----------------------------------------------------------------------------
// U1-PROVENANCE — the LIVE probe (Linux/CI or any host with Docker + a running
// D1 compose stack). Not a test: a MEASUREMENT an operator runs once.
//
//   AOA_D1_LIVE=1 node tests/d1/u1-provenance-probe.mjs
//
// Without AOA_D1_LIVE=1 it prints why it did nothing and exits 0. It is never
// faked and it asserts nothing on its own — it PRINTS two traces and a verdict.
//
// ── The question ─────────────────────────────────────────────────────────────
// `tests/d1/container-enrol.test.mjs` proves a real container daemon enrolled.
// `tests/d1/e6f-09-lease-faults.test.mjs:324` proves an applied `attempt_terminal`
// receipt is producible from the TEST RUNNER with no daemon anywhere. Both are
// true today, so the interesting question is the one neither answers:
//
//     Is there any row-level fact that ONLY a real container daemon can write?
//
// ── What this probe does ─────────────────────────────────────────────────────
// TARGET A — worker-b: the shipped worker image running `dist/bin/container-host.js`,
//            which read a POSIX enrolment ticket off a read-only mount, minted an
//            Ed25519 device key INSIDE the container, and enrolled against the real
//            control plane over toxiproxy. Read-only: nothing here touches it.
// TARGET B — a SYNTHETIC device the probe enrols itself, from the test-runner
//            container, into its own hermetic org/target — but forging the daemon's
//            hello field-for-field (`buildDesktopHello` with no provisioning) and
//            the daemon's DERIVED idempotency key, rather than the harness's usual
//            `agentVersion: "e6f-03-harness"` / `randomUUID()` defaults.
//
// It then reads, for both, every column the enrolment commits — `workers`
// (device_thumbprint, device_public_key, device_generation, profile_hash,
// profile_snapshot, status, scope, enrolled_at) and `worker_enrollment_codes`
// (consumed_at, device_thumbprint, semantic_idempotency_key, semantic_digest) —
// normalizes away the identifiers that differ BY CONSTRUCTION (org/target/worker
// ids, timestamps, the key bytes themselves), and diffs the rest.
//
// ── How to read the verdict ──────────────────────────────────────────────────
// INDISTINGUISHABLE  → the daemon lane cannot produce evidence better than the
//                      daemon's own stdout. That is the U1 finding.
// DISTINGUISHABLE    → print the differing keys and go check whether the
//                      difference is ENFORCED by the server or merely a
//                      convention the synthetic declined to copy. Only an
//                      enforced, unforgeable difference rescues the lane.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  dexecModule,
  enroll,
  generateDeviceKey,
  newEnrollmentCode,
  newScenarioIds,
  seedScenario,
} from "./lib/e6f-harness.mjs";

const LIVE = process.env.AOA_D1_LIVE === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!LIVE) {
  console.log(
    "u1-provenance-probe: SKIPPED. Set AOA_D1_LIVE=1 and bring up docker-compose.d1.yml\n" +
    "  (docker compose -f docker-compose.d1.yml up -d --wait), then re-run. This probe\n" +
    "  is never faked: with no stack there is nothing honest to print.",
  );
  process.exit(0);
}

// ── the committed ticket is the one source of truth for TARGET A ─────────────
function workerBTargetId() {
  const raw = readFileSync(path.join(repoRoot, "docker", "d1", "worker-b.enrollment-ticket"), "utf8").trim();
  return JSON.parse(Buffer.from(raw.slice("aoa_tkt_".length), "base64url").toString("utf8")).targetId;
}

/** One SQL read in the control-plane container (owner role, as seedScenario uses). */
function query(sqlText, params) {
  return dexecModule(
    "control-plane",
    `import postgres from "postgres";
     const P = ${JSON.stringify(params)};
     const sql = postgres(process.env.DATABASE_URL, { max: 1 });
     try {
       const rows = await sql.unsafe(${JSON.stringify(sqlText)}, P);
       console.log("__E6F_RESULT__" + JSON.stringify({ rows }));
     } finally { await sql.end({ timeout: 5 }); }`,
  );
}

/**
 * The daemon's enrolment idempotency key — `packages/worker-daemon/src/enrollment/
 * idempotency.ts`, reproduced here so the probe needs no daemon build. It takes
 * only public values; reproducing it is the point.
 */
function deriveEnrollmentIdempotencyKey(workerId, targetId, deviceGeneration) {
  const digest = createHash("sha256")
    .update(`aoa.worker.enroll.idem.v1|${workerId}|${targetId}|${deviceGeneration}`, "utf8")
    .digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * The container daemon's hello — `buildDesktopHello` with NO provisioning, which
 * is what `enroll-once.ts:265` builds and what `container-host.js` therefore sends.
 * Reproduced as a literal so the probe demonstrates the forgery rather than
 * importing the thing it claims a synthetic cannot have.
 */
function forgedDaemonHello({ workerId, targetId, deviceGeneration = 1 }) {
  return {
    protocolVersion: 1,
    workerId,
    targetId,
    deviceGeneration,
    agentVersion: "0.1.0", // config.ts WORKER_VERSION
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "desktop" }, // DESKTOP_RUNTIME_LABEL
    reportedCapabilities: [], // capabilitiesForIsolation("none")
    capacity: {
      batchSlots: 0, browserSessionSlots: 0, serviceSlots: 0,
      freeCpuMillis: 0, freeMemoryMiB: 0, freeDiskMiB: 0,
    },
    policyHash: "0".repeat(64), // UNPROVISIONED_POLICY_HASH
  };
}

/** Read every column the enrolment commits, for one execution target. */
function traceFor(targetId, label) {
  const workerQ = query(
    `SELECT id, scope, status, device_generation, device_public_key, device_thumbprint,
            profile_hash, profile_snapshot, enrolled_at, revoked_at, last_seen_at
       FROM workers WHERE execution_target_id = $1`,
    [targetId],
  );
  const codeQ = query(
    `SELECT consumed_at IS NOT NULL AS consumed, device_thumbprint,
            semantic_idempotency_key, semantic_digest, scope
       FROM worker_enrollment_codes WHERE execution_target_id = $1`,
    [targetId],
  );
  if (!workerQ.result || !codeQ.result) {
    throw new Error(`${label}: no SQL result\n${workerQ.stdout}${workerQ.stderr}${codeQ.stdout}${codeQ.stderr}`);
  }
  if (workerQ.result.rows.length !== 1) {
    throw new Error(`${label}: expected exactly one worker row, got ${workerQ.result.rows.length}`);
  }
  return { label, targetId, worker: workerQ.result.rows[0], code: codeQ.result.rows[0] ?? null };
}

/**
 * Strip what differs BY CONSTRUCTION — ids, timestamps, and the key bytes — so
 * what remains is only the SHAPE of the claim each enroller made. Keeping the ids
 * in would make every pair trivially "distinguishable" and answer nothing.
 */
function normalize(trace) {
  const w = trace.worker;
  const snapshot = typeof w.profile_snapshot === "string" ? JSON.parse(w.profile_snapshot) : w.profile_snapshot;
  const helloShape = { ...snapshot, workerId: "<id>", targetId: "<id>" };
  return {
    "workers.scope": w.scope,
    "workers.status": w.status,
    "workers.device_generation": w.device_generation,
    "workers.device_public_key.shape": /^[A-Za-z0-9_-]+$/.test(String(w.device_public_key)) ? "base64url-spki" : "OTHER",
    "workers.device_thumbprint.shape": /^[0-9a-f]{64}$/.test(String(w.device_thumbprint)) ? "sha256-hex" : "OTHER",
    "workers.device_thumbprint == sha256(spki)": createHash("sha256")
      .update(Buffer.from(String(w.device_public_key), "base64url")).digest("hex") === String(w.device_thumbprint),
    "workers.profile_hash == sha256(snapshot)": createHash("sha256")
      .update(JSON.stringify(snapshot)).digest("hex") === String(w.profile_hash),
    "workers.enrolled_at.present": w.enrolled_at !== null,
    "workers.revoked_at": w.revoked_at,
    "workers.profile_snapshot": helloShape,
    "codes.consumed": trace.code?.consumed ?? null,
    "codes.device_thumbprint == workers.device_thumbprint":
      trace.code ? trace.code.device_thumbprint === w.device_thumbprint : null,
    "codes.semantic_idempotency_key == derive(worker,target,gen)":
      trace.code ? trace.code.semantic_idempotency_key ===
        deriveEnrollmentIdempotencyKey(w.id, trace.targetId, w.device_generation) : null,
    "codes.semantic_digest.shape":
      trace.code && /^[0-9a-f]{64}$/.test(String(trace.code.semantic_digest)) ? "sha256-hex" : "OTHER",
  };
}

// ── TARGET B: enrol a synthetic device that FORGES the daemon's claim ────────
function enrolSynthetic() {
  const ids = newScenarioIds();
  const code = newEnrollmentCode();
  const seeded = seedScenario({ ids, code });
  if (!seeded.result?.ok) {
    throw new Error(`seedScenario failed: ${seeded.result?.error ?? seeded.stdout + seeded.stderr}`);
  }
  // The FORGED hello — the daemon's, not the harness's usual
  // `agentVersion: "e6f-03-harness"` / `runtime: "worker"` fixture values.
  const hello = forgedDaemonHello({ workerId: ids.workerId, targetId: ids.targetId });
  // The harness mints its key with plain `node:crypto` — the SAME primitive the
  // daemon reaches through `generateDeviceKey`. That equivalence is half the finding.
  const deviceKey = generateDeviceKey();
  const res = enroll({ code: code.code, hello, deviceKey });
  if (!res.result || res.result.status !== 200) {
    throw new Error(`synthetic enroll failed: ${JSON.stringify(res.result ?? res.stdout + res.stderr)}`);
  }
  return ids.targetId;
}

// ── run ──────────────────────────────────────────────────────────────────────

const a = traceFor(workerBTargetId(), "A: worker-b (real container daemon)");
const b = traceFor(enrolSynthetic(), "B: synthetic device (test runner)");

const na = normalize(a);
const nb = normalize(b);

const differing = Object.keys(na).filter((k) => JSON.stringify(na[k]) !== JSON.stringify(nb[k]));

console.log("\n=== U1 PROVENANCE PROBE ===\n");
console.log(`${a.label}\n  target=${a.targetId} worker=${a.worker.id}`);
console.log(JSON.stringify(na, null, 2));
console.log(`\n${b.label}\n  target=${b.targetId} worker=${b.worker.id}`);
console.log(JSON.stringify(nb, null, 2));

console.log("\n--- VERDICT ---");
if (differing.length === 0) {
  console.log(
    "INDISTINGUISHABLE. Every enrolment-committed fact a real container daemon writes was\n" +
    "reproduced by a test runner holding an enrolment code. No daemon lane can produce\n" +
    "row-level evidence stronger than the daemon's own stdout.",
  );
} else {
  console.log("DISTINGUISHABLE on:");
  for (const key of differing) {
    console.log(`  ${key}\n    A=${JSON.stringify(na[key])}\n    B=${JSON.stringify(nb[key])}`);
  }
  console.log(
    "\n★ Before treating this as a rescue: check whether the server ENFORCES each\n" +
    "  difference. `agentVersion` and `platform.runtime` are free-form strings\n" +
    "  (packages/worker-protocol/src/capabilities.ts:372, :110) that no server code\n" +
    "  validates — a difference there is a convention the synthetic declined to copy,\n" +
    "  not a fact it could not have written.",
  );
}
