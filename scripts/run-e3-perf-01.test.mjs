import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REQUIRED_ASSETS = [
  new URL("./run-e3-perf-01.mjs", import.meta.url),
  new URL("./e3-perf-01-manifest.schema.json", import.meta.url),
  new URL("./e3-perf-01-evidence.schema.json", import.meta.url),
  new URL("../server/src/__tests__/job-leasing-load.integration.test.ts", import.meta.url),
];
const GENERATED_PERF_ASSET_PATHS = [
  "scripts/run-e3-perf-01.mjs",
  "scripts/e3-perf-01-manifest.schema.json",
  "scripts/e3-perf-01-evidence.schema.json",
];
const assetsPresent = REQUIRED_ASSETS.every((asset) => existsSync(asset));
const SHA40 = "1".repeat(40);
const TREE40 = "2".repeat(40);
const BLOB40 = "3".repeat(40);
const SHA256 = "4".repeat(64);
const EVIDENCE_PARENT_SHA40 = "5".repeat(40);
const GATE_SHA40 = "6".repeat(40);
const IMPLEMENTATION_TREE40 = "7".repeat(40);
const GATE_TREE40 = "8".repeat(40);
const MANIFEST_BLOB40 = "9".repeat(40);
const MANIFEST_SHA256 = "c".repeat(64);
const EVIDENCE_ARCHIVE_PATH = "e3-perf-01-evidence.json";
const CAMPAIGN_NOW = "2026-08-11T01:05:00.000Z";
const MINIMUM_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const OBJECT_LOCK_MODE = "compliance";
// Tracked Drizzle snapshots are currently about 2.2 MiB; keep reads bounded at 8 MiB with >3x headroom.
const GIT_OBJECT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const HERMETIC_MANIFEST_PREFLIGHT_TIMEOUT_MS = 5 * 60_000;
const REVIEWED_BENCHMARK_ENVIRONMENT = Object.freeze({
  NODE_ENV: "test",
  TZ: "UTC",
});
const E3_PERF_01_CHILD_COMMAND = Object.freeze([
  "pnpm", "exec", "vitest", "run",
  "server/src/__tests__/job-leasing-load.integration.test.ts", "--maxWorkers=1",
]);
const E3_PERF_01_SHAPES = [
  "hot_worker_fully_certified_then_head_saturated",
  "ten_thousand_workers_by_one_hundred",
  "ninety_percent_stale_version_or_context",
  "cleanup_sparse_then_tail",
];
const E3_PERF_01_CLAIM_SCENARIOS = [
  "hot_worker_fully_certified_no_work",
  "hot_worker_head_saturated_999744_prefix",
  "ten_thousand_workers_by_one_hundred",
  "ninety_percent_stale_version_or_context",
];
const E3_PERF_01_EXPECTED_CLAIM_ROWS = {
  hot_worker_fully_certified_no_work: 0,
  hot_worker_head_saturated_999744_prefix: 256,
  ten_thousand_workers_by_one_hundred: 0,
  ninety_percent_stale_version_or_context: 256,
};
const REQUIRED_PINNED_INPUT_PATHS = [
  "scripts/run-e3-perf-01.mjs",
  "scripts/run-e3-perf-01.test.mjs",
  "scripts/e3-perf-01-manifest.schema.json",
  "scripts/e3-perf-01-evidence.schema.json",
  "server/src/__tests__/job-leasing-load.integration.test.ts",
  "package.json",
  "server/package.json",
  "packages/db/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "vitest.config.ts",
  "server/vitest.config.ts",
];
const TRACKED_SOURCE_PREFIXES = [
  "server/src",
  "packages/db/src",
  "packages/shared/src",
  "packages/worker-protocol/src",
];
const ATTESTED_DIRTY_PATHS = [
  "scripts/run-e3-perf-01.mjs",
  "scripts/run-e3-perf-01.test.mjs",
  "scripts/e3-perf-01-manifest.schema.json",
  "scripts/e3-perf-01-evidence.schema.json",
  "server/src/__tests__/job-leasing-load.integration.test.ts",
  "vitest.config.ts",
  "server/vitest.config.ts",
  "package.json",
  "server/package.json",
  "packages/db/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "packages/db/src/schema/jobs.ts",
  "packages/db/src/migrations/0230_static_certificates.sql",
  "packages/db/src/repositories/tenant/job-control.ts",
];
const TRACKED_INPUT_MODE_BY_PATH = new Map();

function loadPinnedServerAjv2020() {
  return createRequire(new URL("../server/package.json", import.meta.url))("ajv/dist/2020.js").default;
}

function completePinnedInputPaths() {
  const tracked = execFileSync(
    "git",
    ["--no-replace-objects", "ls-files", "--stage", "--", ...TRACKED_SOURCE_PREFIXES],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  ).split(/\r?\n/).filter(Boolean).map((line) => {
    const [metadata, path] = line.split("\t", 2);
    const [mode] = metadata.split(" ");
    assert.match(mode, /^100(?:644|755)$/);
    TRACKED_INPUT_MODE_BY_PATH.set(path, mode);
    return path;
  });
  const paths = [...new Set([...REQUIRED_PINNED_INPUT_PATHS, ...tracked])].sort();
  for (const required of REQUIRED_PINNED_INPUT_PATHS) {
    assert.ok(paths.includes(required), `complete input inventory omits ${required}`);
  }
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    const expected = tracked.filter((path) => path === prefix || path.startsWith(`${prefix}/`));
    assert.ok(expected.length > 0, `tracked input prefix is empty: ${prefix}`);
    assert.deepEqual(paths.filter((path) => path === prefix || path.startsWith(`${prefix}/`)), expected.sort());
  }
  return paths;
}

const COMPLETE_PINNED_INPUT_PATHS = completePinnedInputPaths();

function inputFact(path) {
  return {
    path,
    mode: TRACKED_INPUT_MODE_BY_PATH.get(path) ?? "100644",
    blob: createHash("sha1").update(`e3-perf-01-blob:${path}`).digest("hex"),
    sha256: createHash("sha256").update(`e3-perf-01-bytes:${path}`).digest("hex"),
  };
}

function reviewedEvidenceFact(path) {
  return {
    path,
    status: "M",
    mode: "100644",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    sha256: "d".repeat(64),
    reviewEvidenceBlob: "e".repeat(40),
  };
}

function completeInputInventoryFixture() {
  return COMPLETE_PINNED_INPUT_PATHS.map(inputFact);
}

test("E3-PERF-01 requires the reviewed runner, strict schemas, and dedicated load suite", () => {
  assert.deepEqual(
    REQUIRED_ASSETS.filter((asset) => !existsSync(asset)).map((asset) => asset.pathname.split("/").at(-1)),
    [],
    "required E3-PERF-01 implementation assets missing",
  );
});

function cliResultEnvelope(result, expected) {
  const completeOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = [result.stdout ?? "", result.stderr ?? ""]
    .flatMap((stream) => stream.split(/\r?\n/u))
    .filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "the real CLI must emit exactly one record and no extra/non-JSON output");
  let record;
  assert.doesNotThrow(() => { record = JSON.parse(lines[0]); }, "the only CLI output record must be JSON");
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  assert.deepEqual(
    Object.keys(record).sort(),
    ["disposition", "kind", "mode", "phase"],
    "the CLI result envelope is closed and rejects extra keys",
  );
  assert.deepEqual(record, expected);
  assert.doesNotMatch(
    completeOutput,
    /E3_[A-Z0-9_]*CANARY|authorization\s*:\s*bearer|password\s*=|AKIA[0-9A-Z]{16}/iu,
    "complete CLI stdout and stderr must be secret/canary free",
  );
  return record;
}

