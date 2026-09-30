import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const verifierUrl = new URL("./verify-e3-perf-01-handoff.mjs", import.meta.url);
const SECURITY_REALPATH_PROGRAM = 'const fs=require("node:fs");process.stdout.write(JSON.stringify(process.argv.slice(1).map((value)=>fs.realpathSync.native(value))))';

test("independent Security handoff verifier is an executable sealed command", async () => {
  // Mutation caught: omitting the distinct verifier leaves Integration's local QA/archive
  // self-attesting and lets a valid campaign-runner pin authorize substituted Security bytes.
  assert.equal(existsSync(verifierUrl), true, "independent Security verifier is missing");
  if (!existsSync(verifierUrl)) return;
  const verifier = await import("./verify-e3-perf-01-handoff.mjs");
  assert.equal(typeof verifier.runSecurityHandoffCommand, "function");
  if (typeof verifier.runSecurityHandoffCommand !== "function") return;

  const fixture = securityVerifierFixture();
  assert.deepEqual(Object.keys(fixture.capabilities).sort(), ["artifact", "clock", "process", "store"]);
  const outcome = await captureVerifierOutcome(() => verifier.runSecurityHandoffCommand([
    "--manifest", fixture.paths.manifest,
    "--qa", fixture.paths.qa,
    "--output", fixture.paths.handoff,
  ], fixture.capabilities));
  assert.equal(outcome.error, undefined, "the distinct Security command must execute end to end");
  assert.equal(outcome.value?.disposition, "pass");
  assert.equal(outcome.value?.objectVersion, "version-a1");
  assert.deepEqual(fixture.state.processRuns, [{
    executable: fixture.paths.node,
    argv: ["-e", SECURITY_REALPATH_PROGRAM, fixture.paths.verifier, fixture.paths.expectedVerifier],
    cwd: fixture.paths.checkout,
    env: fixture.state.bootstrap.parentEnvironment,
    shell: false,
  }], "Security must realpath the independently pinned verifier with the absolute pinned Node");
  const exactVersionRefetch = {
    objectUri: fixture.state.qa.objectUri,
    versionId: fixture.state.qa.objectVersion,
  };
  assert.deepEqual(fixture.state.storeTrace, [
    { operation: "head", input: exactVersionRefetch },
    { operation: "get", input: exactVersionRefetch },
    { operation: "retention", input: exactVersionRefetch },
  ], "head, get, and retention must all address the exact QA-pinned object version");
  assert.deepEqual(fixture.state.writes.map((entry) => entry.path), [fixture.paths.handoff]);
  const handoff = JSON.parse(fixture.state.writes[0].bytes.toString("utf8"));
  assert.equal(handoff.securityVerifierSha256, fixture.state.verifierSha256);
  assert.equal(handoff.campaignRunnerSha256, fixture.state.campaignRunnerSha256);
  assert.notEqual(handoff.securityVerifierSha256, handoff.campaignRunnerSha256);

  for (const missing of ["process", "artifact", "store", "clock"]) {
    const candidate = { ...fixture.capabilities };
    delete candidate[missing];
    const rejected = await captureVerifierOutcome(() => verifier.runSecurityHandoffCommand([
      "--manifest", fixture.paths.manifest, "--qa", fixture.paths.qa, "--output", fixture.paths.handoff,
    ], candidate));
    assert.equal(rejected.error?.code ?? rejected.value?.failureCode, "security_capabilities", missing);
  }
  const withExtra = { ...fixture.capabilities, campaign: {} };
  const extra = await captureVerifierOutcome(() => verifier.runSecurityHandoffCommand([
    "--manifest", fixture.paths.manifest, "--qa", fixture.paths.qa, "--output", fixture.paths.handoff,
  ], withExtra));
  assert.equal(extra.error?.code ?? extra.value?.failureCode, "security_capabilities");
});