test("the real CLI implements pre-commit validation and campaign trigger modes", { skip: !assetsPresent }, async () => {
  const root = await mkdtemp(join(tmpdir(), "e3-perf-01-cli-"));
  try {
    const manifestPath = join(root, "manifest.json");
    const outputPath = join(root, "output");
    await writeFile(manifestPath, `${JSON.stringify(manifestFixture())}\n`, "utf8");
    const runnerPath = fileURLToPath(REQUIRED_ASSETS[0]);
    const validation = spawnSync(process.execPath, [
      runnerPath,
      "--validate-manifest", manifestPath,
      "--evidence-parent", EVIDENCE_PARENT_SHA40,
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    assert.equal(validation.error, undefined);
    assert.notEqual(validation.status, 0, "synthetic Git facts must fail closed in validation mode");
    cliResultEnvelope(validation, {
      kind: "e3_perf_01_cli_failure",
      mode: "validate-manifest",
      phase: "manifest-preflight",
      disposition: "fail",
    });

    const campaign = spawnSync(process.execPath, [
      runnerPath,
      "--manifest", manifestPath,
      "--output", outputPath,
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    assert.equal(campaign.error, undefined);
    assert.notEqual(campaign.status, 0, "an unattested fixture campaign must fail during real preflight");
    cliResultEnvelope(campaign, {
      kind: "e3_perf_01_cli_failure",
      mode: "campaign",
      phase: "campaign-preflight",
      disposition: "fail",
    });

    for (const sensitiveValue of [
      "E3_CLI_CANARY_DO_NOT_PERSIST",
      "Authorization: Bearer E3_CLI_BEARER_DO_NOT_PERSIST",
      "password=E3_CLI_PASSWORD_DO_NOT_PERSIST",
    ]) {
      const sensitiveManifest = manifestFixture();
      sensitiveManifest.environment.cpuModel = sensitiveValue;
      await writeFile(manifestPath, `${JSON.stringify(sensitiveManifest)}\n`, "utf8");
      const sensitive = spawnSync(process.execPath, [
        runnerPath,
        "--validate-manifest", manifestPath,
        "--evidence-parent", EVIDENCE_PARENT_SHA40,
      ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 });
      assert.equal(sensitive.error, undefined);
      assert.notEqual(sensitive.status, 0);
      assert.equal(`${sensitive.stdout}${sensitive.stderr}`.includes(sensitiveValue), false);
      cliResultEnvelope(sensitive, {
        kind: "e3_perf_01_cli_failure",
        mode: "validate-manifest",
        phase: "manifest-preflight",
        disposition: "fail",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real CLI default Git adapter accepts one hermetic evidence-parent preflight", { skip: !assetsPresent }, async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "e3-perf-01-git-adapter-"));
  const worktree = join(fixtureRoot, "worktree");
  let worktreeAdded = false;
  const gitText = (args, cwd = worktree) => execFileSync(
    "git", ["--no-replace-objects", ...args], { cwd, encoding: "utf8" },
  ).trim();
  const gitBytes = (args, cwd = worktree) => execFileSync(
    "git", ["--no-replace-objects", ...args], { cwd, maxBuffer: GIT_OBJECT_MAX_BUFFER_BYTES },
  );
  try {
    const baseRevision = gitText(["rev-parse", "HEAD"], repositoryRoot);
    execFileSync("git", [
      "-c", "core.autocrlf=false",
      "worktree", "add", "--detach", worktree, baseRevision,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    worktreeAdded = true;

    for (const path of GENERATED_PERF_ASSET_PATHS) {
      const source = join(repositoryRoot, ...path.split("/"));
      const destination = join(worktree, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(source));
    }
    const implementationDelta = gitText(
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...GENERATED_PERF_ASSET_PATHS],
    );
    if (implementationDelta.length > 0) {
      execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", ...GENERATED_PERF_ASSET_PATHS], {
        cwd: worktree,
      });
      execFileSync("git", [
        "-c", "user.name=E3 Perf Fixture",
        "-c", "user.email=e3-perf-fixture@example.invalid",
        "commit", "--no-verify", "-m", "test: pin hermetic implementation assets",
      ], { cwd: worktree, encoding: "utf8" });
    }
    const implementationRevision = gitText(["rev-parse", "HEAD"]);

    const reviewedPaths = [
      "docs/replatform/epics/E3-job-control/findings.md",
      "docs/replatform/epics/E3-job-control/tickets/JOB-003-result.md",
    ];
    for (const [index, path] of reviewedPaths.entries()) {
      const absolute = join(worktree, ...path.split("/"));
      const original = await readFile(absolute, "utf8");
      await writeFile(
        absolute,
        `${original.trimEnd()}\n\n<!-- hermetic E3-PERF-01 review closure ${index + 1} -->\n`,
        "utf8",
      );
    }
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", ...reviewedPaths], { cwd: worktree });
    execFileSync("git", [
      "-c", "user.name=E3 Perf Fixture",
      "-c", "user.email=e3-perf-fixture@example.invalid",
      "commit", "--no-verify", "-m", "test: create hermetic evidence parent",
    ], { cwd: worktree, encoding: "utf8" });
    const evidenceParentRevision = gitText(["rev-parse", "HEAD"]);
    const evidenceParentTree = gitText(["rev-parse", "HEAD^{tree}"]);

    const factAtRevision = (path, revision) => {
      const row = gitText(["ls-tree", revision, "--", path]);
      const [metadata, resolvedPath] = row.split("\t", 2);
      const [mode, type, blob] = metadata.split(" ");
      assert.equal(resolvedPath, path);
      assert.equal(type, "blob");
      const bytes = gitBytes(["show", `${revision}:${path}`]);
      return { path, mode, blob, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const sourceInputs = COMPLETE_PINNED_INPUT_PATHS.map((path) => factAtRevision(path, implementationRevision));
    const sourceByPath = new Map(sourceInputs.map((fact) => [fact.path, fact]));
    const reviewedEvidence = reviewedPaths.map((path) => {
      const oldFact = factAtRevision(path, implementationRevision);
      const newFact = factAtRevision(path, evidenceParentRevision);
      return {
        path,
        status: "M",
        mode: newFact.mode,
        oldBlob: oldFact.blob,
        newBlob: newFact.blob,
        sha256: newFact.sha256,
        reviewEvidenceBlob: newFact.blob,
      };
    });
    reviewedEvidence[0].reviewEvidenceBlob = reviewedEvidence[1].newBlob;
    reviewedEvidence[1].reviewEvidenceBlob = reviewedEvidence[0].newBlob;

    const manifest = manifestFixture();
    manifest.implementationRevision = implementationRevision;
    manifest.evidenceParentRevision = evidenceParentRevision;
    manifest.evidenceParentTree = evidenceParentTree;
    manifest.manifestPath =
      `docs/replatform/epics/E3-job-control/qa/fixture-e3-perf-01-${implementationRevision.slice(0, 12)}-a1.json`;
    manifest.reviewedEvidence = reviewedEvidence;
    manifest.sourceInputs = sourceInputs;
    manifest.dependencyClosure.criticalInputs = REQUIRED_PINNED_INPUT_PATHS.map((path) =>
      structuredClone(sourceByPath.get(path)));
    manifest.output.namespace = `s3://aoa-e3-perf/e3-perf-01/${implementationRevision}/a1`;
    manifest.output.retentionUntil = new Date(
      Date.parse(CAMPAIGN_NOW) + MINIMUM_RETENTION_MS,
    ).toISOString();
    const manifestPath = join(worktree, ...manifest.manifestPath.split("/"));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    assert.deepEqual(
      gitText(["status", "--porcelain=v1", "--untracked-files=all"]).split(/\r?\n/u),
      [`?? ${manifest.manifestPath}`],
    );

    const worktreeRunnerPath = join(worktree, "scripts", "run-e3-perf-01.mjs");
    const executedRunnerBytes = await readFile(worktreeRunnerPath);
    const pinnedRunner = sourceByPath.get("scripts/run-e3-perf-01.mjs");
    assert.ok(pinnedRunner, "the manifest must pin the runner that this fixture executes");
    assert.equal(
      createHash("sha256").update(executedRunnerBytes).digest("hex"),
      pinnedRunner.sha256,
      "the executed detached-worktree runner bytes must equal the manifest implementation input",
    );
    assert.equal(
      gitText(["hash-object", "--", worktreeRunnerPath]),
      pinnedRunner.blob,
      "the executed detached-worktree runner Git blob must equal the manifest implementation input",
    );
    assert.deepEqual(
      executedRunnerBytes,
      gitBytes(["show", `${implementationRevision}:scripts/run-e3-perf-01.mjs`]),
      "the runner process must execute the exact implementation-revision bytes",
    );

    const result = spawnSync(process.execPath, [
      worktreeRunnerPath,
      "--validate-manifest", manifest.manifestPath,
      "--evidence-parent", evidenceParentRevision,
    ], { cwd: worktree, encoding: "utf8", timeout: HERMETIC_MANIFEST_PREFLIGHT_TIMEOUT_MS });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    cliResultEnvelope(result, {
      kind: "e3_perf_01_cli_result",
      mode: "validate-manifest",
      phase: "manifest-preflight",
      disposition: "pass",
    });
  } finally {
    if (worktreeAdded) {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function runner() {
  const mod = await import("./run-e3-perf-01.mjs");
  for (const exportName of [
    "validateManifestDocument", "validateEvidenceDocument", "validateContentAddressedInputUri",
    "validateProspectiveOutputNamespace", "deriveDigestAddressedOutputUri", "buildEvidenceArchive",
    "encodeEvidenceArchive", "decodeEvidenceArchive", "validateEvidenceArchive", "runE3Perf01",
  ]) assert.equal(typeof mod[exportName], "function", `runner export ${exportName} must exist`);
  return mod;
}

function manifestFixture() {
  return {
    schemaVersion: 1,
    gate: "E3-PERF-01",
    attempt: "a1",
    implementationRevision: SHA40,
    evidenceParentRevision: EVIDENCE_PARENT_SHA40,
    evidenceParentTree: TREE40,
    manifestPath: `docs/replatform/epics/E3-job-control/qa/2026-08-11-e3-perf-01-${SHA40.slice(0, 12)}-a1.json`,
    reviewedEvidence: [{
      path: "docs/replatform/epics/E3-job-control/tickets/JOB-003-result.md",
      status: "M",
      mode: "100644",
      oldBlob: "6".repeat(40),
      newBlob: BLOB40,
      sha256: SHA256,
      reviewEvidenceBlob: "7".repeat(40),
    }],
    owners: {
      integration: { id: "e3-integration-gate-owner", approvedAt: "2026-08-11T01:00:00.000Z" },
      security: { id: "e3-security-gate-owner", approvedAt: "2026-08-11T01:05:00.000Z" },
    },
    runnerImage: {
      uri: `oci://registry.example.invalid/aoa/e6f06@sha256:${"8".repeat(64)}`,
      digest: `sha256:${"8".repeat(64)}`,
      attestationUri: `https://evidence.example.invalid/attestations/sha256/${"9".repeat(64)}`,
      attestationSha256: "9".repeat(64),
      policyUri: `s3://aoa-evidence/policy/sha256/${"a".repeat(64)}`,
      policySha256: "a".repeat(64),
      trustRootUri: `gs://aoa-trust/roots/sha256/${"b".repeat(64)}`,
      trustRootSha256: "b".repeat(64),
      e6f06QaBlob: "c".repeat(40),
      e6f06HandoffBlob: "d".repeat(40),
    },
    environment: {
      cpuModel: "pinned-cpu",
      vcpus: 8,
      ramMiB: 32768,
      storageClass: "pinned-ssd",
      filesystem: "ext4",
      mountFlags: ["nodev", "nosuid"],
      tmpfsMiB: 4096,
      nodeVersion: "22.18.0",
      nodeSha256: "e".repeat(64),
      pnpmVersion: "10.14.0",
      pnpmSha256: "f".repeat(64),
      postgresVersion: "17.5",
      postgresBinarySha256: "1".repeat(64),
      postgresSettings: { shared_buffers: "8GB", work_mem: "64MB" },
      competingWorkloadPolicy: "exclusive",
    },
    dataset: {
      seed: 3003,
      candidateRows: 1_000_000,
      certificateRows: 1_000_000,
      shapes: E3_PERF_01_SHAPES,
      claimScenarios: E3_PERF_01_CLAIM_SCENARIOS,
      warmups: 5,
      claimSamples: 30,
      mutationSamples: 20,
    },
    productionQueryFingerprints: {
      claimSha256: "7".repeat(64),
      bulkUpsertSha256: "8".repeat(64),
      cleanupSha256: "9".repeat(64),
    },
    thresholds: {
      shapesTwoThreeP95Ms: 250,
      shapesTwoThreeMaxMs: 1500,
      saturatedP95Ms: 2000,
      saturatedMaxMs: 5000,
      bulkUpsertP95Ms: 500,
      cleanupP95Ms: 750,
      combinedTableIndexBytesMax: 2 * 1024 * 1024 * 1024,
    },
    structuralRequirements: {
      exactRows: true,
      requiredIndexes: [
        "jobs_claim_idx", "job_attempts_lease_candidate_idx", "worker_lease_rejections_pkey",
        "worker_lease_rejections_cleanup_idx",
      ],
      noUnboundedSort: true,
      noHotSequentialScan: true,
    },
    sourceInputs: completeInputInventoryFixture(),
    dependencyClosure: {
      frozenInstallInventorySha256: "2".repeat(64),
      packageStoreIntegritySha256: "3".repeat(64),
      criticalInputs: REQUIRED_PINNED_INPUT_PATHS.map(inputFact),
    },
    referencedEvidence: [
      {
        uri: `https://evidence.example.invalid/reviews/sha256/${"6".repeat(64)}`,
        sha256: "6".repeat(64),
      },
      {
        uri: `s3://aoa-evidence/gates/sha256/${"5".repeat(64)}`,
        sha256: "5".repeat(64),
      },
    ],
    output: {
      origin: "s3://aoa-e3-perf",
      namespace: `s3://aoa-e3-perf/e3-perf-01/${SHA40}/a1`,
      retentionUntil: "2027-02-08T00:00:00.000Z",
    },
  };
}

function evidenceFixture(measurementRecords = loadEvidenceRecordsFixture()) {
  const claimRecords = measurementRecords.filter((record) => record.kind === "claim_scenario");
  const storageRecord = measurementRecords.find((record) => record.kind === "storage");
  const bulkRecord = measurementRecords.find((record) => record.kind === "bulk_upsert");
  const cleanupRecord = measurementRecords.find((record) => record.kind === "cleanup");
  return {
    schemaVersion: 1,
    gate: "E3-PERF-01",
    attempt: "a1",
    implementationRevision: SHA40,
    environment: {
      imageDigest: `sha256:${"8".repeat(64)}`,
      kernel: "6.8.0",
      architecture: "x64",
      cpuModel: "pinned-cpu",
      vcpus: 8,
      ramMiB: 32768,
      storageClass: "pinned-ssd",
      filesystem: "ext4",
      mountFlags: ["nodev", "nosuid"],
      nodeVersion: "22.18.0",
      nodeSha256: "e".repeat(64),
      pnpmVersion: "10.14.0",
      pnpmSha256: "f".repeat(64),
      postgresVersion: "17.5",
      postgresBinarySha256: "1".repeat(64),
      postgresSettings: { shared_buffers: "8GB", work_mem: "64MB" },
    },
    dataset: { seed: 3003, candidateRows: 1_000_000, certificateRows: 1_000_000 },
    samples: claimRecords.map((record) => ({
      scenario: record.scenario,
      milliseconds: record.p95Ms,
      actualRows: record.actualAttemptIds.length,
      removedRows: record.planSummary.rowsRemoved,
    })),
    storage: {
      tableBytes: storageRecord.table_bytes,
      indexBytes: storageRecord.index_bytes,
      combinedBytes: storageRecord.total_bytes,
    },
    plans: claimRecords.map((record) => ({ scenario: record.scenario, plan: structuredClone(record.plan.Plan) })),
    measurementRecords,
    productionQueryFingerprints: {
      claimSha256: claimRecords[0].querySha256,
      bulkUpsertSha256: bulkRecord.querySha256,
      cleanupSha256: cleanupRecord.querySha256,
    },
    results: { thresholdsPassed: true, structurePassed: true, canaryScanPassed: true, failedThresholds: [] },
  };
}

function postSampleFailureEvidenceFixture({ failureClass, failedCheck, childOutputSha256 }) {
  return {
    schemaVersion: 1,
    gate: "E3-PERF-01",
    attempt: "a1",
    implementationRevision: SHA40,
    disposition: "fail",
    failure: {
      class: failureClass,
      failedChecks: [failedCheck],
      childOutputSha256,
    },
    results: {
      thresholdsPassed: true,
      structurePassed: false,
      canaryScanPassed: true,
      failedThresholds: [],
    },
  };
}

function loadEvidenceRecordsFixture() {
  return [
    ...E3_PERF_01_CLAIM_SCENARIOS.map((scenario, index) => ({
      kind: "claim_scenario",
      scenario,
      querySha256: "7".repeat(64),
      actualAttemptIds: E3_PERF_01_EXPECTED_CLAIM_ROWS[scenario] === 0 ? [] :
        Array.from({ length: 256 }, (_, ordinal) => `${index}-${ordinal}`),
      samples: Array(30).fill(100 + index),
      p95Ms: 100 + index,
      maxMs: 100 + index,
      plan: { Plan: { "Node Type": "Index Scan", "Index Name": "jobs_claim_idx", "Actual Rows": E3_PERF_01_EXPECTED_CLAIM_ROWS[scenario] } },
      planSummary: { indexes: ["jobs_claim_idx", "job_attempts_lease_candidate_idx", "worker_lease_rejections_pkey"], actualRows: E3_PERF_01_EXPECTED_CLAIM_ROWS[scenario], rowsRemoved: 0, heapFetches: 0, sharedBlocks: 1, localBlocks: 0, tempBlocks: 0 },
    })),
    { kind: "bulk_upsert", querySha256: "8".repeat(64), affectedPerSample: Array(20).fill(256), samples: Array(20).fill(100), p95Ms: 100 },
    ...["sparse", "tail"].map((layout) => ({
      kind: "cleanup", layout, querySha256: "9".repeat(64), affectedPerSample: Array(20).fill(256),
      samples: Array(20).fill(100), p95Ms: 100,
      plan: { Plan: { "Node Type": "Index Scan", "Relation Name": "worker_lease_rejections", "Index Name": "worker_lease_rejections_cleanup_idx", "Actual Rows": 256 } },
      planSummary: { indexes: ["worker_lease_rejections_cleanup_idx"], actualRows: 256, rowsRemoved: 0, tempBlocks: 0, rootActualRows: 256, candidateRows: 256, affectedRows: 256 },
    })),
    { kind: "storage", candidate_rows: 1_000_000, certificate_rows: 1_000_000, joined_job_rows: 1_000_000, relation_bytes: 1, table_bytes: 1, index_bytes: 1, total_bytes: 2, indexes: [
      { index_name: "job_attempts_lease_candidate_idx", valid: true, ready: true, definition: "CREATE INDEX", predicate: "pending selected active placement_lease_eligible" },
      { index_name: "jobs_claim_idx", valid: true, ready: true, definition: "CREATE INDEX priority DESC", predicate: null },
      { index_name: "worker_lease_rejections_cleanup_idx", valid: true, ready: true, definition: "CREATE INDEX", predicate: null },
      { index_name: "worker_lease_rejections_pkey", valid: true, ready: true, definition: "CREATE UNIQUE INDEX", predicate: null },
    ] },
  ];
}

function makeHarness(overrides = {}) {
  const trace = [];
  const inputInventory = completeInputInventoryFixture();
  const git = {
    detached: true,
    head: GATE_SHA40,
    implementationAncestor: true,
    parents: [EVIDENCE_PARENT_SHA40],
    implementationTree: IMPLEMENTATION_TREE40,
    parentTree: TREE40,
    headTree: GATE_TREE40,
    manifestBlob: MANIFEST_BLOB40,
    manifestSha256: MANIFEST_SHA256,
    replaceRefs: [],
    staged: [],
    modified: [],
    untracked: [],
    unexpectedIgnored: [],
    parentToHeadDelta: [{ path: manifestFixture().manifestPath, status: "A", mode: "100644" }],
    implementationToParentDelta: structuredClone(manifestFixture().reviewedEvidence),
    inputInventory,
    blobs: Object.fromEntries(inputInventory.map((entry) => [entry.path, entry.blob])),
    workingBytesMatch: true,
  };
  const dependencies = {
    frozenInstallInventorySha256: "2".repeat(64),
    packageStoreIntegritySha256: "3".repeat(64),
    executableHashesMatch: true,
  };
  const environment = structuredClone(manifestFixture().environment);
  const phases = { samplesStarted: false, archiveBytesComplete: false, digestDerived: false };
  const uploads = [];
  const receipts = [];
  const passRecords = [];
  const failureRecords = [];
  const store = {
    uploads,
    receipts,
    passRecords,
    failureRecords,
    uploadError: null,
    receiptUriOverride: null,
    receiptSha256Override: null,
    receiptByteLengthOverride: null,
    receiptRetentionUntilOverride: null,
    receiptObjectLockModeOverride: null,
    async uploadArchive(record) {
      const captured = { ...record, bytes: Buffer.from(record.bytes) };
      uploads.push(captured);
      if (this.uploadError) throw this.uploadError;
      const receipt = {
        uri: this.receiptUriOverride ?? captured.uri,
        sha256: this.receiptSha256Override ?? createHash("sha256").update(captured.bytes).digest("hex"),
        byteLength: this.receiptByteLengthOverride ?? captured.bytes.length,
        retentionPolicy: {
          retainUntil: this.receiptRetentionUntilOverride ?? captured.retentionPolicy?.retainUntil,
          objectLockMode: this.receiptObjectLockModeOverride ?? captured.retentionPolicy?.objectLockMode,
        },
      };
      receipts.push(structuredClone(receipt));
      trace.push("upload:complete");
      return receipt;
    },
    async writePassRecord(record) {
      passRecords.push(structuredClone(record));
      trace.push("record:pass");
    },
    async writeFailureRecord(record) {
      failureRecords.push(structuredClone(record));
      trace.push("record:fail");
    },
  };
  const archive = {
    bytes: Buffer.alloc(0),
    scannedBytes: null,
    hashedBytes: null,
    manifest: [],
    scanPassed: true,
    acceptOnlyEmptyScan: false,
    hashCalls: 0,
    buildCalls: 0,
    injectAfterRedaction: null,
    async build(outputDirectory) {
      const files = await readAllFiles(outputDirectory);
      this.manifest = files.map((file) => ({
        path: file.path.slice(outputDirectory.length + 1).replaceAll("\\", "/"),
        type: "file",
        byteLength: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      })).sort((left, right) => left.path.localeCompare(right.path));
      this.bytes = buildTestArchiveBytes(files, outputDirectory);
      if (this.injectAfterRedaction !== null) {
        this.bytes = Buffer.concat([this.bytes, Buffer.from(this.injectAfterRedaction)]);
      }
      this.buildCalls += 1;
      phases.archiveBytesComplete = true;
      trace.push("archive:complete");
      return { bytes: Buffer.from(this.bytes), manifest: structuredClone(this.manifest) };
    },
    scanCanaries(bytes) {
      this.scannedBytes = Buffer.from(bytes);
      trace.push("archive:scan");
      if (this.acceptOnlyEmptyScan) return Buffer.isBuffer(bytes) && bytes.length === 0;
      return this.scanPassed && Buffer.isBuffer(bytes) &&
        (this.injectAfterRedaction === null || !bytes.includes(Buffer.from(this.injectAfterRedaction)));
    },
    sha256(bytes) {
      this.hashedBytes = Buffer.from(bytes);
      this.hashCalls += 1;
      trace.push("archive:digest");
      return createHash("sha256").update(bytes).digest("hex");
    },
  };
  const harness = {
    git,
    dependencies,
    provenance: {
      approved: true,
      signed: true,
      attestationValid: true,
      policyValid: true,
      trustRootValid: true,
      e6f06EvidenceValid: true,
      imageDigest: `sha256:${"8".repeat(64)}`,
    },
    environment,
    output: { exists: false, empty: true, reused: false },
    clock: { now: () => new Date(CAMPAIGN_NOW) },
    child: {
      invocations: 0,
      command: [],
      env: structuredClone(REVIEWED_BENCHMARK_ENVIRONMENT),
      argv: [],
      databaseUrl: "postgres://benchmark.invalid/aoa",
      stdout: loadEvidenceRecordsFixture().map((record) => JSON.stringify(record)).join("\n"),
      stderr: "",
      exitCode: 0,
      observeSpawnInput: null,
      async run(input) {
        this.invocations += 1;
        this.command = [...input.command];
        this.observeSpawnInput?.(input);
        trace.push("child:spawn");
        const result = { stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode };
        trace.push("child:exit");
        return result;
      },
    },
    redactor: { observeInput: null },
    files: [],
    console: { lines: [] },
    qaFixture: Buffer.from("E3-PERF-01 QA fixture: disposition pending artifact verification\n"),
    handoffFixture: Buffer.from("E3-PERF-01 handoff fixture: security review pending\n"),
    archive,
    store,
    phases,
    trace,
  };
  harness.postRun = {
    git: structuredClone(git),
    dependencies: structuredClone(dependencies),
    environment: structuredClone(environment),
    markVerified() { trace.push("post-attestation:complete"); },
  };
  return Object.assign(harness, overrides);
}

async function runGate(mod, manifest, outputDirectory, harness) {
  assert.equal(typeof mod.runE3Perf01, "function", "ordinary runE3Perf01 API must exist");
  return mod.runE3Perf01({ manifest, outputDirectory }, harness);
}

async function readAllFiles(root) {
  const paths = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of paths) {
    if (entry.isDirectory()) continue;
    assert.equal(entry.isSymbolicLink(), false, `evidence output contains a forbidden symlink: ${entry.name}`);
    assert.equal(entry.isFile(), true, `evidence output contains a forbidden special file: ${entry.name}`);
    const parent = entry.parentPath ?? entry.path ?? root;
    const path = join(parent, entry.name);
    files.push({ path, bytes: await readFile(path) });
  }
  return files;
}

function assertSafeArchivePath(path) {
  assert.equal(typeof path, "string");
  assert.ok(path.length > 0);
  assert.doesNotMatch(path, /[\\\0]/u);
  assert.doesNotMatch(path, /^(?:\/|[A-Za-z]:|\/\/)/u);
  const segments = path.split("/");
  assert.equal(segments.some((segment) => segment === "" || segment === "." || segment === ".."), false);
}

function buildTestArchiveBytes(files, root) {
  const entries = files.map((file) => ({
    path: file.path.slice(root.length + 1).replaceAll("\\", "/"),
    type: "file",
    bytesBase64: file.bytes.toString("base64"),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = entries.map((entry) => {
    const bytes = Buffer.from(entry.bytesBase64, "base64");
    return {
      path: entry.path,
      type: entry.type,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return encodeTestArchiveDocument({ format: "aoa-e3-perf-01-test-archive-v2", manifest, entries });
}

function decodeTestArchiveDocument(bytes) {
  assert.ok(Buffer.isBuffer(bytes), "archive bytes must be a Buffer");
  const document = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["entries", "format", "manifest"]);
  assert.equal(document.format, "aoa-e3-perf-01-test-archive-v2");
  assert.ok(Array.isArray(document.entries));
  assert.ok(Array.isArray(document.manifest));
  return document;
}

function encodeTestArchiveDocument(document) {
  return Buffer.from(JSON.stringify(document));
}

function assertTestArchivePayloadMatchesManifestIgnoringSafety({ bytes, manifest }) {
  const document = decodeTestArchiveDocument(bytes);
  assert.deepEqual(document.manifest, manifest, "external and embedded archive manifests must match");
  assert.equal(document.entries.length, manifest.length, "every archive entry must have one manifest row");
  for (const [index, entry] of document.entries.entries()) {
    const decoded = Buffer.from(entry.bytesBase64, "base64");
    assert.deepEqual(manifest[index], {
      path: entry.path,
      type: entry.type,
      byteLength: decoded.length,
      sha256: createHash("sha256").update(decoded).digest("hex"),
    });
  }
}

function readTestArchiveBytes(bytes) {
  const document = decodeTestArchiveDocument(bytes);
  const seen = new Set();
  const files = document.entries.map((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ["bytesBase64", "path", "type"]);
    assertSafeArchivePath(entry.path);
    assert.equal(entry.type, "file");
    assert.equal(seen.has(entry.path), false, `duplicate archive path: ${entry.path}`);
    seen.add(entry.path);
    assert.equal(typeof entry.bytesBase64, "string");
    return { path: entry.path, bytes: Buffer.from(entry.bytesBase64, "base64") };
  });
  const expectedManifest = files.map((file) => ({
    path: file.path,
    type: "file",
    byteLength: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  assert.deepEqual(document.manifest, expectedManifest, "archive manifest must bind every exact entry byte");
  return files;
}

function stringLeafPointers(value, path = [], found = []) {
  if (typeof value === "string") found.push(path);
  else if (Array.isArray(value)) value.forEach((entry, index) => stringLeafPointers(entry, [...path, index], found));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) stringLeafPointers(entry, [...path, key], found);
  }
  return found;
}

function setAtPointer(document, path, value) {
  let cursor = document;
  for (const segment of path.slice(0, -1)) cursor = cursor[segment];
  cursor[path.at(-1)] = value;
}

test("strict schemas close every object and pin revisions, provenance, thresholds, and evidence", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const Ajv2020 = loadPinnedServerAjv2020();
  const manifestSchema = JSON.parse(readFileSync(REQUIRED_ASSETS[1], "utf8"));
  const evidenceSchema = JSON.parse(readFileSync(REQUIRED_ASSETS[2], "utf8"));
  assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(manifestSchema));
  assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(evidenceSchema));
  assert.equal(mod.validateManifestDocument(manifestFixture()), true);
  assert.equal(mod.validateEvidenceDocument(evidenceFixture()), true);
  assert.equal(mod.validateEvidenceDocument(postSampleFailureEvidenceFixture({
    failureClass: "REQUIRED_STRUCTURE_MISS",
    failedCheck: "hot_sequential_scan",
    childOutputSha256: "0".repeat(64),
  })), true, "the closed evidence schema must retain non-secret post-sample failures");
  assert.ok(
    Date.parse(manifestFixture().output.retentionUntil) - Date.parse(CAMPAIGN_NOW) >= MINIMUM_RETENTION_MS,
    "passing manifest fixture must retain the immutable archive for at least 180 full days",
  );
  assert.deepEqual(manifestFixture().sourceInputs.map((entry) => entry.path), COMPLETE_PINNED_INPUT_PATHS);
  assert.deepEqual(
    manifestFixture().dependencyClosure.criticalInputs.map((entry) => entry.path),
    [...REQUIRED_PINNED_INPUT_PATHS],
  );
  assert.deepEqual(manifestFixture().dataset.shapes, E3_PERF_01_SHAPES);
  assert.deepEqual(manifestFixture().dataset.claimScenarios, E3_PERF_01_CLAIM_SCENARIOS);
  assert.deepEqual(evidenceFixture().samples.map((sample) => sample.scenario), E3_PERF_01_CLAIM_SCENARIOS);
  assert.deepEqual(
    evidenceFixture().samples.map((sample) => sample.actualRows),
    E3_PERF_01_CLAIM_SCENARIOS.map((scenario) => E3_PERF_01_EXPECTED_CLAIM_ROWS[scenario]),
  );

  for (const mutate of [
    (value) => { value.unknown = true; },
    (value) => { delete value.thresholds.bulkUpsertP95Ms; },
    (value) => { value.thresholds.shapesTwoThreeP95Ms = 251; },
    (value) => { value.owners.security.id = value.owners.integration.id; },
    (value) => { value.implementationRevision = "short"; },
    (value) => { value.reviewedEvidence[0].newBlob = "bad"; },
    (value) => { value.reviewedEvidence[0].sha256 = "A".repeat(64); },
    (value) => { value.containingCommit = SHA40; },
    (value) => { value.containingTree = TREE40; },
  ]) {
    const changed = structuredClone(manifestFixture());
    mutate(changed);
    assert.throws(() => mod.validateManifestDocument(changed));
  }
  const unknownEvidence = evidenceFixture();
  unknownEvidence.results.secret = "forbidden";
  assert.throws(() => mod.validateEvidenceDocument(unknownEvidence));
  const contradictoryEvidence = evidenceFixture();
  contradictoryEvidence.samples[0].milliseconds += 1;
  assert.throws(
    () => mod.validateEvidenceDocument(contradictoryEvidence),
    undefined,
    "closed evidence must reject a summary that disagrees with its raw measurement record",
  );

  const digestBindingCases = [
    {
      name: "runner image",
      mutate: (value) => { value.runnerImage.uri = `oci://registry.example.invalid/aoa/e6f06@sha256:${"0".repeat(64)}`; },
    },
    {
      name: "provenance attestation",
      mutate: (value) => { value.runnerImage.attestationUri = `https://evidence.example.invalid/attestations/sha256/${"0".repeat(64)}`; },
    },
    {
      name: "verification policy",
      mutate: (value) => { value.runnerImage.policyUri = `s3://aoa-evidence/policy/sha256/${"0".repeat(64)}`; },
    },
    {
      name: "trust root",
      mutate: (value) => { value.runnerImage.trustRootUri = `gs://aoa-trust/roots/sha256/${"0".repeat(64)}`; },
    },
    ...manifestFixture().referencedEvidence.map((_, index) => ({
      name: `referenced evidence ${index}`,
      mutate: (value) => {
        value.referencedEvidence[index].uri = `https://evidence.example.invalid/reviews/sha256/${"0".repeat(64)}`;
      },
    })),
  ];
  for (const item of digestBindingCases) {
    const changed = structuredClone(manifestFixture());
    item.mutate(changed);
    assert.throws(
      () => mod.validateManifestDocument(changed),
      undefined,
      `${item.name} URI digest must equal its companion digest`,
    );
  }
  const consistentlyRebound = structuredClone(manifestFixture());
  const reboundDigest = "d".repeat(64);
  consistentlyRebound.runnerImage.uri = `oci://registry.example.invalid/aoa/e6f06@sha256:${reboundDigest}`;
  consistentlyRebound.runnerImage.digest = `sha256:${reboundDigest}`;
  consistentlyRebound.runnerImage.attestationUri = `https://evidence.example.invalid/attestations/sha256/${reboundDigest}`;
  consistentlyRebound.runnerImage.attestationSha256 = reboundDigest;
  consistentlyRebound.runnerImage.policyUri = `s3://aoa-evidence/policy/sha256/${reboundDigest}`;
  consistentlyRebound.runnerImage.policySha256 = reboundDigest;
  consistentlyRebound.runnerImage.trustRootUri = `gs://aoa-trust/roots/sha256/${reboundDigest}`;
  consistentlyRebound.runnerImage.trustRootSha256 = reboundDigest;
  for (const [index, evidence] of consistentlyRebound.referencedEvidence.entries()) {
    const evidenceDigest = [reboundDigest, "c".repeat(64)][index];
    evidence.uri = `https://evidence.example.invalid/reviews/sha256/${evidenceDigest}`;
    evidence.sha256 = evidenceDigest;
  }
  assert.equal(
    mod.validateManifestDocument(consistentlyRebound),
    true,
    "content-addressed pairs may change prospectively only when URI and companion digest change together",
  );
});

test("real archive adapter rejects path escapes, non-regular files, duplicates, and byte/manifest drift", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const root = await mkdtemp(join(tmpdir(), "e3-perf-01-archive-"));
  try {
    const evidencePath = join(root, EVIDENCE_ARCHIVE_PATH);
    const evidenceBytes = Buffer.from(JSON.stringify(evidenceFixture()));
    await writeFile(evidencePath, evidenceBytes);
    const built = await mod.buildEvidenceArchive(root);
    assert.ok(Buffer.isBuffer(built.bytes) && built.bytes.length > 0);
    assert.deepEqual(built.manifest, [{
      path: EVIDENCE_ARCHIVE_PATH,
      type: "file",
      byteLength: evidenceBytes.length,
      sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    }]);
    assert.equal(mod.validateEvidenceArchive(built), true);

    const assertCodecRoundTrip = async (encoded, expectedEntries, label) => {
      assert.ok(Buffer.isBuffer(encoded.bytes) && encoded.bytes.length > 0, label);
      const expectedManifest = expectedEntries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        byteLength: entry.bytes.length,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      }));
      assert.deepEqual(encoded.manifest, expectedManifest, `${label}: encoder manifest`);
      const decoded = await mod.decodeEvidenceArchive(encoded.bytes);
      assert.deepEqual(decoded.manifest, expectedManifest, `${label}: decoded embedded manifest`);
      assert.deepEqual(
        decoded.entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
          bytes: Buffer.from(entry.bytes),
        })),
        expectedEntries,
        `${label}: decoded entry bytes`,
      );
    };
    await assertCodecRoundTrip(
      built,
      [{ path: EVIDENCE_ARCHIVE_PATH, type: "file", bytes: evidenceBytes }],
      "real builder",
    );

    const selfConsistentMaliciousArchives = [
      { name: "traversal", path: `../${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "backslash-traversal", path: `..\\${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "absolute-posix", path: `/${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "absolute-drive", path: `C:/${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "absolute-unc", path: `//server/share/${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "absolute-unc-backslash", path: `\\\\server\\share\\${EVIDENCE_ARCHIVE_PATH}`, type: "file" },
      { name: "symlink-entry", path: EVIDENCE_ARCHIVE_PATH, type: "symlink" },
      { name: "special-entry", path: EVIDENCE_ARCHIVE_PATH, type: "fifo" },
      {
        name: "duplicate-entry",
        path: EVIDENCE_ARCHIVE_PATH,
        type: "file",
        duplicate: true,
      },
    ];
    for (const item of selfConsistentMaliciousArchives) {
      const entry = { path: item.path, type: item.type, bytes: Buffer.from(evidenceBytes) };
      const entries = item.duplicate
        ? [entry, { path: entry.path, type: entry.type, bytes: Buffer.from(entry.bytes) }]
        : [entry];
      const changed = await mod.encodeEvidenceArchive(entries);
      await assertCodecRoundTrip(changed, entries, item.name);
      assert.equal(mod.validateEvidenceArchive(changed), false, item.name);
    }

    const digestMismatch = structuredClone(built.manifest);
    digestMismatch[0].sha256 = "0".repeat(64);
    assert.equal(mod.validateEvidenceArchive({
      bytes: Buffer.from(built.bytes),
      manifest: digestMismatch,
    }), false, "archive entry bytes cannot disagree with their supplied digest");

    const archiveManifestMismatch = structuredClone(built.manifest);
    archiveManifestMismatch[0].path = "different-evidence.json";
    assert.equal(mod.validateEvidenceArchive({
      bytes: Buffer.from(built.bytes),
      manifest: archiveManifestMismatch,
    }), false, "decoded archive manifest and supplied manifest cannot disagree");

    const tamperedBytes = Buffer.from(built.bytes);
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    assert.equal(
      mod.validateEvidenceArchive({ bytes: tamperedBytes, manifest: structuredClone(built.manifest) }),
      false,
      "archive bytes cannot drift from their reviewed manifest",
    );

    if (process.platform !== "win32") {
      const symlinkPath = join(root, "forbidden-symlink.json");
      await symlink(evidencePath, symlinkPath);
      await assert.rejects(mod.buildEvidenceArchive(root), undefined, "filesystem symlinks fail closed");
      await rm(symlinkPath, { force: true });
      const fifoPath = join(root, "forbidden-fifo");
      const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8", timeout: 5_000 });
      assert.equal(fifo.status, 0, fifo.stderr);
      const fifoProbe = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `const mod = await import(${JSON.stringify(REQUIRED_ASSETS[0].href)});` +
          `try { await mod.buildEvidenceArchive(${JSON.stringify(root)}); process.exitCode = 2; }` +
          "catch { process.exitCode = 0; }",
      ], { encoding: "utf8", timeout: 3_000 });
      assert.equal(
        fifoProbe.error,
        undefined,
        "filesystem FIFO detection must reject before the bounded child-process timeout",
      );
      assert.equal(
        fifoProbe.status,
        0,
        `filesystem FIFO must fail closed without reading it (${fifoProbe.stdout}${fifoProbe.stderr})`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input URIs are credentialless and digest-bound while output is prospective then content-addressed", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  for (const uri of [
    `https://evidence.example.invalid/item/sha256/${SHA256}`,
    `s3://bucket/item/sha256/${SHA256}`,
    `gs://bucket/item/sha256/${SHA256}`,
    `oci://registry.example.invalid/image@sha256:${SHA256}`,
  ]) assert.equal(mod.validateContentAddressedInputUri(uri), true);
  for (const uri of [
    "http://example.invalid/evidence",
    `https://user:password@example.invalid/sha256/${SHA256}`,
    `https://example.invalid/sha256/${SHA256}?signature=secret`,
    `https://example.invalid/sha256/${SHA256}#fragment`,
    "s3://bucket/latest",
    "oci://registry.example.invalid/image:latest",
    `file:///tmp/sha256/${SHA256}`,
  ]) assert.throws(() => mod.validateContentAddressedInputUri(uri));

  const namespace = `s3://aoa-e3-perf/e3-perf-01/${SHA40}/a1`;
  assert.equal(mod.validateProspectiveOutputNamespace(namespace, SHA40, "a1"), true);
  assert.equal(
    mod.deriveDigestAddressedOutputUri(namespace, SHA256),
    `${namespace}/sha256/${SHA256}`,
  );
  for (const invalid of [
    `${namespace}/sha256/${SHA256}`,
    `s3://aoa-e3-perf/e3-perf-01/${SHA40}/a2`,
    `s3://other/e3-perf-01/${SHA40}/a1`,
    `${namespace}?token=secret`,
  ]) assert.throws(() => mod.validateProspectiveOutputNamespace(invalid, SHA40, "a1"));
});

test("recursive canary and credential rejection never echoes the sensitive value", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  for (const path of stringLeafPointers(manifestFixture())) {
    const canary = `E3_CANARY_${path.join("_")}_do_not_echo`;
    const changed = structuredClone(manifestFixture());
    setAtPointer(changed, path, canary);
    let message = "";
    try { mod.validateManifestDocument(changed, { canaries: [canary] }); } catch (error) { message = String(error); }
    assert.ok(message.length > 0);
    assert.equal(message.includes(canary), false);

    const harness = makeHarness({ canaries: [canary] });
    let orchestrationMessage = "";
    try {
      await runGate(mod, changed, "unused", harness);
      assert.fail(`manifest canary at ${path.join(".")} must fail closed`);
    } catch (error) {
      orchestrationMessage = String(error);
    }
    assert.ok(orchestrationMessage.length > 0);
    assert.equal(orchestrationMessage.includes(canary), false);
    assert.equal(harness.child.invocations, 0);
    assert.equal(harness.store.passRecords.length, 0);
    assert.equal(harness.store.failureRecords.length, 0);
  }
  for (const credential of [
    "Authorization: Bearer E3_CREDENTIAL_DO_NOT_ECHO",
    "password=E3_CREDENTIAL_DO_NOT_ECHO",
    "AKIA1234567890ABCDEF",
  ]) {
    const changed = structuredClone(manifestFixture());
    changed.environment.cpuModel = credential;
    let message = "";
    try { mod.validateManifestDocument(changed); } catch (error) { message = String(error); }
    assert.ok(message.length > 0, "schema-valid nested credential patterns must fail recursive validation");
    assert.equal(message.includes(credential), false);

    const harness = makeHarness();
    let orchestrationMessage = "";
    try {
      await runGate(mod, changed, "unused", harness);
      assert.fail("nested credential patterns must fail before the load child");
    } catch (error) {
      orchestrationMessage = String(error);
    }
    assert.ok(orchestrationMessage.length > 0);
    assert.equal(orchestrationMessage.includes(credential), false);
    assert.equal(harness.child.invocations, 0);
    assert.equal(harness.store.passRecords.length, 0);
    assert.equal(harness.store.failureRecords.length, 0);
    assert.equal(harness.store.uploads.length, 0);
  }
  const uriCanary = "E3_CANARY_VALID_CONTENT_URI_DO_NOT_ECHO";
  const uriCanaryManifest = structuredClone(manifestFixture());
  uriCanaryManifest.referencedEvidence[0].uri =
    `https://evidence.example.invalid/${uriCanary}/sha256/${uriCanaryManifest.referencedEvidence[0].sha256}`;
  const Ajv2020 = loadPinnedServerAjv2020();
  const validateManifestSchema = new Ajv2020({ strict: true }).compile(
    JSON.parse(readFileSync(REQUIRED_ASSETS[1], "utf8")),
  );
  assert.equal(validateManifestSchema(uriCanaryManifest), true, "URI canary fixture must be schema-valid");
  assert.equal(mod.validateContentAddressedInputUri(uriCanaryManifest.referencedEvidence[0].uri), true);
  assert.throws(
    () => mod.validateManifestDocument(uriCanaryManifest, { canaries: [uriCanary] }),
    undefined,
    "schema-valid digest-bound URIs must still pass through the recursive canary scanner",
  );
  const uriCanaryHarness = makeHarness({ canaries: [uriCanary] });
  let uriCanaryMessage = "";
  try {
    await runGate(mod, uriCanaryManifest, "unused", uriCanaryHarness);
    assert.fail("schema-valid URI canary must fail before the load child");
  } catch (error) {
    uriCanaryMessage = String(error);
  }
  assert.equal(uriCanaryMessage.includes(uriCanary), false);
  assert.equal(uriCanaryHarness.child.invocations, 0);
  assert.equal(uriCanaryHarness.store.passRecords.length, 0);
  assert.equal(uriCanaryHarness.store.failureRecords.length, 0);
  assert.equal(uriCanaryHarness.store.uploads.length, 0);
});

test("full pre-sample provenance, Git, environment, manifest, URI, and output drift matrix fails closed", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const cases = [
    { name: "modified_manifest", harness: (h) => { h.git.modified = [manifestFixture().manifestPath]; } },
    { name: "untracked_manifest", harness: (h) => { h.git.untracked = [manifestFixture().manifestPath]; } },
    ...ATTESTED_DIRTY_PATHS.map((path) => ({ name: `dirty:${path}`, harness: (h) => { h.git.modified = [path]; } })),
    { name: "replacement_ref", harness: (h) => { h.git.replaceRefs = ["refs/replace/x"]; } },
    { name: "staged", harness: (h) => { h.git.staged = ["pnpm-lock.yaml"]; } },
    { name: "untracked", harness: (h) => { h.git.untracked = ["secret.txt"]; } },
    { name: "ignored", harness: (h) => { h.git.unexpectedIgnored = ["swapped-schema.json"]; } },
    { name: "install_inventory", harness: (h) => { h.dependencies.frozenInstallInventorySha256 = "0".repeat(64); } },
    { name: "package_store", harness: (h) => { h.dependencies.packageStoreIntegritySha256 = "0".repeat(64); } },
    { name: "executable_hash", harness: (h) => { h.dependencies.executableHashesMatch = false; } },
    { name: "not_detached", harness: (h) => { h.git.detached = false; } },
    { name: "wrong_gate_head", harness: (h) => { h.git.head = "0".repeat(40); } },
    { name: "wrong_gate_tree", harness: (h) => { h.git.headTree = "0".repeat(40); } },
    { name: "wrong_implementation_tree", harness: (h) => { h.git.implementationTree = "0".repeat(40); } },
    { name: "implementation_revision", manifest: (m) => { m.implementationRevision = "0".repeat(40); } },
    { name: "implementation_nonancestor", harness: (h) => { h.git.implementationAncestor = false; } },
    { name: "evidence_parent_revision", manifest: (m) => { m.evidenceParentRevision = "0".repeat(40); } },
    { name: "evidence_parent_tree", harness: (h) => { h.git.parentTree = "0".repeat(40); } },
    { name: "wrong_parent", harness: (h) => { h.git.parents = ["0".repeat(40)]; } },
    { name: "multiple_parent", harness: (h) => { h.git.parents.push("f".repeat(40)); } },
    { name: "manifest_blob", harness: (h) => { h.git.manifestBlob = "0".repeat(40); } },
    { name: "manifest_sha", harness: (h) => { h.git.manifestSha256 = "0".repeat(64); } },
    { name: "extra_gate_delta", harness: (h) => { h.git.parentToHeadDelta.push({ path: "extra.txt", status: "A", mode: "100644" }); } },
    { name: "wrong_gate_delta_path", harness: (h) => { h.git.parentToHeadDelta[0].path = "wrong-manifest.json"; } },
    { name: "wrong_gate_delta_status", harness: (h) => { h.git.parentToHeadDelta[0].status = "M"; } },
    { name: "wrong_gate_delta_mode", harness: (h) => { h.git.parentToHeadDelta[0].mode = "100755"; } },
    { name: "unlisted_evidence", harness: (h) => { h.git.implementationToParentDelta.push({ path: "extra.md", status: "A", mode: "100644" }); } },
    { name: "missing_reviewed_evidence", harness: (h) => { h.git.implementationToParentDelta = []; } },
    { name: "evidence_status", harness: (h) => { h.git.implementationToParentDelta[0].status = "A"; } },
    { name: "evidence_mode", harness: (h) => { h.git.implementationToParentDelta[0].mode = "100755"; } },
    { name: "evidence_old_blob", harness: (h) => { h.git.implementationToParentDelta[0].oldBlob = "0".repeat(40); } },
    { name: "evidence_new_blob", harness: (h) => { h.git.implementationToParentDelta[0].newBlob = "0".repeat(40); } },
    { name: "evidence_sha", harness: (h) => { h.git.implementationToParentDelta[0].sha256 = "0".repeat(64); } },
    { name: "review_blob", harness: (h) => { h.git.implementationToParentDelta[0].reviewEvidenceBlob = "0".repeat(40); } },
    { name: "missing_source_input", manifest: (m) => { m.sourceInputs = []; } },
    { name: "single_source_input_omission", manifest: (m) => { m.sourceInputs.splice(Math.floor(m.sourceInputs.length / 2), 1); } },
    { name: "source_input_addition", manifest: (m) => { m.sourceInputs.push(inputFact("unexpected/source.ts")); } },
    { name: "source_input_mode", manifest: (m) => { m.sourceInputs[0].mode = "100755"; } },
    { name: "source_input_blob", manifest: (m) => { m.sourceInputs[0].blob = "0".repeat(40); } },
    { name: "source_input_sha", manifest: (m) => { m.sourceInputs[0].sha256 = "0".repeat(64); } },
    { name: "actual_input_omission", harness: (h) => { h.git.inputInventory.splice(Math.floor(h.git.inputInventory.length / 2), 1); } },
    { name: "actual_input_addition", harness: (h) => { h.git.inputInventory.push(inputFact("unexpected/source.ts")); } },
    { name: "actual_input_mode", harness: (h) => { h.git.inputInventory[0].mode = "100755"; } },
    { name: "actual_input_blob", harness: (h) => { h.git.inputInventory[0].blob = "0".repeat(40); } },
    { name: "actual_input_sha", harness: (h) => { h.git.inputInventory[0].sha256 = "0".repeat(64); } },
    { name: "missing_critical_input", manifest: (m) => { m.dependencyClosure.criticalInputs = []; } },
    { name: "critical_input_addition", manifest: (m) => { m.dependencyClosure.criticalInputs.push(inputFact("unexpected/critical.ts")); } },
    { name: "critical_input_mode", manifest: (m) => { m.dependencyClosure.criticalInputs[0].mode = "100755"; } },
    { name: "critical_input_blob", manifest: (m) => { m.dependencyClosure.criticalInputs[0].blob = "0".repeat(40); } },
    { name: "critical_input_sha", manifest: (m) => { m.dependencyClosure.criticalInputs[0].sha256 = "0".repeat(64); } },
    { name: "pre_run_byte_mutation", harness: (h) => { h.git.workingBytesMatch = false; } },
    { name: "source_blob", harness: (h) => { h.git.blobs["server/src/services/job-leasing.ts"] = "0".repeat(40); } },
    ...Object.keys(manifestFixture().environment).map((field) => ({
      name: `environment:${field}`,
      harness: (h) => { h.environment[field] = typeof h.environment[field] === "number" ? h.environment[field] + 1 : "drift"; },
    })),
    { name: "nonempty_output", harness: (h) => { h.output.exists = true; h.output.empty = false; } },
    { name: "reused_output", harness: (h) => { h.output.reused = true; } },
    { name: "retention_under_180_full_days", manifest: (m) => {
      m.output.retentionUntil = new Date(Date.parse(CAMPAIGN_NOW) + MINIMUM_RETENTION_MS - 1).toISOString();
    } },
    { name: "threshold", manifest: (m) => { m.thresholds.cleanupP95Ms += 1; } },
    { name: "missing_integration_owner", manifest: (m) => { delete m.owners.integration; } },
    { name: "missing_security_owner", manifest: (m) => { delete m.owners.security; } },
    { name: "same_owner", manifest: (m) => { m.owners.security.id = m.owners.integration.id; } },
    { name: "missing_approval_time", manifest: (m) => { delete m.owners.security.approvedAt; } },
    { name: "self_commit", manifest: (m) => { m.containingCommit = SHA40; } },
    { name: "self_tree", manifest: (m) => { m.containingTree = TREE40; } },
    { name: "unapproved_image", harness: (h) => { h.provenance.approved = false; } },
    { name: "unsigned_image", harness: (h) => { h.provenance.signed = false; } },
    { name: "substituted_image", harness: (h) => { h.provenance.imageDigest = `sha256:${"0".repeat(64)}`; } },
    { name: "forged_attestation", harness: (h) => { h.provenance.attestationValid = false; } },
    { name: "policy", harness: (h) => { h.provenance.policyValid = false; } },
    { name: "trust_root", harness: (h) => { h.provenance.trustRootValid = false; } },
    { name: "e6f06", harness: (h) => { h.provenance.e6f06EvidenceValid = false; } },
  ];
  for (const [name, path] of [
    ["synchronized_forbidden_source_delta", "server/src/services/unreviewed-perf-change.ts"],
    ["synchronized_forbidden_wildcard_delta", "server/src"],
  ]) {
    const fact = reviewedEvidenceFact(path);
    cases.push({
      name,
      manifest: (m) => { m.reviewedEvidence.push(structuredClone(fact)); },
      harness: (h) => { h.git.implementationToParentDelta.push(structuredClone(fact)); },
    });
  }
  for (const path of [
    "server/src/services/job-leasing.ts", "vitest.config.ts", "pnpm-lock.yaml",
    "packages/db/src/schema/jobs.ts", "packages/db/src/migrations/0230_static_certificates.sql",
  ]) {
    cases.push({
      name: `intervening:${path}`,
      harness: (h) => { h.git.implementationToParentDelta.push({
        path, status: "M", mode: "100644", oldBlob: "1".repeat(40), newBlob: "2".repeat(40),
        sha256: "3".repeat(64), reviewEvidenceBlob: "4".repeat(40),
      }); },
    });
  }
  const uriMutations = [
    "https://user:password@example.invalid/sha256/" + SHA256,
    "https://example.invalid/sha256/" + SHA256 + "?X-Amz-Signature=secret",
    "https://example.invalid/sha256/" + SHA256 + "#fragment",
    "https://example.invalid/latest",
    "http://example.invalid/sha256/" + SHA256,
  ];
  for (const [field, path] of [
    ["image", ["runnerImage", "uri"]],
    ["attestation", ["runnerImage", "attestationUri"]],
    ["policy", ["runnerImage", "policyUri"]],
    ["trust-root", ["runnerImage", "trustRootUri"]],
    ...manifestFixture().referencedEvidence.map((_, index) => [
      `evidence-${index}`,
      ["referencedEvidence", index, "uri"],
    ]),
  ]) {
    for (const [index, uri] of uriMutations.entries()) {
      cases.push({ name: `${field}-uri-${index}`, manifest: (m) => setAtPointer(m, path, uri) });
    }
  }
  for (const item of [
    {
      name: "image-uri-companion-digest",
      manifest: (m) => { m.runnerImage.uri = `oci://registry.example.invalid/aoa/e6f06@sha256:${"0".repeat(64)}`; },
    },
    {
      name: "attestation-uri-companion-digest",
      manifest: (m) => { m.runnerImage.attestationUri = `https://evidence.example.invalid/attestations/sha256/${"0".repeat(64)}`; },
    },
    {
      name: "policy-uri-companion-digest",
      manifest: (m) => { m.runnerImage.policyUri = `s3://aoa-evidence/policy/sha256/${"0".repeat(64)}`; },
    },
    {
      name: "trust-root-uri-companion-digest",
      manifest: (m) => { m.runnerImage.trustRootUri = `gs://aoa-trust/roots/sha256/${"0".repeat(64)}`; },
    },
    ...manifestFixture().referencedEvidence.map((_, index) => ({
      name: `evidence-${index}-uri-companion-digest`,
      manifest: (m) => {
        m.referencedEvidence[index].uri = `https://evidence.example.invalid/reviews/sha256/${"0".repeat(64)}`;
      },
    })),
  ]) cases.push(item);
  cases.push(
    { name: "output-origin", manifest: (m) => { m.output.origin = "s3://other"; } },
    { name: "output-prefix", manifest: (m) => { m.output.namespace = `s3://other/e3-perf-01/${SHA40}/a1`; } },
    { name: "output-attempt", manifest: (m) => { m.output.namespace = `s3://aoa-e3-perf/e3-perf-01/${SHA40}/a2`; } },
    { name: "output-query", manifest: (m) => { m.output.namespace += "?token=secret"; } },
  );

  for (const item of cases) {
    const manifest = structuredClone(manifestFixture());
    const harness = makeHarness();
    item.manifest?.(manifest);
    item.harness?.(harness);
    if (item.name.startsWith("synchronized_forbidden_")) {
      assert.deepEqual(
        harness.git.implementationToParentDelta,
        manifest.reviewedEvidence,
        `${item.name} must not fail merely because the observed and declared deltas differ`,
      );
    }
    await assert.rejects(runGate(mod, manifest, "unused", harness), undefined, item.name);
    assert.equal(harness.child.invocations, 0, item.name);
    assert.equal(harness.store.passRecords.length, 0, item.name);
    assert.equal(harness.store.failureRecords.length, 0, item.name);
    assert.equal(harness.store.uploads.length, 0, item.name);
    assert.equal(harness.phases.samplesStarted, false, item.name);
  }
});

test("post-sample NDJSON, threshold, structure, mutation, and archive failures can never produce pass", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const replaceRecords = (harness, mutate) => {
    const records = loadEvidenceRecordsFixture();
    mutate(records);
    harness.child.stdout = records.map((record) => JSON.stringify(record)).join("\n");
  };
  const recordOf = (records, kind, discriminator) => records.find((record) =>
    record.kind === kind && (discriminator === undefined || record.scenario === discriminator || record.layout === discriminator));
  const setClaimP95 = (records, scenario, milliseconds) => {
    const record = recordOf(records, "claim_scenario", scenario);
    record.samples = Array(30).fill(milliseconds);
    record.p95Ms = milliseconds;
    record.maxMs = milliseconds;
  };
  const setClaimMax = (records, scenario, milliseconds) => {
    const record = recordOf(records, "claim_scenario", scenario);
    record.samples = [...Array(29).fill(100), milliseconds];
    record.p95Ms = 100;
    record.maxMs = milliseconds;
  };
  const setMutationP95 = (records, kind, discriminator, milliseconds) => {
    const record = recordOf(records, kind, discriminator);
    record.samples = Array(20).fill(milliseconds);
    record.p95Ms = milliseconds;
  };
  const cases = [
    { name: "child_nonzero", mutate: (h) => { h.child.exitCode = 1; } },
    { name: "non_json", mutate: (h) => { h.child.stdout = "not-json"; } },
    { name: "unknown_record", mutate: (h) => { const records = loadEvidenceRecordsFixture(); records.push({ kind: "unknown" }); h.child.stdout = records.map((record) => JSON.stringify(record)).join("\n"); } },
    { name: "missing_record", mutate: (h) => { const records = loadEvidenceRecordsFixture(); records.splice(2, 1); h.child.stdout = records.map((record) => JSON.stringify(record)).join("\n"); } },
    { name: "duplicate_record", mutate: (h) => { const records = loadEvidenceRecordsFixture(); records.splice(1, 0, structuredClone(records[0])); h.child.stdout = records.map((record) => JSON.stringify(record)).join("\n"); } },
    { name: "out_of_order", mutate: (h) => { const records = loadEvidenceRecordsFixture().reverse(); h.child.stdout = records.map((record) => JSON.stringify(record)).join("\n"); } },
    { name: "wrong_scenario", mutate: (h) => replaceRecords(h, (records) => { records[0].scenario = "not_a_reviewed_scenario"; }) },
    { name: "wrong_claim_result", mutate: (h) => replaceRecords(h, (records) => { records[1].actualAttemptIds[0] = "wrong-attempt"; }) },
    { name: "wrong_claim_order", mutate: (h) => replaceRecords(h, (records) => { records[1].actualAttemptIds.reverse(); }) },
    { name: "wrong_claim_count", mutate: (h) => replaceRecords(h, (records) => { records[1].actualAttemptIds.pop(); }) },
    { name: "wrong_candidate_row_cardinality", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").candidate_rows = 999_999; }) },
    { name: "wrong_certificate_row_cardinality", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").certificate_rows = 999_999; }) },
    { name: "wrong_joined_job_cardinality", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").joined_job_rows = 0; }) },
    {
      name: "threshold_miss",
      mutate: (h) => replaceRecords(h, (records) => setClaimP95(records, "ten_thousand_workers_by_one_hundred", 251)),
    },
    {
      name: "shape_two_p95_over_250",
      mutate: (h) => replaceRecords(h, (records) => setClaimP95(records, "ten_thousand_workers_by_one_hundred", 251)),
    },
    {
      name: "shape_three_p95_over_250",
      mutate: (h) => replaceRecords(h, (records) => setClaimP95(records, "ninety_percent_stale_version_or_context", 251)),
    },
    {
      name: "shape_two_max_over_1500",
      mutate: (h) => replaceRecords(h, (records) => setClaimMax(records, "ten_thousand_workers_by_one_hundred", 1_501)),
    },
    {
      name: "shape_three_max_over_1500",
      mutate: (h) => replaceRecords(h, (records) => setClaimMax(records, "ninety_percent_stale_version_or_context", 1_501)),
    },
    {
      name: "fully_certified_p95_over_2000",
      mutate: (h) => replaceRecords(h, (records) => setClaimP95(records, "hot_worker_fully_certified_no_work", 2_001)),
    },
    {
      name: "head_saturated_p95_over_2000",
      mutate: (h) => replaceRecords(h, (records) => setClaimP95(records, "hot_worker_head_saturated_999744_prefix", 2_001)),
    },
    {
      name: "fully_certified_max_over_5000",
      mutate: (h) => replaceRecords(h, (records) => setClaimMax(records, "hot_worker_fully_certified_no_work", 5_001)),
    },
    {
      name: "head_saturated_max_over_5000",
      mutate: (h) => replaceRecords(h, (records) => setClaimMax(records, "hot_worker_head_saturated_999744_prefix", 5_001)),
    },
    {
      name: "bulk_upsert_p95_over_500",
      mutate: (h) => replaceRecords(h, (records) => setMutationP95(records, "bulk_upsert", undefined, 501)),
    },
    {
      name: "sparse_cleanup_p95_over_750",
      mutate: (h) => replaceRecords(h, (records) => setMutationP95(records, "cleanup", "sparse", 751)),
    },
    {
      name: "tail_cleanup_p95_over_750",
      mutate: (h) => replaceRecords(h, (records) => setMutationP95(records, "cleanup", "tail", 751)),
    },
    { name: "claim_sample_count", mutate: (h) => replaceRecords(h, (records) => { records[2].samples.pop(); }) },
    { name: "bulk_sample_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "bulk_upsert").samples.pop(); }) },
    { name: "cleanup_sample_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "sparse").samples.pop(); }) },
    { name: "claim_max_drift", mutate: (h) => replaceRecords(h, (records) => { records[2].maxMs += 1; }) },
    { name: "claim_p95_drift", mutate: (h) => replaceRecords(h, (records) => { records[2].p95Ms += 1; }) },
    { name: "bulk_p95_drift", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "bulk_upsert").p95Ms += 1; }) },
    { name: "cleanup_p95_drift", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "tail").p95Ms += 1; }) },
    { name: "hot_sequential_scan", mutate: (h) => replaceRecords(h, (records) => { records[0].plan = { Plan: { "Node Type": "Seq Scan", "Relation Name": "jobs", "Actual Rows": 1 } }; }) },
    { name: "spilled_sort", mutate: (h) => replaceRecords(h, (records) => { records[0].plan = { Plan: { "Node Type": "Sort", "Sort Method": "external merge", "Actual Rows": 256, "Temp Read Blocks": 1, "Temp Written Blocks": 1 } }; }) },
    { name: "unbounded_sort", mutate: (h) => replaceRecords(h, (records) => { records[0].plan = { Plan: { "Node Type": "Sort", "Sort Method": "quicksort", "Actual Rows": 257 } }; }) },
    { name: "missing_plan_cardinality", mutate: (h) => replaceRecords(h, (records) => { delete records[0].planSummary.actualRows; }) },
    { name: "missing_plan_buffers", mutate: (h) => replaceRecords(h, (records) => { delete records[0].planSummary.sharedBlocks; }) },
    { name: "missing_plan_removed_rows", mutate: (h) => replaceRecords(h, (records) => { delete records[0].planSummary.rowsRemoved; }) },
    { name: "missing_plan_actual_rows", mutate: (h) => replaceRecords(h, (records) => { delete records[0].plan.Plan["Actual Rows"]; }) },
    { name: "missing_required_index", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").indexes.splice(1, 1); }) },
    { name: "invalid_required_index", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").indexes[0].valid = false; }) },
    { name: "unready_required_index", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").indexes[0].ready = false; }) },
    { name: "wrong_candidate_index_predicate", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").indexes[0].predicate = "status = 'pending'"; }) },
    { name: "wrong_claim_index_direction", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "storage").indexes[1].definition = "CREATE INDEX priority ASC"; }) },
    { name: "claim_plan_missing_index", mutate: (h) => replaceRecords(h, (records) => { records[0].planSummary.indexes = ["jobs_claim_idx"]; }) },
    { name: "forged_combined_storage_total", mutate: (h) => replaceRecords(h, (records) => {
      recordOf(records, "storage").total_bytes += 1;
    }) },
    { name: "combined_storage_over_2gib", mutate: (h) => replaceRecords(h, (records) => {
      const storage = recordOf(records, "storage");
      storage.table_bytes = 1024 * 1024 * 1024 + 1;
      storage.index_bytes = 1024 * 1024 * 1024;
      storage.total_bytes = storage.table_bytes + storage.index_bytes;
    }) },
    { name: "bulk_affected_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "bulk_upsert").affectedPerSample[0] = 255; }) },
    { name: "bulk_affected_sample_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "bulk_upsert").affectedPerSample.pop(); }) },
    { name: "sparse_cleanup_affected_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "sparse").affectedPerSample[0] = 255; }) },
    { name: "tail_cleanup_affected_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "tail").affectedPerSample[0] = 257; }) },
    { name: "cleanup_affected_sample_count", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "tail").affectedPerSample.pop(); }) },
    { name: "sparse_cleanup_missing_plan", mutate: (h) => replaceRecords(h, (records) => { delete recordOf(records, "cleanup", "sparse").plan; }) },
    { name: "tail_cleanup_sequential_scan", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "tail").plan = { Plan: { "Node Type": "Seq Scan", "Relation Name": "worker_lease_rejections", "Actual Rows": 256 } }; }) },
    { name: "cleanup_missing_buffers", mutate: (h) => replaceRecords(h, (records) => { delete recordOf(records, "cleanup", "sparse").planSummary.tempBlocks; }) },
    { name: "cleanup_missing_root_cardinality", mutate: (h) => replaceRecords(h, (records) => { delete recordOf(records, "cleanup", "sparse").planSummary.rootActualRows; }) },
    { name: "cleanup_missing_candidate_cardinality", mutate: (h) => replaceRecords(h, (records) => { delete recordOf(records, "cleanup", "sparse").planSummary.candidateRows; }) },
    { name: "cleanup_missing_affected_cardinality", mutate: (h) => replaceRecords(h, (records) => { delete recordOf(records, "cleanup", "sparse").planSummary.affectedRows; }) },
    { name: "claim_query_fingerprint", mutate: (h) => replaceRecords(h, (records) => { records[0].querySha256 = "0".repeat(64); }) },
    { name: "bulk_query_fingerprint", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "bulk_upsert").querySha256 = "0".repeat(64); }) },
    { name: "sparse_cleanup_query_fingerprint", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "sparse").querySha256 = "0".repeat(64); }) },
    { name: "tail_cleanup_query_fingerprint", mutate: (h) => replaceRecords(h, (records) => { recordOf(records, "cleanup", "tail").querySha256 = "0".repeat(64); }) },
    { name: "post_run_mutation", mutate: (h) => { h.postRun.git.workingBytesMatch = false; } },
    { name: "archive_canary", mutate: (h) => { h.archive.injectAfterRedaction = "ARCHIVE_CANARY_DO_NOT_PERSIST"; } },
    {
      name: "empty_scan_cannot_authorize_contaminated_archive",
      mutate: (h) => {
        h.archive.injectAfterRedaction = "ARCHIVE_CANARY_DO_NOT_PERSIST";
        h.archive.acceptOnlyEmptyScan = true;
      },
    },
    {
      name: "upload_error",
      publicationFailure: true,
      mutate: (h) => { h.store.uploadError = new Error("test-owned upload failure"); },
    },
  ];
  const receiptMismatches = [
    {
      name: "uri_mismatch",
      mutate: (h) => { h.store.receiptUriOverride = "s3://aoa-e3-perf/wrong/sha256/" + "0".repeat(64); },
      assertMismatch: (receipt, upload) => assert.notEqual(receipt.uri, upload.uri),
    },
    {
      name: "digest_mismatch",
      mutate: (h) => { h.store.receiptSha256Override = "0".repeat(64); },
      assertMismatch: (receipt, upload) => assert.notEqual(receipt.sha256, upload.sha256),
    },
    {
      name: "byte_length_mismatch",
      mutate: (h) => { h.store.receiptByteLengthOverride = 0; },
      assertMismatch: (receipt, upload) => assert.notEqual(receipt.byteLength, upload.bytes.length),
    },
    {
      name: "retention_under_180_days",
      mutate: (h) => {
        h.store.receiptRetentionUntilOverride = new Date(
          Date.parse(CAMPAIGN_NOW) + MINIMUM_RETENTION_MS - 1,
        ).toISOString();
      },
      assertMismatch: (receipt, upload) =>
        assert.notEqual(receipt.retentionPolicy.retainUntil, upload.retentionPolicy.retainUntil),
    },
    {
      name: "without_compliance_object_lock",
      mutate: (h) => { h.store.receiptObjectLockModeOverride = "none"; },
      assertMismatch: (receipt, upload) =>
        assert.notEqual(receipt.retentionPolicy.objectLockMode, upload.retentionPolicy.objectLockMode),
    },
  ];
  const receiptOutcomes = [
    { name: "pass", mutate: () => {}, evidenceKind: "pass" },
    {
      name: "threshold_failure",
      evidenceKind: "threshold",
      failedThreshold: "shapesTwoThreeP95Ms:ten_thousand_workers_by_one_hundred",
      mutate: (h) => replaceRecords(h, (records) =>
        setClaimP95(records, "ten_thousand_workers_by_one_hundred", 251)),
    },
    {
      name: "structural_failure",
      evidenceKind: "structural",
      failureClass: "REQUIRED_STRUCTURE_MISS",
      failedCheck: "tail_cleanup_sequential_scan",
      mutate: (h) => replaceRecords(h, (records) => {
        recordOf(records, "cleanup", "tail").plan = {
          Plan: { "Node Type": "Seq Scan", "Relation Name": "worker_lease_rejections", "Actual Rows": 256 },
        };
      }),
    },
  ];
  for (const mismatch of receiptMismatches) {
    for (const outcome of receiptOutcomes) {
      cases.push({
        name: `upload_receipt_${mismatch.name}_${outcome.name}`,
        publicationFailure: true,
        receiptMismatch: true,
        receiptOutcome: outcome,
        assertReceiptMismatch: mismatch.assertMismatch,
        mutate: (h) => {
          outcome.mutate(h);
          mismatch.mutate(h);
        },
      });
    }
  }
  cases.push(
    { name: "post_not_detached", mutate: (h) => { h.postRun.git.detached = false; } },
    { name: "post_wrong_gate_head", mutate: (h) => { h.postRun.git.head = "0".repeat(40); } },
    { name: "post_implementation_nonancestor", mutate: (h) => { h.postRun.git.implementationAncestor = false; } },
    { name: "post_wrong_parent", mutate: (h) => { h.postRun.git.parents = ["0".repeat(40)]; } },
    { name: "post_multiple_parent", mutate: (h) => { h.postRun.git.parents.push("f".repeat(40)); } },
    { name: "post_wrong_parent_tree", mutate: (h) => { h.postRun.git.parentTree = "0".repeat(40); } },
    { name: "post_wrong_gate_tree", mutate: (h) => { h.postRun.git.headTree = "0".repeat(40); } },
    { name: "post_wrong_implementation_tree", mutate: (h) => { h.postRun.git.implementationTree = "0".repeat(40); } },
    { name: "post_manifest_blob", mutate: (h) => { h.postRun.git.manifestBlob = "0".repeat(40); } },
    { name: "post_manifest_sha", mutate: (h) => { h.postRun.git.manifestSha256 = "0".repeat(64); } },
    { name: "post_replacement_ref", mutate: (h) => { h.postRun.git.replaceRefs = ["refs/replace/x"]; } },
    { name: "post_staged", mutate: (h) => { h.postRun.git.staged = ["pnpm-lock.yaml"]; } },
    ...ATTESTED_DIRTY_PATHS.map((path) => ({
      name: `post_dirty:${path}`,
      mutate: (h) => { h.postRun.git.modified = [path]; },
    })),
    { name: "post_untracked", mutate: (h) => { h.postRun.git.untracked = ["secret.txt"]; } },
    { name: "post_ignored", mutate: (h) => { h.postRun.git.unexpectedIgnored = ["swapped-schema.json"]; } },
    {
      name: "post_extra_gate_delta",
      mutate: (h) => { h.postRun.git.parentToHeadDelta.push({ path: "extra.txt", status: "A", mode: "100644" }); },
    },
    { name: "post_gate_delta_path", mutate: (h) => { h.postRun.git.parentToHeadDelta[0].path = "wrong-manifest.json"; } },
    { name: "post_gate_delta_status", mutate: (h) => { h.postRun.git.parentToHeadDelta[0].status = "M"; } },
    { name: "post_gate_delta_mode", mutate: (h) => { h.postRun.git.parentToHeadDelta[0].mode = "100755"; } },
    {
      name: "post_unlisted_evidence",
      mutate: (h) => { h.postRun.git.implementationToParentDelta.push({ path: "extra.md", status: "A", mode: "100644" }); },
    },
    { name: "post_missing_reviewed_evidence", mutate: (h) => { h.postRun.git.implementationToParentDelta = []; } },
    { name: "post_evidence_status", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].status = "A"; } },
    { name: "post_evidence_mode", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].mode = "100755"; } },
    { name: "post_evidence_old_blob", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].oldBlob = "0".repeat(40); } },
    { name: "post_evidence_new_blob", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].newBlob = "0".repeat(40); } },
    { name: "post_evidence_sha", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].sha256 = "0".repeat(64); } },
    { name: "post_review_blob", mutate: (h) => { h.postRun.git.implementationToParentDelta[0].reviewEvidenceBlob = "0".repeat(40); } },
    { name: "post_input_omission", mutate: (h) => { h.postRun.git.inputInventory.splice(Math.floor(h.postRun.git.inputInventory.length / 2), 1); } },
    { name: "post_input_addition", mutate: (h) => { h.postRun.git.inputInventory.push(inputFact("unexpected/source.ts")); } },
    { name: "post_input_mode", mutate: (h) => { h.postRun.git.inputInventory[0].mode = "100755"; } },
    { name: "post_input_blob", mutate: (h) => { h.postRun.git.inputInventory[0].blob = "0".repeat(40); } },
    { name: "post_input_sha", mutate: (h) => { h.postRun.git.inputInventory[0].sha256 = "0".repeat(64); } },
    { name: "post_source_blob", mutate: (h) => { h.postRun.git.blobs["server/src/services/job-leasing.ts"] = "0".repeat(40); } },
    { name: "post_install_inventory", mutate: (h) => { h.postRun.dependencies.frozenInstallInventorySha256 = "0".repeat(64); } },
    { name: "post_package_store", mutate: (h) => { h.postRun.dependencies.packageStoreIntegritySha256 = "0".repeat(64); } },
    { name: "post_executable_hash", mutate: (h) => { h.postRun.dependencies.executableHashesMatch = false; } },
    ...Object.keys(manifestFixture().environment).map((field) => ({
      name: `post_environment:${field}`,
      mutate: (h) => {
        h.postRun.environment[field] = typeof h.postRun.environment[field] === "number"
          ? h.postRun.environment[field] + 1
          : "drift";
      },
    })),
  );
  const retainedThresholdFailures = new Map([
    ["threshold_miss", "shapesTwoThreeP95Ms:ten_thousand_workers_by_one_hundred"],
    ["shape_two_p95_over_250", "shapesTwoThreeP95Ms:ten_thousand_workers_by_one_hundred"],
    ["shape_three_p95_over_250", "shapesTwoThreeP95Ms:ninety_percent_stale_version_or_context"],
    ["shape_two_max_over_1500", "shapesTwoThreeMaxMs:ten_thousand_workers_by_one_hundred"],
    ["shape_three_max_over_1500", "shapesTwoThreeMaxMs:ninety_percent_stale_version_or_context"],
    ["fully_certified_p95_over_2000", "saturatedP95Ms:hot_worker_fully_certified_no_work"],
    ["head_saturated_p95_over_2000", "saturatedP95Ms:hot_worker_head_saturated_999744_prefix"],
    ["fully_certified_max_over_5000", "saturatedMaxMs:hot_worker_fully_certified_no_work"],
    ["head_saturated_max_over_5000", "saturatedMaxMs:hot_worker_head_saturated_999744_prefix"],
    ["bulk_upsert_p95_over_500", "bulkUpsertP95Ms"],
    ["sparse_cleanup_p95_over_750", "cleanupP95Ms:sparse"],
    ["tail_cleanup_p95_over_750", "cleanupP95Ms:tail"],
  ]);
  const unsafeOrUntrustedPostSampleFailures = new Set([
    "non_json",
    "unknown_record",
    "archive_canary",
    "empty_scan_cannot_authorize_contaminated_archive",
  ]);
  const evidenceContractFailures = new Set([
    "missing_record",
    "duplicate_record",
    "out_of_order",
    "wrong_scenario",
  ]);
  for (const item of cases) {
    const outputDirectory = await mkdtemp(join(tmpdir(), "e3-perf-01-post-"));
    try {
      const harness = makeHarness();
      item.mutate(harness);
      await assert.rejects(runGate(mod, manifestFixture(), outputDirectory, harness), undefined, item.name);
      assert.equal(harness.child.invocations, 1, item.name);
      assert.equal(harness.phases.samplesStarted, true, item.name);
      assert.equal(harness.store.passRecords.length, 0, item.name);
      if (retainedThresholdFailures.has(item.name)) {
        const failedThreshold = retainedThresholdFailures.get(item.name);
        assert.equal(harness.phases.digestDerived, true, item.name);
        assert.equal(harness.store.uploads.length, 1, item.name);
        const [upload] = harness.store.uploads;
        assert.deepEqual(upload.retentionPolicy, {
          retainUntil: manifestFixture().output.retentionUntil,
          objectLockMode: OBJECT_LOCK_MODE,
        }, `${item.name} upload request must apply the manifest retention/object-lock policy`);
        assert.deepEqual(harness.store.receipts, [{
          uri: upload.uri,
          sha256: createHash("sha256").update(upload.bytes).digest("hex"),
          byteLength: upload.bytes.length,
          retentionPolicy: upload.retentionPolicy,
        }], `${item.name} must verify the immutable store receipt policy`);
        assert.deepEqual(harness.archive.scannedBytes, upload.bytes, `${item.name} must scan the exact uploaded bytes`);
        assert.deepEqual(harness.archive.hashedBytes, upload.bytes, `${item.name} must hash the exact uploaded bytes`);
        const actualArchiveSha256 = createHash("sha256").update(upload.bytes).digest("hex");
        const archivedFiles = readTestArchiveBytes(upload.bytes);
        assert.deepEqual(archivedFiles.map((file) => file.path), [EVIDENCE_ARCHIVE_PATH], item.name);
        const disk = await readAllFiles(outputDirectory);
        assert.deepEqual(
          disk.map((file) => file.path.slice(outputDirectory.length + 1).replaceAll("\\", "/")),
          [EVIDENCE_ARCHIVE_PATH],
          item.name,
        );
        assert.deepEqual(archivedFiles[0].bytes, disk[0].bytes, `${item.name} failure archive must round-trip exact evidence bytes`);
        const failureDocument = JSON.parse(archivedFiles[0].bytes.toString("utf8"));
        assert.equal(mod.validateEvidenceDocument(failureDocument), true, item.name);
        const measuredRecords = harness.child.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        const expectedFailureDocument = evidenceFixture(measuredRecords);
        expectedFailureDocument.results = {
          thresholdsPassed: false,
          structurePassed: true,
          canaryScanPassed: true,
          failedThresholds: [failedThreshold],
        };
        assert.deepEqual(failureDocument, expectedFailureDocument, `${item.name} must retain the actual failing samples and outcome`);
        assert.equal(upload.sha256, actualArchiveSha256, item.name);
        assert.equal(upload.uri, `${manifestFixture().output.namespace}/sha256/${actualArchiveSha256}`, item.name);
        assert.deepEqual(harness.store.failureRecords, [{
          schemaVersion: 1,
          gate: "E3-PERF-01",
          disposition: "fail",
          failureClass: "INITIAL_THRESHOLD_MISS",
          failedThresholds: [failedThreshold],
          attempt: "a1",
          implementationRevision: SHA40,
          implementationTree: IMPLEMENTATION_TREE40,
          gateRevision: GATE_SHA40,
          gateTree: GATE_TREE40,
          archive: {
            uri: upload.uri,
            sha256: actualArchiveSha256,
            retentionUntil: "2027-02-08T00:00:00.000Z",
            objectLockMode: OBJECT_LOCK_MODE,
          },
        }], item.name);
        assert.deepEqual(harness.trace, [
          "child:spawn",
          "child:exit",
          "post-attestation:complete",
          "archive:complete",
          "archive:scan",
          "archive:digest",
          "upload:complete",
          "record:fail",
        ], item.name);
      } else if (
        !item.publicationFailure &&
        !unsafeOrUntrustedPostSampleFailures.has(item.name) &&
        !item.name.startsWith("post_")
      ) {
        const failureClass = item.name === "child_nonzero"
          ? "LOAD_CHILD_FAILURE"
          : evidenceContractFailures.has(item.name)
            ? "LOAD_EVIDENCE_CONTRACT_FAILURE"
            : "REQUIRED_STRUCTURE_MISS";
        const childOutputSha256 = createHash("sha256")
          .update(`${harness.child.stdout}\n${harness.child.stderr}`)
          .digest("hex");
        assert.equal(harness.phases.digestDerived, true, item.name);
        assert.equal(harness.store.uploads.length, 1, item.name);
        const [upload] = harness.store.uploads;
        assert.deepEqual(upload.retentionPolicy, {
          retainUntil: manifestFixture().output.retentionUntil,
          objectLockMode: OBJECT_LOCK_MODE,
        }, item.name);
        assert.deepEqual(harness.archive.scannedBytes, upload.bytes, item.name);
        assert.deepEqual(harness.archive.hashedBytes, upload.bytes, item.name);
        const archiveSha256 = createHash("sha256").update(upload.bytes).digest("hex");
        assert.deepEqual(harness.store.receipts, [{
          uri: upload.uri,
          sha256: archiveSha256,
          byteLength: upload.bytes.length,
          retentionPolicy: upload.retentionPolicy,
        }], `${item.name} must verify the immutable receipt before recording the safe failure`);
        const archivedFiles = readTestArchiveBytes(upload.bytes);
        assert.deepEqual(archivedFiles.map((file) => file.path), [EVIDENCE_ARCHIVE_PATH], item.name);
        const failureDocument = JSON.parse(archivedFiles[0].bytes.toString("utf8"));
        const expectedFailureDocument = postSampleFailureEvidenceFixture({
          failureClass,
          failedCheck: item.name,
          childOutputSha256,
        });
        assert.equal(mod.validateEvidenceDocument(failureDocument), true, item.name);
        assert.deepEqual(failureDocument, expectedFailureDocument, item.name);
        assert.deepEqual(harness.store.failureRecords, [{
          schemaVersion: 1,
          gate: "E3-PERF-01",
          disposition: "fail",
          failureClass,
          failedChecks: [item.name],
          childOutputSha256,
          attempt: "a1",
          implementationRevision: SHA40,
          implementationTree: IMPLEMENTATION_TREE40,
          gateRevision: GATE_SHA40,
          gateTree: GATE_TREE40,
          archive: {
            uri: `${manifestFixture().output.namespace}/sha256/${archiveSha256}`,
            sha256: archiveSha256,
            retentionUntil: manifestFixture().output.retentionUntil,
            objectLockMode: OBJECT_LOCK_MODE,
          },
        }], item.name);
        assert.equal(harness.store.passRecords.length, 0, item.name);
        assert.deepEqual(harness.trace.slice(-6), [
          "post-attestation:complete",
          "archive:complete",
          "archive:scan",
          "archive:digest",
          "upload:complete",
          "record:fail",
        ], item.name);
      } else if (item.publicationFailure) {
        assert.equal(harness.phases.digestDerived, true, item.name);
        assert.equal(harness.store.uploads.length, 1, item.name);
        const [upload] = harness.store.uploads;
        assert.deepEqual(upload.retentionPolicy, {
          retainUntil: manifestFixture().output.retentionUntil,
          objectLockMode: OBJECT_LOCK_MODE,
        }, `${item.name} must not omit the prospective immutable retention policy`);
        assert.deepEqual(harness.archive.scannedBytes, upload.bytes, item.name);
        assert.deepEqual(harness.archive.hashedBytes, upload.bytes, item.name);
        assertTestArchivePayloadMatchesManifestIgnoringSafety({
          bytes: upload.bytes,
          manifest: harness.archive.manifest,
        });
        const archivedFiles = readTestArchiveBytes(upload.bytes);
        assert.deepEqual(archivedFiles.map((file) => file.path), [EVIDENCE_ARCHIVE_PATH], item.name);
        const retainedDocument = JSON.parse(archivedFiles[0].bytes.toString("utf8"));
        assert.equal(mod.validateEvidenceDocument(retainedDocument), true, item.name);
        if (item.receiptMismatch) {
          assert.equal(harness.store.receipts.length, 1, item.name);
          item.assertReceiptMismatch(harness.store.receipts[0], upload);
          const measuredRecords = harness.child.stdout
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          let expectedDocument;
          if (item.receiptOutcome.evidenceKind === "pass") {
            expectedDocument = evidenceFixture(measuredRecords);
          } else if (item.receiptOutcome.evidenceKind === "threshold") {
            expectedDocument = evidenceFixture(measuredRecords);
            expectedDocument.results = {
              thresholdsPassed: false,
              structurePassed: true,
              canaryScanPassed: true,
              failedThresholds: [item.receiptOutcome.failedThreshold],
            };
          } else {
            const childOutputSha256 = createHash("sha256")
              .update(`${harness.child.stdout}\n${harness.child.stderr}`)
              .digest("hex");
            expectedDocument = postSampleFailureEvidenceFixture({
              failureClass: item.receiptOutcome.failureClass,
              failedCheck: item.receiptOutcome.failedCheck,
              childOutputSha256,
            });
          }
          assert.deepEqual(
            retainedDocument,
            expectedDocument,
            `${item.name} must retain the schema-valid pass/failure evidence even though publication is unverified`,
          );
        } else {
          assert.equal(harness.store.receipts.length, 0, item.name);
        }
        assert.equal(harness.store.failureRecords.length, 0, item.name);
        assert.equal(harness.trace.includes("record:pass"), false, item.name);
        assert.equal(harness.trace.includes("record:fail"), false, item.name);
        assert.equal(harness.trace.at(-1), item.name === "upload_error" ? "archive:digest" : "upload:complete", item.name);
      } else {
        assert.ok(
          unsafeOrUntrustedPostSampleFailures.has(item.name) || item.name.startsWith("post_"),
          `${item.name} may omit immutable failure evidence only when bytes/provenance are unsafe`,
        );
        assert.equal(harness.store.uploads.length, 0, item.name);
        assert.equal(harness.store.failureRecords.length, 0, item.name);
        assert.equal(harness.phases.digestDerived, false, item.name);
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
});

test("real ingress canaries reach env/DB/argv/stdout/stderr but reach no console, file, archive, QA, or handoff byte", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const canaries = {
    environment: "E3_ENV_CANARY_DO_NOT_PERSIST",
    databaseUsername: "E3_DB_USER_CANARY_DO_NOT_PERSIST",
    databasePassword: "E3_DB_PASSWORD_CANARY_DO_NOT_PERSIST",
    databaseUrl: "E3_DB_URL_CANARY_DO_NOT_PERSIST",
    argv: "E3_ARGV_CANARY_DO_NOT_PERSIST",
    stdout: "E3_STDOUT_CANARY_DO_NOT_PERSIST",
    stderr: "E3_STDERR_CANARY_DO_NOT_PERSIST",
  };
  const outputDirectory = await mkdtemp(join(tmpdir(), "e3-perf-01-canary-"));
  try {
    const harness = makeHarness();
    const spawnInputs = [];
    const redactorInputs = [];
    harness.child.observeSpawnInput = (input) => { spawnInputs.push(structuredClone(input)); };
    harness.redactor.observeInput = (channel, value) => { redactorInputs.push({ channel, value }); };
    harness.child.env.UNRELATED_CANARY = canaries.environment;
    harness.child.databaseUrl = `postgres://${canaries.databaseUsername}:${canaries.databasePassword}` +
      `@db.example.invalid/${canaries.databaseUrl}`;
    harness.child.argv = ["--canary", canaries.argv];
    harness.child.stdout = `${canaries.stdout}\n${JSON.stringify(evidenceFixture())}`;
    harness.child.stderr = canaries.stderr;
    let failureMessage = "";
    try {
      await runGate(mod, manifestFixture(), outputDirectory, harness);
      assert.fail("real ingress canaries must fail closed");
    } catch (error) {
      failureMessage = String(error);
    }
    harness.qaFixture = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      gate: "E3-PERF-01",
      attempt: "a1",
      disposition: "fail",
      summary: failureMessage,
    })}\n`);
    harness.handoffFixture = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      gate: "E3-PERF-01",
      reviewedDisposition: "fail",
      qaSha256: createHash("sha256").update(harness.qaFixture).digest("hex"),
    })}\n`);
    assert.equal(spawnInputs.length, 1, "the child-spawn seam must observe the actual launch input once");
    const [spawn] = spawnInputs;
    assert.deepEqual(spawn.command, E3_PERF_01_CHILD_COMMAND);
    assert.deepEqual(spawn.env, {
      ...REVIEWED_BENCHMARK_ENVIRONMENT,
      UNRELATED_CANARY: canaries.environment,
      AOA_RUN_E3_PERF_01: "1",
      AOA_E3_PERF_DATABASE_URL: harness.child.databaseUrl,
    });
    assert.ok(spawn.env.AOA_E3_PERF_DATABASE_URL.includes(canaries.databaseUsername));
    assert.ok(spawn.env.AOA_E3_PERF_DATABASE_URL.includes(canaries.databasePassword));
    assert.ok(spawn.env.AOA_E3_PERF_DATABASE_URL.includes(canaries.databaseUrl));
    assert.deepEqual(spawn.argv, ["--canary", canaries.argv]);
    assert.deepEqual(redactorInputs.map((entry) => entry.channel), ["command", "stdout", "stderr"]);
    const renderedCommand = redactorInputs.find((entry) => entry.channel === "command")?.value;
    assert.equal(typeof renderedCommand, "string");
    assert.ok(renderedCommand.includes(E3_PERF_01_CHILD_COMMAND.join(" ")));
    assert.ok(renderedCommand.includes(canaries.argv));
    assert.ok(redactorInputs.find((entry) => entry.channel === "stdout")?.value.includes(canaries.stdout));
    assert.ok(redactorInputs.find((entry) => entry.channel === "stderr")?.value.includes(canaries.stderr));
    assert.ok(Buffer.byteLength(harness.qaFixture) > 0, "QA fixture bytes must be real/nonempty");
    assert.ok(Buffer.byteLength(harness.handoffFixture) > 0, "handoff fixture bytes must be real/nonempty");
    const disk = existsSync(outputDirectory) ? await readAllFiles(outputDirectory) : [];
    const permanentBytes = Buffer.concat([
      ...disk.map((file) => file.bytes),
      Buffer.from(harness.console.lines.join("\n")),
      Buffer.from(harness.archive.bytes),
      Buffer.from(harness.qaFixture ?? ""),
      Buffer.from(harness.handoffFixture ?? ""),
    ]);
    for (const canary of Object.values(canaries)) {
      assert.equal(failureMessage.includes(canary), false);
      assert.equal(permanentBytes.includes(Buffer.from(canary)), false);
    }
    assert.equal(harness.store.passRecords.length, 0);
    assert.equal(harness.store.failureRecords.length, 0);
    assert.equal(harness.store.uploads.length, 0);
    assert.equal(harness.phases.digestDerived, false);
    assert.equal(harness.archive.hashCalls, 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("closed evidence and real output archive gate one digest-addressed success", { skip: !assetsPresent }, async () => {
  const mod = await runner();
  const outputDirectory = await mkdtemp(join(tmpdir(), "e3-perf-01-success-"));
  try {
    const manifest = manifestFixture();
    manifest.output.retentionUntil = new Date(
      Date.parse(CAMPAIGN_NOW) + MINIMUM_RETENTION_MS,
    ).toISOString();
    const harness = makeHarness();
    const spawnInputs = [];
    harness.child.observeSpawnInput = (input) => { spawnInputs.push(structuredClone(input)); };
    const result = await runGate(mod, manifest, outputDirectory, harness);
    assert.equal(harness.child.invocations, 1);
    assert.deepEqual(harness.child.command, E3_PERF_01_CHILD_COMMAND);
    assert.deepEqual(spawnInputs, [{
      command: E3_PERF_01_CHILD_COMMAND,
      env: {
        ...REVIEWED_BENCHMARK_ENVIRONMENT,
        AOA_RUN_E3_PERF_01: "1",
        AOA_E3_PERF_DATABASE_URL: "postgres://benchmark.invalid/aoa",
      },
      argv: [],
    }]);
    const disk = await readAllFiles(outputDirectory);
    const diskManifest = disk.map((file) => file.path.slice(outputDirectory.length + 1).replaceAll("\\", "/")).sort();
    assert.deepEqual(diskManifest, [EVIDENCE_ARCHIVE_PATH], "success must produce the exact nonempty closed evidence artifact");
    const evidenceDocument = JSON.parse(disk[0].bytes.toString("utf8"));
    assert.equal(mod.validateEvidenceDocument(evidenceDocument), true);
    assert.deepEqual(evidenceDocument, evidenceFixture());
    assert.equal(harness.archive.buildCalls, 1);
    const archivedFiles = readTestArchiveBytes(harness.archive.bytes);
    assert.deepEqual(archivedFiles.map((file) => file.path), diskManifest);
    for (const archived of archivedFiles) {
      const file = disk.find((candidate) => candidate.path.endsWith(archived.path));
      assert.ok(file, archived.path);
      assert.deepEqual(archived.bytes, file.bytes, `${archived.path} archive bytes must round-trip exactly`);
    }
    const expectedArchiveSha256 = createHash("sha256").update(harness.archive.bytes).digest("hex");
    const expectedArchiveUri = `${manifest.output.namespace}/sha256/${expectedArchiveSha256}`;
    assert.equal(result.archiveSha256, expectedArchiveSha256);
    assert.equal(result.archiveUri, expectedArchiveUri);
    assert.equal(harness.phases.archiveBytesComplete, true);
    assert.equal(harness.phases.digestDerived, true);
    assert.equal(harness.archive.hashCalls, 1);
    assert.deepEqual(harness.archive.scannedBytes, harness.archive.bytes,
      "the binary canary scan must inspect the completed archive bytes");
    assert.deepEqual(harness.archive.hashedBytes, harness.archive.bytes,
      "the digest must be computed from the exact scanned archive bytes");
    assert.equal(
      createHash("sha256").update(harness.archive.bytes).digest("hex"),
      expectedArchiveSha256,
      "the published digest must be calculated from the completed archive bytes",
    );
    assert.equal(harness.postRun.git.workingBytesMatch, true);
    assert.deepEqual(harness.archive.manifest.map((entry) => entry.path).sort(), diskManifest);
    for (const entry of harness.archive.manifest) {
      const file = disk.find((candidate) => candidate.path.endsWith(entry.path));
      assert.ok(file, entry.path);
      assert.equal(createHash("sha256").update(file.bytes).digest("hex"), entry.sha256);
    }
    assert.deepEqual(harness.store.uploads, [{
      uri: expectedArchiveUri,
      sha256: expectedArchiveSha256,
      bytes: harness.archive.bytes,
      retentionPolicy: {
        retainUntil: manifest.output.retentionUntil,
        objectLockMode: OBJECT_LOCK_MODE,
      },
    }]);
    assert.deepEqual(harness.store.receipts, [{
      uri: expectedArchiveUri,
      sha256: expectedArchiveSha256,
      byteLength: harness.archive.bytes.length,
      retentionPolicy: {
        retainUntil: manifest.output.retentionUntil,
        objectLockMode: OBJECT_LOCK_MODE,
      },
    }]);
    const runnerInput = inputFact("scripts/run-e3-perf-01.mjs");
    assert.deepEqual(harness.store.passRecords, [{
      schemaVersion: 1,
      gate: "E3-PERF-01",
      disposition: "pass",
      attempt: "a1",
      implementationRevision: SHA40,
      implementationTree: IMPLEMENTATION_TREE40,
      evidenceParentRevision: EVIDENCE_PARENT_SHA40,
      evidenceParentTree: TREE40,
      gateRevision: GATE_SHA40,
      gateTree: GATE_TREE40,
      manifest: {
        path: manifest.manifestPath,
        blob: MANIFEST_BLOB40,
        sha256: MANIFEST_SHA256,
      },
      expandedCommand: E3_PERF_01_CHILD_COMMAND,
      runner: {
        path: "scripts/run-e3-perf-01.mjs",
        blob: runnerInput.blob,
        sha256: runnerInput.sha256,
      },
      verifiedInputs: {
        sourceInputs: manifest.sourceInputs,
        dependencyClosure: manifest.dependencyClosure,
      },
      runnerImage: manifest.runnerImage,
      pinnedConfiguration: {
        environment: manifest.environment,
        dataset: manifest.dataset,
        thresholds: manifest.thresholds,
        structuralRequirements: manifest.structuralRequirements,
        productionQueryFingerprints: manifest.productionQueryFingerprints,
      },
      outcomes: {
        thresholdsPassed: true,
        structurePassed: true,
        canaryScanPassed: true,
        failedThresholds: [],
      },
      implementationToParentDelta: manifest.reviewedEvidence,
      parentToGateDelta: [{ path: manifest.manifestPath, status: "A", mode: "100644" }],
      archive: {
        uri: expectedArchiveUri,
        sha256: expectedArchiveSha256,
        retentionUntil: manifest.output.retentionUntil,
        objectLockMode: OBJECT_LOCK_MODE,
      },
    }]);
    assert.equal(harness.store.failureRecords.length, 0);
    assert.deepEqual(harness.trace, [
      "child:spawn",
      "child:exit",
      "post-attestation:complete",
      "archive:complete",
      "archive:scan",
      "archive:digest",
      "upload:complete",
      "record:pass",
    ]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("runner contract source and both schemas contain no secret-bearing open escape hatch", { skip: !assetsPresent }, () => {
  const manifestSchema = JSON.parse(readFileSync(REQUIRED_ASSETS[1], "utf8"));
  const evidenceSchema = JSON.parse(readFileSync(REQUIRED_ASSETS[2], "utf8"));
  const assertClosed = (schema) => {
    if (schema && typeof schema === "object") {
      if (schema.type === "object") assert.equal(schema.additionalProperties, false);
      for (const value of Object.values(schema)) assertClosed(value);
    }
  };
  assertClosed(manifestSchema);
  assertClosed(evidenceSchema);
  const evidenceText = JSON.stringify(evidenceSchema);
  for (const forbidden of ["environmentVariables", "databaseUrl", "username", "password", "token", "authorization", "rawStdout", "rawStderr", "argv", "hostname", "homePath", "tempPath"]) {
    assert.equal(evidenceText.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("sealed campaign command owns production capabilities and exposes only the four hermetic capability groups", { skip: !assetsPresent }, async () => {
  // Mutation caught: retaining the always-fail launcher, or selecting injected facts through
  // argv/env/manifest/dynamic module input, prevents a real campaign from being attestable.
  const runner = await import("./run-e3-perf-01.mjs");
  assert.equal(typeof runner.runCampaignCommand, "function",
    "runCampaignCommand(argv, capabilities) must be the hermetic executable boundary");
  if (typeof runner.runCampaignCommand !== "function") return;

  const fixture = sealedCampaignCommandFixture();
  assert.deepEqual(Object.keys(fixture.capabilities).sort(), ["artifact", "clock", "process", "store"]);
  const outcome = await captureCommandOutcome(() => runner.runCampaignCommand([
    "--manifest", fixture.paths.manifest,
    "--output", fixture.paths.output,
  ], fixture.capabilities));
  assert.equal(outcome.error, undefined, "a complete four-capability campaign must execute");
  assert.equal(outcome.value?.disposition, "pass");
  assert.equal(outcome.value?.archiveSha256, fixture.state.archiveSha256);
  assert.equal(outcome.value?.objectVersion, "version-a1");
  assert.deepEqual(fixture.state.storeTrace.map(({ operation }) => operation), ["put", "head", "get", "retention"]);
  const uploadedVersion = {
    objectUri: fixture.state.objectUri,
    versionId: "version-a1",
  };
  assert.deepEqual(fixture.state.storeTrace.slice(1).map(({ input }) => input), [
    uploadedVersion, uploadedVersion, uploadedVersion,
  ], "readback and retention must remain pinned to the uploaded immutable version");
  assert.equal(fixture.state.localRetains, 1, "the exact local attempt remains after immutable upload");
  assert.deepEqual(fixture.state.exclusiveWrites.map((entry) => entry.path), [fixture.paths.qa]);
  assert.ok(fixture.state.processRuns.some((entry) => entry.executable === fixture.paths.git));
  assert.ok(fixture.state.processRuns.some((entry) => entry.executable === fixture.paths.provenance));
  const child = fixture.state.processRuns.find((entry) => entry.executable === fixture.paths.node &&
    entry.argv[0] === fixture.paths.loadRunner);
  assert.ok(child, "the absolute pinned Node must execute the absolute pinned load runner");
  assert.equal(child.shell, false);
  assert.deepEqual(child.env, {
    LANG: "C", LC_ALL: "C", TZ: "UTC",
    TMPDIR: fixture.paths.temp,
    AOA_E3_PERF_DATABASE_URL_FILE: fixture.paths.databaseUrlFile,
  });
  assert.equal(Object.hasOwn(child.env, "PATH"), false);

  for (const missing of ["process", "artifact", "store", "clock"]) {
    const candidate = { ...fixture.capabilities };
    delete candidate[missing];
    const rejected = await captureCommandOutcome(() => runner.runCampaignCommand([
      "--manifest", fixture.paths.manifest, "--output", fixture.paths.output,
    ], candidate));
    assert.equal(rejected.error?.code ?? rejected.value?.failureCode, "campaign_capabilities", missing);
  }
  const withExtra = { ...fixture.capabilities, network: Object.freeze({}) };
  const extraRejected = await captureCommandOutcome(() => runner.runCampaignCommand([
    "--manifest", fixture.paths.manifest, "--output", fixture.paths.output,
  ], withExtra));
  assert.equal(extraRejected.error?.code ?? extraRejected.value?.failureCode, "campaign_capabilities");
  const source = readFileSync(REQUIRED_ASSETS[0], "utf8");
  assert.match(source, /createProductionCampaignCapabilities/);
  assert.match(source, /runCampaignCommand\(process\.argv\.slice\(2\),\s*createProductionCampaignCapabilities\(\)\)/);
  assert.doesNotMatch(source, /(?:--fake|test[-_]?mode|fake[-_]?module|capabilit(?:y|ies)[-_]?path)/iu);

  const fakeMode = spawnSync(process.execPath, [
    fileURLToPath(REQUIRED_ASSETS[0]), "--fake", "./attacker.mjs",
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 });
  assert.equal(fakeMode.error, undefined);
  assert.notEqual(fakeMode.status, 0);
  assert.doesNotMatch(`${fakeMode.stdout}${fakeMode.stderr}`, /attacker\.mjs|ERR_MODULE_NOT_FOUND/iu);
});

test("sealed campaign command fails closed across bootstrap, provenance, child, archive, and immutable-store tampering", { skip: !assetsPresent }, async () => {
  // Mutations caught: a command that trusts a bootstrap/manifest fact, skips immutable
  // readback/retention, or drops failed-attempt evidence can otherwise return a false pass.
  const runner = await import("./run-e3-perf-01.mjs");
  assert.equal(typeof runner.runCampaignCommand, "function");
  if (typeof runner.runCampaignCommand !== "function") return;

  const executablePins = [
    ["git", "gitExecutable", "gitSha256", "git"],
    ["node", "nodeExecutable", "nodeSha256", "node"],
    ["pnpm", "pnpmExecutable", "pnpmSha256", "pnpm"],
    ["container", "containerRuntimeExecutable", "containerRuntimeSha256", "container"],
    ["provenance", "provenanceVerifierExecutable", "provenanceVerifierSha256", "provenance"],
  ];
  const executableCases = executablePins.flatMap(([name, pathField, digestField, pathKey]) => [
    [`${name}_relative`, "bootstrap_executable_path", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest[pathField] = `./${name}`;
    })],
    [`${name}_path_lookup`, "bootstrap_executable_path", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest[pathField] = name;
    })],
    [`${name}_manifest_digest`, "bootstrap_executable_digest", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest[digestField] = "0".repeat(64);
    })],
    [`${name}_bytes`, "bootstrap_executable_digest", (fixture) => {
      fixture.state.files.set(fixture.paths[pathKey], Buffer.from(`substituted-${name}`));
    }],
  ]);
  const cases = [
    ...executableCases,
    ["runner_relative", "bootstrap_runner_path", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest.loadRunnerPath = "./job-leasing-load.integration.test.ts";
    })],
    ["runner_path_lookup", "bootstrap_runner_path", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest.loadRunnerPath = "job-leasing-load.integration.test.ts";
    })],
    ["runner_manifest_digest", "bootstrap_runner_digest", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest.loadRunnerSha256 = "0".repeat(64);
    })],
    ["runner_bytes", "bootstrap_runner_digest", (fixture) => {
      fixture.state.files.set(fixture.paths.loadRunner, Buffer.from("substituted-runner"));
    }],
    ["dirty_git", "campaign_git_dirty", (fixture) => { fixture.state.gitDirty = true; }],
    ["attached_git", "campaign_git_detached", (fixture) => { fixture.state.gitAttached = true; }],
    ["replace_ref", "campaign_git_replace", (fixture) => { fixture.state.gitReplace = true; }],
    ["provenance", "campaign_provenance", (fixture) => { fixture.state.provenanceValid = false; }],
    ["argv_widening", "campaign_child_argv", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest.argv = [...manifest.argv, "--unreviewed"];
    })],
    ["environment_widening", "campaign_child_environment", (fixture) => fixture.rewriteManifest((manifest) => {
      manifest.childEnvironment.PATH = "C:/attacker";
    })],
    ["ndjson_line_cap", "campaign_ndjson_line_bytes", (fixture) => {
      fixture.state.childStdout = `${"x".repeat(1_048_577)}\n`;
    }],
    ["ndjson_canary", "campaign_redaction", (fixture) => {
      fixture.state.childStdout = `${JSON.stringify({ token: "E3_SECRET_CANARY" })}\n`;
    }],
    ["archive_mutation", "campaign_archive_readback", (fixture) => { fixture.state.mutateReadback = true; }],
    ["immutable_upload_failure", "campaign_store_upload", (fixture) => { fixture.state.putFails = true; }],
    ["checksum", "campaign_store_checksum", (fixture) => { fixture.state.wrongChecksum = true; }],
    ["version", "campaign_store_version", (fixture) => { fixture.state.missingVersion = true; }],
    ["retention_absent", "campaign_store_retention", (fixture) => { fixture.state.retention = null; }],
    ["retention_governance", "campaign_store_retention", (fixture) => {
      fixture.state.retention = { mode: "GOVERNANCE", retainUntil: "2027-02-08T00:00:00.000Z" };
    }],
    ["retention_short", "campaign_store_retention", (fixture) => {
      fixture.state.retention = { mode: "COMPLIANCE", retainUntil: "2026-08-12T00:00:00.000Z" };
    }],
    ["backend_loss", "campaign_store_readback", (fixture) => { fixture.state.backendLost = true; }],
    ["qa_collision", "campaign_qa_exclusive", (fixture) => { fixture.state.existingWrites.add(fixture.paths.qa); }],
  ];
  for (const [name, expectedCode, mutate] of cases) {
    const fixture = sealedCampaignCommandFixture();
    mutate(fixture);
    const outcome = await captureCommandOutcome(() => runner.runCampaignCommand([
      "--manifest", fixture.paths.manifest,
      "--output", fixture.paths.output,
    ], fixture.capabilities));
    assert.equal(outcome.error?.code ?? outcome.value?.failureCode, expectedCode, name);
    assert.equal(fixture.state.exclusiveWrites.some((entry) => entry.path === fixture.paths.qa), false, name);
    assert.equal(fixture.state.localRetains >= 1, true, `${name} must retain sanitized local failure evidence`);
  }

  const forbiddenParentEnvironment = [
    "NODE_OPTIONS", "NODE_PATH", "PATH", "GIT_CONFIG", "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM", "GIT_SSH_COMMAND", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ENDPOINT_URL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];
  for (const key of forbiddenParentEnvironment) {
    const fixture = sealedCampaignCommandFixture();
    fixture.state.parentEnvironment[key] = key === "PATH" ? "C:/attacker" : "attacker-value";
    const outcome = await captureCommandOutcome(() => runner.runCampaignCommand([
      "--manifest", fixture.paths.manifest, "--output", fixture.paths.output,
    ], fixture.capabilities));
    assert.equal(outcome.error?.code ?? outcome.value?.failureCode, "bootstrap_parent_environment", key);
    assert.equal(fixture.state.processRuns.length, 0, `${key} must fail before Git, verifier, or load child`);
  }
});