test("independent Security verification refetches the exact immutable version and rejects every pin/readback/retention mutation", async () => {
  assert.equal(existsSync(verifierUrl), true, "independent Security verifier is missing");
  if (!existsSync(verifierUrl)) return;
  const verifier = await import("./verify-e3-perf-01-handoff.mjs");
  assert.equal(typeof verifier.runSecurityHandoffCommand, "function");
  if (typeof verifier.runSecurityHandoffCommand !== "function") return;

  const cases = [
    ["verifier_path", "security_verifier_path", (fixture) => {
      fixture.state.bootstrap.runnerScriptPath = fixture.paths.campaignRunner;
      fixture.rewriteBootstrap();
    }],
    ["verifier_relative", "security_verifier_path", (fixture) => {
      fixture.state.bootstrap.runnerScriptPath = "./verify-e3-perf-01-handoff.mjs";
      fixture.rewriteBootstrap();
    }],
    ["verifier_path_lookup", "security_verifier_path", (fixture) => {
      fixture.state.bootstrap.runnerScriptPath = "verify-e3-perf-01-handoff.mjs";
      fixture.rewriteBootstrap();
    }],
    ["verifier_manifest_digest", "security_verifier_digest", (fixture) => {
      fixture.state.bootstrap.runnerScriptSha256 = "0".repeat(64);
      fixture.rewriteBootstrap();
    }],
    ["verifier_bytes", "security_verifier_digest", (fixture) => {
      fixture.state.files.set(fixture.paths.verifier, Buffer.from("substituted-security-verifier"));
    }],
    ["node_relative", "security_node_path", (fixture) => {
      fixture.state.bootstrap.nodeExecutable = "./node";
      fixture.rewriteBootstrap();
    }],
    ["node_path_lookup", "security_node_path", (fixture) => {
      fixture.state.bootstrap.nodeExecutable = "node";
      fixture.rewriteBootstrap();
    }],
    ["node_manifest_digest", "security_node_digest", (fixture) => {
      fixture.state.bootstrap.nodeSha256 = "0".repeat(64);
      fixture.rewriteBootstrap();
    }],
    ["node_bytes", "security_node_digest", (fixture) => {
      fixture.state.files.set(fixture.paths.node, Buffer.from("substituted-security-node"));
    }],
    ["manifest_relative", "security_manifest_path", (fixture) => {
      fixture.state.bootstrap.manifestPath = "./perf-manifest.json";
      fixture.rewriteBootstrap();
    }],
    ["manifest_path_lookup", "security_manifest_path", (fixture) => {
      fixture.state.bootstrap.manifestPath = "perf-manifest.json";
      fixture.rewriteBootstrap();
    }],
    ["manifest_digest", "security_manifest_digest", (fixture) => {
      fixture.state.bootstrap.manifestSha256 = "0".repeat(64);
      fixture.rewriteBootstrap();
    }],
    ["manifest_bytes", "security_manifest_digest", (fixture) => {
      fixture.state.files.set(fixture.paths.manifest, Buffer.from("substituted-manifest"));
    }],
    ["bootstrap_unknown_field", "security_bootstrap_schema", (fixture) => {
      fixture.state.bootstrap.unreviewed = true;
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_missing_field", "security_bootstrap_schema", (fixture) => {
      delete fixture.state.bootstrap.runnerScriptSha256;
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_parent_unknown", "security_parent_environment", (fixture) => {
      fixture.state.bootstrap.parentEnvironment.UNREVIEWED = "1";
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_parent_missing", "security_parent_environment", (fixture) => {
      delete fixture.state.bootstrap.parentEnvironment.TZ;
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_locale", "security_parent_environment", (fixture) => {
      fixture.state.bootstrap.parentEnvironment.LANG = "en_US.UTF-8";
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_checkout_relative", "security_checkout_path", (fixture) => {
      fixture.state.bootstrap.checkoutPath = "./checkout";
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_output_relative", "security_output_path", (fixture) => {
      fixture.state.bootstrap.outputDirectory = "./output";
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_tmpdir_relative", "security_parent_environment", (fixture) => {
      fixture.state.bootstrap.parentEnvironment.TMPDIR = "./tmp";
      fixture.rewriteBootstrap();
    }],
    ["bootstrap_database_url_file_relative", "security_parent_environment", (fixture) => {
      fixture.state.bootstrap.parentEnvironment.AOA_E3_PERF_DATABASE_URL_FILE = "./database-url";
      fixture.rewriteBootstrap();
    }],
    ["realpath_nonzero", "security_verifier_path", (fixture) => {
      fixture.state.processResult = { code: 1, stdout: "", stderr: "stable failure" };
    }],
    ["realpath_bad_json", "security_verifier_path", (fixture) => {
      fixture.state.processResult = { code: 0, stdout: "not-json", stderr: "" };
    }],
    ["realpath_wrong_count", "security_verifier_path", (fixture) => {
      fixture.state.processResult = { code: 0, stdout: JSON.stringify([fixture.paths.verifier]), stderr: "" };
    }],
    ["realpath_mismatch", "security_verifier_path", (fixture) => {
      fixture.state.processResult = {
        code: 0,
        stdout: JSON.stringify([fixture.paths.campaignRunner, fixture.paths.expectedVerifier]),
        stderr: "",
      };
    }],
    ["realpath_case_mismatch", "security_verifier_path", (fixture) => {
      fixture.state.processResult = {
        code: 0,
        stdout: JSON.stringify([fixture.paths.verifier.toUpperCase(), fixture.paths.expectedVerifier]),
        stderr: "",
      };
    }],
    ["archive_hash", "security_archive_digest", (fixture) => {
      fixture.state.qa.archiveSha256 = "0".repeat(64);
      fixture.rewriteQa();
    }],
    ["archive_mutation", "security_archive_readback", (fixture) => { fixture.state.mutateArchive = true; }],
    ["archive_schema", "security_archive_schema", (fixture) => {
      fixture.replaceArchiveEvidence({ ...fixture.state.evidence, unreviewed: true });
    }],
    ["archive_canary", "security_archive_canary", (fixture) => {
      fixture.replaceArchiveEvidence({
        ...fixture.state.evidence,
        environment: { ...fixture.state.evidence.environment, cpuModel: "E3_SECRET_CANARY" },
      });
    }],
    ["archive_manifest_byte_length", "security_archive_schema", (fixture) => {
      fixture.replaceArchiveDocument((document) => {
        document.manifest[0].byteLength += 1;
      });
    }],
    ["archive_manifest_digest", "security_archive_schema", (fixture) => {
      fixture.replaceArchiveDocument((document) => {
        document.manifest[0].sha256 = "0".repeat(64);
      });
    }],
    ["archive_entry_correspondence", "security_archive_schema", (fixture) => {
      fixture.replaceArchiveDocument((document) => {
        document.entries[0].path = "substituted-evidence.json";
      });
    }],
    ["version_mismatch", "security_object_version", (fixture) => { fixture.state.headVersion = "version-attacker"; }],
    ["checksum_mismatch", "security_object_checksum", (fixture) => { fixture.state.headChecksum = "0".repeat(64); }],
    ["retention_absent", "security_object_retention", (fixture) => { fixture.state.retention = null; }],
    ["retention_governance", "security_object_retention", (fixture) => {
      fixture.state.retention = { mode: "GOVERNANCE", retainUntil: "2027-02-08T00:00:00.000Z" };
    }],
    ["retention_short", "security_object_retention", (fixture) => {
      fixture.state.retention = { mode: "COMPLIANCE", retainUntil: "2026-08-12T00:00:00.000Z" };
    }],
    ["backend_loss", "security_store_readback", (fixture) => { fixture.state.backendLost = true; }],
    ["handoff_collision", "security_handoff_exclusive", (fixture) => {
      fixture.state.existingWrites.add(fixture.paths.handoff);
    }],
  ];
  for (const [name, expectedCode, mutate] of cases) {
    const fixture = securityVerifierFixture();
    mutate(fixture);
    const outcome = await captureVerifierOutcome(() => verifier.runSecurityHandoffCommand([
      "--manifest", fixture.paths.manifest,
      "--qa", fixture.paths.qa,
      "--output", fixture.paths.handoff,
    ], fixture.capabilities));
    assert.equal(outcome.error?.code ?? outcome.value?.failureCode, expectedCode, name);
    assert.equal(fixture.state.writes.some((entry) => entry.path === fixture.paths.handoff), false, name);
    if (/^(?:verifier|node|manifest|bootstrap)_/u.test(name)) {
      assert.deepEqual(fixture.state.processRuns, [], `${name}: pins must fail before the Node realpath probe`);
      assert.deepEqual(fixture.state.storeTrace, [], `${name}: pins must fail before object readback`);
    }
    if (/^realpath_/u.test(name)) {
      assert.equal(fixture.state.processRuns.length, 1, `${name}: exact process gate must execute once`);
      assert.deepEqual(fixture.state.storeTrace, [], `${name}: realpath rejection must precede object readback`);
    }
  }

  for (const key of [
    "NODE_OPTIONS", "NODE_PATH", "PATH", "GIT_CONFIG", "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM", "GIT_SSH_COMMAND", "GIT_SSL_CAINFO", "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AWS_CA_BUNDLE", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    const fixture = securityVerifierFixture();
    fixture.state.parentEnvironment[key] = "attacker-value";
    const outcome = await captureVerifierOutcome(() => verifier.runSecurityHandoffCommand([
      "--manifest", fixture.paths.manifest,
      "--qa", fixture.paths.qa,
      "--output", fixture.paths.handoff,
    ], fixture.capabilities));
    assert.equal(outcome.error?.code ?? outcome.value?.failureCode, "security_parent_environment", key);
    assert.deepEqual(fixture.state.processRuns, [], `${key} must fail before the pinned Node probe`);
    assert.deepEqual(fixture.state.storeTrace, [], `${key} must fail before exact-version refetch`);
    assert.deepEqual(fixture.state.writes, [], `${key} must fail before handoff creation`);
  }
});

test("the real verifier rejects fake selectors before loading attacker code", () => {
  assert.equal(existsSync(verifierUrl), true, "independent Security verifier is missing");
  if (!existsSync(verifierUrl)) return;
  const verifierPath = fileURLToPath(verifierUrl);
  const source = readFileSync(verifierPath, "utf8");
  assert.match(source, /e3-perf-01-security-bootstrap\.json/);
  assert.match(source, /GetObjectRetention|COMPLIANCE|compliance/);
  assert.match(source, /security-handoff\.json/);
  assert.doesNotMatch(source, /(?:--fake|test[-_]?mode|fake[-_]?module|capabilit(?:y|ies)[-_]?path)/iu);
  assert.doesNotMatch(source, /from\s+["']\.\/run-e3-perf-01\.mjs["']/u);

  const result = spawnSync(process.execPath, [verifierPath, "--fake", "./attacker.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /attacker\.mjs|ERR_MODULE_NOT_FOUND/iu);
});

async function captureVerifierOutcome(run) {
  try {
    return { value: await run(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function securityEvidenceFixture() {
  const scenarios = [
    ["hot_worker_fully_certified_no_work", 0],
    ["hot_worker_head_saturated_999744_prefix", 256],
    ["ten_thousand_workers_by_one_hundred", 0],
    ["ninety_percent_stale_version_or_context", 256],
  ];
  const claims = scenarios.map(([scenario, rowCount], index) => ({
    kind: "claim_scenario",
    scenario,
    querySha256: "7".repeat(64),
    actualAttemptIds: Array.from({ length: rowCount }, (_, ordinal) => `${index}-${ordinal}`),
    samples: [10 + index],
    p95Ms: 10 + index,
    maxMs: 11 + index,
    plan: { Plan: { "Node Type": "Index Scan", "Actual Rows": rowCount } },
    planSummary: {
      indexes: ["jobs_claim_idx"], actualRows: rowCount, rowsRemoved: 0,
      heapFetches: 0, sharedBlocks: 1, localBlocks: 0, tempBlocks: 0,
    },
  }));
  const bulk = {
    kind: "bulk_upsert", querySha256: "8".repeat(64), affectedPerSample: [256],
    samples: [20], p95Ms: 20,
  };
  const cleanup = ["sparse", "tail"].map((layout) => ({
    kind: "cleanup", layout, querySha256: "9".repeat(64), affectedPerSample: [256],
    samples: [30], p95Ms: 30,
    plan: { Plan: { "Node Type": "Index Scan", "Actual Rows": 256 } },
    planSummary: {
      indexes: ["worker_lease_rejections_cleanup_idx"], actualRows: 256,
      rowsRemoved: 0, tempBlocks: 0, rootActualRows: 256, candidateRows: 256,
      affectedRows: 256,
    },
  }));
  const storage = {
    kind: "storage", candidate_rows: 1_000_000, certificate_rows: 1_000_000,
    joined_job_rows: 1_000_000, relation_bytes: 1, table_bytes: 1, index_bytes: 1,
    total_bytes: 2, indexes: [],
  };
  return {
    schemaVersion: 1,
    gate: "E3-PERF-01",
    attempt: "a1",
    implementationRevision: "1".repeat(40),
    environment: {
      imageDigest: `sha256:${"2".repeat(64)}`, kernel: "6.8.0", architecture: "x64",
      cpuModel: "pinned-security-cpu", vcpus: 8, ramMiB: 32768,
      storageClass: "pinned-ssd", filesystem: "ext4", mountFlags: ["nodev", "nosuid"],
      nodeVersion: "22.18.0", nodeSha256: "3".repeat(64), pnpmVersion: "10.14.0",
      pnpmSha256: "4".repeat(64), postgresVersion: "17.5",
      postgresBinarySha256: "5".repeat(64), postgresSettings: { shared_buffers: "8GB" },
    },
    dataset: { seed: 3003, candidateRows: 1_000_000, certificateRows: 1_000_000 },
    samples: claims.map((record) => ({
      scenario: record.scenario, milliseconds: record.p95Ms,
      actualRows: record.actualAttemptIds.length, removedRows: record.planSummary.rowsRemoved,
    })),
    storage: { tableBytes: 1, indexBytes: 1, combinedBytes: 2 },
    plans: claims.map((record) => ({ scenario: record.scenario, plan: record.plan.Plan })),
    measurementRecords: [...claims, bulk, ...cleanup, storage],
    productionQueryFingerprints: {
      claimSha256: "7".repeat(64), bulkUpsertSha256: "8".repeat(64),
      cleanupSha256: "9".repeat(64),
    },
    results: {
      thresholdsPassed: true, structurePassed: true, canaryScanPassed: true,
      failedThresholds: [],
    },
  };
}

function encodeSecurityArchive(evidence) {
  const bytes = Buffer.from(JSON.stringify(evidence));
  const entry = { path: "e3-perf-01-evidence.json", type: "file", bytes };
  const manifest = [{
    path: entry.path,
    type: entry.type,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }];
  return Buffer.from(JSON.stringify({
    format: "aoa-e3-perf-01-archive-v1",
    manifest,
    entries: [{ path: entry.path, type: entry.type, bytesBase64: bytes.toString("base64") }],
  }));
}

function securityVerifierFixture() {
  const paths = Object.freeze({
    checkout: "C:/security/checkout",
    manifest: "C:/security/checkout/perf-manifest.json",
    output: "C:/security/output/a1",
    temp: "C:/security/tmp/a1",
    databaseUrlFile: "C:/security/secrets/database-url",
    qa: "C:/security/output/a1/qa.json",
    handoff: "C:/security/output/a1/security-handoff.json",
    node: "C:/security/bin/node.exe",
    verifier: "C:/security/checkout/scripts/verify-e3-perf-01-handoff.mjs",
    expectedVerifier: "C:/security/checkout/scripts/verify-e3-perf-01-handoff.mjs",
    campaignRunner: "C:/security/checkout/scripts/run-e3-perf-01.mjs",
    bootstrap: "/run/aoa/e3-perf-01-security-bootstrap.json",
  });
  const nodeBytes = Buffer.from("pinned-security-node");
  const verifierBytes = Buffer.from("pinned-security-verifier");
  const campaignRunnerBytes = Buffer.from("pinned-integration-runner");
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, gate: "E3-PERF-01" }));
  const evidence = securityEvidenceFixture();
  const archiveBytes = encodeSecurityArchive(evidence);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const state = {
    files: new Map([
      [paths.node, nodeBytes],
      [paths.verifier, verifierBytes],
      [paths.campaignRunner, campaignRunnerBytes],
      [paths.manifest, manifestBytes],
      [paths.databaseUrlFile, Buffer.from("postgres://test-only.invalid/aoa")],
    ]),
    verifierSha256: sha256(verifierBytes),
    campaignRunnerSha256: sha256(campaignRunnerBytes),
    evidence,
    archiveBytes,
    archiveSha256: sha256(archiveBytes),
    mutateArchive: false,
    headVersion: "version-a1",
    headChecksum: sha256(archiveBytes),
    backendLost: false,
    processResult: {
      code: 0,
      stdout: JSON.stringify([paths.verifier, paths.expectedVerifier]),
      stderr: "",
    },
    retention: { mode: "COMPLIANCE", retainUntil: "2027-02-08T00:00:00.000Z" },
    storeTrace: [],
    writes: [],
    existingWrites: new Set(),
    processRuns: [],
    parentEnvironment: { AOA_BENIGN_AMBIENT_CANARY: "must-not-propagate" },
    bootstrap: {
      schemaVersion: 1,
      checkoutPath: paths.checkout,
      runnerScriptPath: paths.verifier,
      runnerScriptSha256: sha256(verifierBytes),
      manifestPath: paths.manifest,
      manifestSha256: sha256(manifestBytes),
      outputDirectory: paths.output,
      nodeExecutable: paths.node,
      nodeSha256: sha256(nodeBytes),
      parentEnvironment: {
        LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: paths.temp,
        AOA_E3_PERF_DATABASE_URL_FILE: paths.databaseUrlFile,
      },
    },
    qa: {
      schemaVersion: 1,
      disposition: "pass",
      objectUri: "s3://aoa-e3-perf/e3-perf-01/a1/archive",
      objectVersion: "version-a1",
      checksumSha256: sha256(archiveBytes),
      archiveSha256: sha256(archiveBytes),
      retentionUntil: "2027-02-08T00:00:00.000Z",
      objectLockMode: "COMPLIANCE",
    },
  };
  const rewriteBootstrap = () => state.files.set(paths.bootstrap, Buffer.from(JSON.stringify(state.bootstrap)));
  const rewriteQa = () => state.files.set(paths.qa, Buffer.from(JSON.stringify(state.qa)));
  const replaceArchiveEvidence = (replacement) => {
    state.evidence = structuredClone(replacement);
    state.archiveBytes = encodeSecurityArchive(state.evidence);
    state.archiveSha256 = sha256(state.archiveBytes);
    state.headChecksum = state.archiveSha256;
    state.qa.checksumSha256 = state.archiveSha256;
    state.qa.archiveSha256 = state.archiveSha256;
    rewriteQa();
  };
  const replaceArchiveDocument = (mutate) => {
    const document = JSON.parse(state.archiveBytes.toString("utf8"));
    mutate(document);
    state.archiveBytes = Buffer.from(JSON.stringify(document));
    state.archiveSha256 = sha256(state.archiveBytes);
    state.headChecksum = state.archiveSha256;
    state.qa.checksumSha256 = state.archiveSha256;
    state.qa.archiveSha256 = state.archiveSha256;
    rewriteQa();
  };
  rewriteBootstrap();
  rewriteQa();

  const capabilities = Object.freeze({
    process: Object.freeze({
      parentEnvironment: () => ({ ...state.parentEnvironment }),
      async run(input) {
        state.processRuns.push({
          executable: input.executable,
          argv: [...input.argv],
          cwd: input.cwd,
          env: { ...input.env },
          shell: input.shell,
        });
        return { ...state.processResult };
      },
    }),
    artifact: Object.freeze({
      async realpath(path) { return path; },
      async readFile(path) {
        const bytes = state.files.get(path);
        if (!bytes) throw Object.assign(new Error("missing artifact"), { code: "ENOENT" });
        return Buffer.from(bytes);
      },
      async writeExclusive(path, bytes) {
        if (state.existingWrites.has(path)) return false;
        state.existingWrites.add(path);
        state.writes.push({ path, bytes: Buffer.from(bytes) });
        return true;
      },
    }),
    store: Object.freeze({
      async headObject(input) {
        state.storeTrace.push({ operation: "head", input: structuredClone(input) });
        if (state.backendLost) throw Object.assign(new Error("backend unavailable"), { code: "BACKEND_LOST" });
        return {
          versionId: state.headVersion,
          checksumSha256: state.headChecksum,
          byteLength: state.archiveBytes.length,
        };
      },
      async getObject(input) {
        state.storeTrace.push({ operation: "get", input: structuredClone(input) });
        if (state.backendLost) throw Object.assign(new Error("backend unavailable"), { code: "BACKEND_LOST" });
        return state.mutateArchive ? Buffer.from("mutated-archive") : Buffer.from(state.archiveBytes);
      },
      async getObjectRetention(input) {
        state.storeTrace.push({ operation: "retention", input: structuredClone(input) });
        return state.retention && { ...state.retention };
      },
    }),
    clock: Object.freeze({ now: () => new Date("2026-08-11T01:05:00.000Z") }),
  });
  return {
    paths,
    state,
    capabilities,
    rewriteBootstrap,
    rewriteQa,
    replaceArchiveEvidence,
    replaceArchiveDocument,
  };
}