test("the formal PowerShell entry validates absolute pinned bytes before the real JavaScript entry", {
  skip: process.platform !== "win32" || !assetsPresent,
}, async () => {
  // Mutation caught: moving the trust root into JavaScript, consulting PATH, or accepting an
  // ambient preload/credential/proxy lets attacker code run before the campaign can fail closed.
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assert.equal(existsSync(powershell), true, "the exact Windows RED lane requires Windows PowerShell");
  const root = await mkdtemp(join(tmpdir(), "e3-perf-01-formal-entry-"));
  const runnerPath = fileURLToPath(REQUIRED_ASSETS[0]);
  const checkoutPath = fileURLToPath(new URL("..", import.meta.url));
  const nodeBytes = await readFile(process.execPath);
  const runnerBytes = await readFile(runnerPath);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  let caseNumber = 0;

  const runEntry = async ({ mutateBootstrap, mutateFiles, environment = {} } = {}) => {
    const caseRoot = join(root, `case-${caseNumber += 1}`);
    const outputDirectory = join(caseRoot, "output");
    const tempDirectory = join(caseRoot, "temp");
    const manifestPath = join(caseRoot, "manifest.json");
    const databaseUrlFile = join(caseRoot, "database-url");
    const bootstrapPath = join(caseRoot, "bootstrap.json");
    const scriptPath = join(caseRoot, "bootstrap.ps1");
    const copiedRunner = join(caseRoot, "run-e3-perf-01.mjs");
    const copiedNode = join(caseRoot, "node.exe");
    const preloadMarker = join(caseRoot, "preload-marker.txt");
    const preloadPath = join(caseRoot, "preload.cjs");
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(tempDirectory, { recursive: true });
    await writeFile(manifestPath, "{}\n", "utf8");
    await writeFile(databaseUrlFile, "postgres://test-only.invalid/aoa\n", "utf8");
    await writeFile(copiedRunner, runnerBytes);
    await writeFile(copiedNode, nodeBytes);
    await writeFile(preloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded")\n`, "utf8");
    const bootstrap = {
      schemaVersion: 1,
      checkoutPath,
      runnerScriptPath: runnerPath,
      runnerScriptSha256: sha256(runnerBytes),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      outputDirectory,
      nodeExecutable: process.execPath,
      nodeSha256: sha256(nodeBytes),
      parentEnvironment: {
        LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: tempDirectory,
        AOA_E3_PERF_DATABASE_URL_FILE: databaseUrlFile,
      },
    };
    mutateBootstrap?.(bootstrap, { copiedNode, copiedRunner, manifestPath });
    await writeFile(bootstrapPath, JSON.stringify(bootstrap), "utf8");
    await mutateFiles?.({ copiedNode, copiedRunner, manifestPath, bootstrapPath });
    const quote = (value) => value.replaceAll("'", "''");
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$bootstrapPath = '${quote(bootstrapPath)}'
$bootstrap = Get-Content -Raw -LiteralPath $bootstrapPath | ConvertFrom-Json
if ($bootstrap.schemaVersion -ne 1) { throw 'invalid E3-PERF-01 bootstrap schema' }
$allowedBootstrapKeys = @('schemaVersion','checkoutPath','runnerScriptPath','runnerScriptSha256','manifestPath','manifestSha256','outputDirectory','nodeExecutable','nodeSha256','parentEnvironment')
$actualBootstrapKeys = @($bootstrap.PSObject.Properties.Name | Sort-Object) -join ','
$expectedBootstrapKeys = @($allowedBootstrapKeys | Sort-Object) -join ','
if ($actualBootstrapKeys -ne $expectedBootstrapKeys) { throw 'invalid E3-PERF-01 bootstrap fields' }
$safeEnvironmentKeys = @('LANG','LC_ALL','TZ','TMPDIR','AOA_E3_PERF_DATABASE_URL_FILE')
$actualEnvironmentKeys = @($bootstrap.parentEnvironment.PSObject.Properties.Name | Sort-Object) -join ','
$expectedEnvironmentKeys = @($safeEnvironmentKeys | Sort-Object) -join ','
if ($actualEnvironmentKeys -ne $expectedEnvironmentKeys) { throw 'invalid E3-PERF-01 parent environment' }
if ($bootstrap.parentEnvironment.LANG -ne 'C' -or $bootstrap.parentEnvironment.LC_ALL -ne 'C' -or $bootstrap.parentEnvironment.TZ -ne 'UTC') { throw 'invalid E3-PERF-01 locale environment' }
$forbiddenExact = @('PATH','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_PROFILE','AWS_CA_BUNDLE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO')
$forbiddenPresent = @(Get-ChildItem Env: | Where-Object { $_.Name -in $forbiddenExact -or $_.Name -like 'GIT_*' -or $_.Name -like 'AWS_ENDPOINT_URL*' })
if ($forbiddenPresent.Count -ne 0) { throw 'forbidden E3-PERF-01 parent environment' }
function Test-FullyQualified([string]$path) {
  $modern = [IO.Path].GetMethods() | Where-Object { $_.Name -eq 'IsPathFullyQualified' } | Select-Object -First 1
  if ($null -ne $modern) { return [IO.Path]::IsPathFullyQualified($path) }
  return [IO.Path]::IsPathRooted($path) -and ([IO.Path]::GetFullPath($path) -ceq $path)
}
foreach ($path in @($bootstrap.checkoutPath,$bootstrap.runnerScriptPath,$bootstrap.manifestPath,$bootstrap.outputDirectory,$bootstrap.nodeExecutable,$bootstrap.parentEnvironment.TMPDIR,$bootstrap.parentEnvironment.AOA_E3_PERF_DATABASE_URL_FILE)) { if (-not (Test-FullyQualified $path)) { throw 'E3-PERF-01 requires absolute paths' } }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.nodeExecutable).Hash.ToLowerInvariant() -ne $bootstrap.nodeSha256) { throw 'E3-PERF-01 Node digest mismatch' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.runnerScriptPath).Hash.ToLowerInvariant() -ne $bootstrap.runnerScriptSha256) { throw 'E3-PERF-01 runner digest mismatch' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.manifestPath).Hash.ToLowerInvariant() -ne $bootstrap.manifestSha256) { throw 'E3-PERF-01 manifest digest mismatch' }
$windowsSystemRoot = $env:SystemRoot
Get-ChildItem Env: | Remove-Item
foreach ($property in $bootstrap.parentEnvironment.PSObject.Properties) { Set-Item -LiteralPath ("Env:{0}" -f $property.Name) -Value ([string]$property.Value) }
$postClearKeys = @((Get-ChildItem Env:).Name | Sort-Object) -join ','
if ($postClearKeys -ne (@($safeEnvironmentKeys | Sort-Object) -join ',')) { throw 'E3-PERF-01 environment clear failed' }
Set-Location -LiteralPath $bootstrap.checkoutPath
# Node on the Windows RED host needs SystemRoot only to initialize its native CSPRNG. The
# production pinned Linux gate does not take this compatibility branch; the hermetic command
# test separately proves that the campaign child receives exactly the five reviewed values.
if ($null -ne $windowsSystemRoot) { Set-Item -LiteralPath Env:SystemRoot -Value $windowsSystemRoot }
& $bootstrap.nodeExecutable $bootstrap.runnerScriptPath --manifest $bootstrap.manifestPath --output $bootstrap.outputDirectory
exit $LASTEXITCODE
`;
    await writeFile(scriptPath, script, "utf8");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    // Windows PowerShell reconstructs a registry PATH when the process environment omits it;
    // remove that host-added value before entering the verbatim protected-image gate.
    const powerShellArgs = Object.hasOwn(environment, "PATH")
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `Remove-Item Env:PATH -ErrorAction SilentlyContinue; & '${quote(scriptPath)}'`];
    const result = spawnSync(powershell, powerShellArgs, {
      cwd: caseRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        SystemRoot: systemRoot, WINDIR: systemRoot,
        TEMP: process.env.TEMP ?? tempDirectory, TMP: process.env.TMP ?? tempDirectory,
        ...environment,
      },
    });
    return { result, preloadMarker, preloadPath };
  };

  try {
    const valid = await runEntry();
    assert.equal(valid.result.error, undefined);
    assert.notEqual(valid.result.status, 0, "the tiny invalid manifest must stop before sampling");
    assert.match(valid.result.stdout, /"kind":"e3_perf_01_cli_failure"/u,
      `a valid outer pin must reach the real manifest validator: ${valid.result.stderr}`);

    const pathAndDigestCases = [
      ["relative-node", (bootstrap) => { bootstrap.nodeExecutable = ".\\node.exe"; }],
      ["PATH-node", (bootstrap) => { bootstrap.nodeExecutable = "node"; }],
      ["wrong-node-digest", (bootstrap) => { bootstrap.nodeSha256 = "0".repeat(64); }],
      ["relative-runner", (bootstrap) => { bootstrap.runnerScriptPath = ".\\run-e3-perf-01.mjs"; }],
      ["PATH-runner", (bootstrap) => { bootstrap.runnerScriptPath = "run-e3-perf-01.mjs"; }],
      ["wrong-runner-digest", (bootstrap) => { bootstrap.runnerScriptSha256 = "0".repeat(64); }],
      ["relative-manifest", (bootstrap) => { bootstrap.manifestPath = ".\\manifest.json"; }],
      ["PATH-manifest", (bootstrap) => { bootstrap.manifestPath = "manifest.json"; }],
      ["wrong-manifest-digest", (bootstrap) => { bootstrap.manifestSha256 = "0".repeat(64); }],
      ["modified-bootstrap", (bootstrap) => { bootstrap.unreviewed = true; }],
      ["modified-node-bytes", (bootstrap, paths) => {
        bootstrap.nodeExecutable = paths.copiedNode;
      }, async ({ copiedNode }) => { await writeFile(copiedNode, "substituted-node", "utf8"); }],
      ["modified-runner-bytes", (bootstrap, paths) => {
        bootstrap.runnerScriptPath = paths.copiedRunner;
      }, async ({ copiedRunner }) => { await writeFile(copiedRunner, "substituted-runner", "utf8"); }],
      ["modified-manifest-bytes", undefined,
        async ({ manifestPath }) => { await writeFile(manifestPath, "{\"changed\":true}\n", "utf8"); }],
    ];
    for (const [name, mutateBootstrap, mutateFiles] of pathAndDigestCases) {
      const { result } = await runEntry({ mutateBootstrap, mutateFiles });
      assert.equal(result.error, undefined, name);
      assert.notEqual(result.status, 0, name);
      assert.doesNotMatch(result.stdout, /"kind":"e3_perf_01_cli_/u,
        `${name} must fail before the JavaScript entry loads`);
    }

    const forbiddenParentEnvironment = [
      "NODE_OPTIONS", "NODE_PATH", "PATH", "GIT_CONFIG", "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM", "GIT_SSH_COMMAND", "GIT_SSL_CAINFO", "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AWS_CA_BUNDLE", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
    ];
    for (const key of forbiddenParentEnvironment) {
      const environment = { [key]: "attacker-value" };
      let preloadMarker;
      if (key === "NODE_OPTIONS") {
        const fixture = await runEntry();
        environment[key] = `--require=${fixture.preloadPath}`;
        ({ preloadMarker } = fixture);
      }
      const executed = await runEntry({ environment });
      assert.equal(executed.result.error, undefined, key);
      assert.notEqual(executed.result.status, 0, key);
      assert.doesNotMatch(executed.result.stdout, /"kind":"e3_perf_01_cli_/u,
        `${key} must fail before the JavaScript entry loads`);
      if (preloadMarker) assert.equal(existsSync(preloadMarker), false, "NODE_OPTIONS preload ran");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe pre/post-sample failures retain exact-version immutable evidence and store loss retains local bytes", {
  skip: !assetsPresent,
}, async () => {
  // Mutation caught: returning only an error code can discard the sole forensic artifact or
  // accidentally turn failed-attempt bytes into QA/handoff evidence.
  const runner = await import("./run-e3-perf-01.mjs");
  assert.equal(typeof runner.runCampaignCommand, "function");
  if (typeof runner.runCampaignCommand !== "function") return;
  for (const [name, expectedCode, mutate] of [
    ["safe-pre-sample", "campaign_git_dirty", (fixture) => { fixture.state.gitDirty = true; }],
    ["safe-post-sample", "campaign_child_exit", (fixture) => { fixture.state.childCode = 23; }],
    ["failure-retention-tamper", "campaign_store_retention", (fixture) => {
      fixture.state.gitDirty = true;
      fixture.state.retention = { mode: "GOVERNANCE", retainUntil: "2027-02-08T00:00:00.000Z" };
    }],
  ]) {
    const fixture = sealedCampaignCommandFixture();
    mutate(fixture);
    const outcome = await captureCommandOutcome(() => runner.runCampaignCommand([
      "--manifest", fixture.paths.manifest, "--output", fixture.paths.output,
    ], fixture.capabilities));
    assert.equal(outcome.error?.code ?? outcome.value?.failureCode, expectedCode, name);
    assert.deepEqual(fixture.state.storeTrace.map(({ operation }) => operation),
      ["put", "head", "get", "retention"], name);
    assert.deepEqual(fixture.state.storeTrace.slice(1).map(({ input }) => input), Array(3).fill({
      objectUri: fixture.state.objectUri, versionId: "version-a1",
    }), `${name} failure readback must pin the created version`);
    assert.equal(fixture.state.localRetains, 1, name);
    assert.equal(fixture.state.exclusiveWrites.some(({ path }) => path === fixture.paths.qa), false, name);
  }

  const storeLoss = sealedCampaignCommandFixture();
  storeLoss.state.childCode = 23;
  storeLoss.state.putFails = true;
  const lost = await captureCommandOutcome(() => runner.runCampaignCommand([
    "--manifest", storeLoss.paths.manifest, "--output", storeLoss.paths.output,
  ], storeLoss.capabilities));
  assert.equal(lost.error?.code ?? lost.value?.failureCode, "campaign_store_upload");
  assert.deepEqual(storeLoss.state.storeTrace.map(({ operation }) => operation), ["put"]);
  assert.equal(storeLoss.state.localRetains, 1);
  assert.equal(storeLoss.state.exclusiveWrites.some(({ path }) => path === storeLoss.paths.qa), false);
});

async function captureCommandOutcome(run) {
  try {
    return { value: await run(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function sealedCampaignCommandFixture() {
  const paths = Object.freeze({
    checkout: "C:/gate/checkout",
    manifest: "C:/gate/checkout/perf-manifest.json",
    output: "C:/gate/output/a1",
    temp: "C:/gate/tmp/a1",
    databaseUrlFile: "C:/gate/secrets/database-url",
    git: "C:/gate/bin/git.exe",
    node: "C:/gate/bin/node.exe",
    pnpm: "C:/gate/bin/pnpm.cjs",
    container: "C:/gate/bin/container.exe",
    provenance: "C:/gate/bin/provenance.exe",
    loadRunner: "C:/gate/checkout/server/src/__tests__/job-leasing-load.integration.test.ts",
    policy: "C:/gate/policy/provenance-policy.json",
    trustRoot: "C:/gate/policy/trust-root.pem",
    qa: "C:/gate/output/a1/qa.json",
  });
  const executableBytes = new Map([
    [paths.git, Buffer.from("pinned-git")],
    [paths.node, Buffer.from("pinned-node")],
    [paths.pnpm, Buffer.from("pinned-pnpm")],
    [paths.container, Buffer.from("pinned-container")],
    [paths.provenance, Buffer.from("pinned-provenance")],
    [paths.loadRunner, Buffer.from("pinned-load-runner")],
    [paths.policy, Buffer.from("pinned-policy")],
    [paths.trustRoot, Buffer.from("pinned-trust-root")],
    [paths.databaseUrlFile, Buffer.from("postgres://test-only.invalid/aoa")],
  ]);
  const digest = (path) => createHash("sha256").update(executableBytes.get(path)).digest("hex");
  const manifest = {
    ...manifestFixture(),
    gitExecutable: paths.git,
    gitSha256: digest(paths.git),
    nodeExecutable: paths.node,
    nodeSha256: digest(paths.node),
    pnpmExecutable: paths.pnpm,
    pnpmSha256: digest(paths.pnpm),
    containerRuntimeExecutable: paths.container,
    containerRuntimeSha256: digest(paths.container),
    provenanceVerifierExecutable: paths.provenance,
    provenanceVerifierSha256: digest(paths.provenance),
    loadRunnerPath: paths.loadRunner,
    loadRunnerSha256: digest(paths.loadRunner),
    policyDigest: digest(paths.policy),
    trustRootDigest: digest(paths.trustRoot),
    argv: [paths.loadRunner, "--maxWorkers=1"],
    childEnvironment: {
      LANG: "C", LC_ALL: "C", TZ: "UTC",
      TMPDIR: paths.temp,
      AOA_E3_PERF_DATABASE_URL_FILE: paths.databaseUrlFile,
    },
  };
  const state = {
    files: new Map(executableBytes),
    manifest,
    processRuns: [],
    storeTrace: [],
    exclusiveWrites: [],
    existingWrites: new Set(),
    localRetains: 0,
    gitDirty: false,
    gitAttached: false,
    gitReplace: false,
    provenanceValid: true,
    parentEnvironment: {},
    childStdout: loadEvidenceRecordsFixture().map((row) => JSON.stringify(row)).join("\n"),
    childCode: 0,
    archiveBytes: Buffer.from("closed-e3-perf-01-archive"),
    archiveSha256: "",
    objectUri: "s3://aoa-e3-perf/e3-perf-01/a1/archive",
    storedBytes: null,
    wrongChecksum: false,
    putFails: false,
    missingVersion: false,
    mutateReadback: false,
    backendLost: false,
    retention: { mode: "COMPLIANCE", retainUntil: "2027-02-08T00:00:00.000Z" },
  };
  state.archiveSha256 = createHash("sha256").update(state.archiveBytes).digest("hex");
  const writeManifest = () => state.files.set(paths.manifest, Buffer.from(JSON.stringify(state.manifest)));
  writeManifest();

  const processCapability = Object.freeze({
    parentEnvironment: () => ({ ...state.parentEnvironment }),
    async run(input) {
      const captured = {
        executable: input.executable,
        argv: [...input.argv],
        cwd: input.cwd,
        env: { ...input.env },
        shell: input.shell,
      };
      state.processRuns.push(captured);
      if (input.executable === paths.git) {
        const command = input.argv.join(" ");
        if (command.includes("symbolic-ref")) return { code: state.gitAttached ? 0 : 1, stdout: state.gitAttached ? "refs/heads/main\n" : "", stderr: "" };
        if (command.includes("refs/replace")) return { code: 0, stdout: state.gitReplace ? "refs/replace/attacker\n" : "", stderr: "" };
        if (command.includes("diff") || command.includes("ls-files --others")) return { code: 0, stdout: state.gitDirty ? "attacker.txt\n" : "", stderr: "" };
        if (command.includes("rev-list --parents")) return { code: 0, stdout: `${GATE_SHA40} ${EVIDENCE_PARENT_SHA40}\n`, stderr: "" };
        if (command.includes("rev-parse HEAD^{tree}")) return { code: 0, stdout: `${GATE_TREE40}\n`, stderr: "" };
        if (command.includes("rev-parse HEAD")) return { code: 0, stdout: `${GATE_SHA40}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (input.executable === paths.provenance) {
        return { code: state.provenanceValid ? 0 : 1, stdout: state.provenanceValid ? JSON.stringify({ verified: true }) : "", stderr: "" };
      }
      if (input.executable === paths.node && input.argv[0] === paths.loadRunner) {
        return { code: state.childCode, stdout: state.childStdout, stderr: "" };
      }
      if (input.executable === paths.container || input.executable === paths.pnpm) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unknown executable" };
    },
  });
  const artifactCapability = Object.freeze({
    async realpath(path) { return path; },
    async readFile(path) {
      const bytes = state.files.get(path);
      if (!bytes) throw Object.assign(new Error("artifact missing"), { code: "ENOENT" });
      return Buffer.from(bytes);
    },
    async stat(path) {
      return { type: state.files.has(path) ? "file" : "directory", mode: "100644", size: state.files.get(path)?.length ?? 0 };
    },
    async list() { return []; },
    async makeDirectoryExclusive() { return true; },
    async writeExclusive(path, bytes) {
      if (state.existingWrites.has(path)) return false;
      state.existingWrites.add(path);
      state.exclusiveWrites.push({ path, bytes: Buffer.from(bytes) });
      return true;
    },
    async archive() { return Buffer.from(state.archiveBytes); },
    async retainLocal() { state.localRetains += 1; },
  });
  const storeCapability = Object.freeze({
    async putObject(input) {
      state.storeTrace.push({ operation: "put", input: structuredClone({ ...input, bytes: undefined }) });
      if (state.putFails) throw Object.assign(new Error("store unavailable"), { code: "BACKEND_LOST" });
      state.storedBytes = Buffer.from(input.bytes);
      return {
        versionId: state.missingVersion ? "" : "version-a1",
        checksumSha256: state.wrongChecksum ? "0".repeat(64) : createHash("sha256").update(input.bytes).digest("hex"),
      };
    },
    async headObject(input) {
      state.storeTrace.push({ operation: "head", input: structuredClone(input) });
      if (state.backendLost) throw Object.assign(new Error("backend unavailable"), { code: "BACKEND_LOST" });
      return { versionId: "version-a1", byteLength: state.storedBytes?.length ?? 0 };
    },
    async getObject(input) {
      state.storeTrace.push({ operation: "get", input: structuredClone(input) });
      if (state.backendLost) throw Object.assign(new Error("backend unavailable"), { code: "BACKEND_LOST" });
      return state.mutateReadback ? Buffer.from("mutated-readback") : Buffer.from(state.storedBytes ?? []);
    },
    async getObjectRetention(input) {
      state.storeTrace.push({ operation: "retention", input: structuredClone(input) });
      return state.retention && { ...state.retention };
    },
  });
  const clockCapability = Object.freeze({ now: () => new Date(CAMPAIGN_NOW) });
  const fixture = {
    paths,
    state,
    capabilities: Object.freeze({
      process: processCapability,
      artifact: artifactCapability,
      store: storeCapability,
      clock: clockCapability,
    }),
    rewriteManifest(mutate) {
      mutate(state.manifest);
      writeManifest();
    },
  };
  return fixture;
}

test("manifest and evidence schemas close executable provenance, immutable store, and failed-attempt facts", { skip: !assetsPresent }, () => {
  const manifestText = readFileSync(REQUIRED_ASSETS[1], "utf8");
  const evidenceText = readFileSync(REQUIRED_ASSETS[2], "utf8");
  for (const field of [
    "gitExecutable", "gitSha256", "nodeExecutable", "nodeSha256", "pnpmExecutable",
    "pnpmSha256", "containerRuntimeExecutable", "containerRuntimeSha256",
    "provenanceVerifierExecutable", "provenanceVerifierSha256", "policyDigest",
    "trustRootDigest", "argv", "childEnvironment",
  ]) {
    assert.match(manifestText, new RegExp(`"${field}"`), `manifest omits ${field}`);
  }
  for (const field of [
    "objectVersion", "checksumSha256", "objectLockMode", "retentionUntil",
    "readbackSha256", "failureCode", "failedAttempt",
  ]) {
    assert.match(evidenceText, new RegExp(`"${field}"`), `evidence omits ${field}`);
  }
});
