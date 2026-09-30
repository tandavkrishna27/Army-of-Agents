import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// ---------------------------------------------------------------------------
// Independent Security handoff verifier (E3-PERF-01 / F031).
//
// This command is DISTINCT from the Integration campaign runner. It must never
// import ./run-e3-perf-01.mjs — it reimplements archive decode / manifest binding
// / canary scan and reuses only the shared JSON evidence schema. It refetches the
// exact immutable object version pinned in the campaign QA record, revalidates the
// archived evidence, realpaths its own pinned bytes, and writes the security
// handoff receipt only when Integration's bytes are provably intact.
// ---------------------------------------------------------------------------

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

// The one git call that runs before the parent-environment gate (worktree discovery for ajv) must
// not inherit config-injection vectors. Strip GIT_*/AWS_*/proxy/SSL_CERT_*/NODE_* overrides while
// keeping PATH so git still resolves; a poisoned config/ssh-command hook cannot execute at load.
function sanitizedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !/^(?:GIT_|AWS_)/u.test(key) && !/_PROXY$/u.test(key) && !/^SSL_CERT_/u.test(key) &&
      !["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS"].includes(key)),
  );
}

function loadServerAjv() {
  const candidates = [resolve(REPOSITORY_ROOT, "server", "package.json")];
  try {
    const commonGitDirectory = execFileSync(
      "git",
      ["--no-replace-objects", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8", windowsHide: true, env: sanitizedGitEnvironment() },
    ).trim();
    candidates.push(resolve(dirname(commonGitDirectory), "server", "package.json"));
  } catch {
    // The ordinary candidate below still fails closed if this is not a Git checkout.
  }
  for (const packagePath of [...new Set(candidates)]) {
    try {
      return createRequire(pathToFileURL(packagePath))("ajv/dist/2020.js").default;
    } catch {
      // Try the shared main-worktree installation next.
    }
  }
  fail("security_ajv_unavailable");
}

const Ajv2020 = loadServerAjv();
const EVIDENCE_SCHEMA_PATH = new URL("./e3-perf-01-evidence.schema.json", import.meta.url);
const evidenceSchema = JSON.parse(readFileSync(EVIDENCE_SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateEvidenceSchema = ajv.compile(evidenceSchema);

const SECURITY_BOOTSTRAP_PATH = "/run/aoa/e3-perf-01-security-bootstrap.json";
const SECURITY_HANDOFF_FILENAME = "security-handoff.json";
const SECURITY_VERIFIER_RELATIVE = "scripts/verify-e3-perf-01-handoff.mjs";
const CAMPAIGN_RUNNER_RELATIVE = "scripts/run-e3-perf-01.mjs";
const ARCHIVE_FORMAT = "aoa-e3-perf-01-archive-v1";
const EVIDENCE_ENTRY_PATH = "e3-perf-01-evidence.json";
const OBJECT_LOCK_MODE = "COMPLIANCE";
const MINIMUM_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const SECURITY_BOOTSTRAP_KEYS = Object.freeze([
  "checkoutPath", "manifestPath", "manifestSha256", "nodeExecutable", "nodeSha256",
  "outputDirectory", "parentEnvironment", "runnerScriptPath", "runnerScriptSha256", "schemaVersion",
]);
const SECURITY_PARENT_ENVIRONMENT_KEYS = Object.freeze([
  "AOA_E3_PERF_DATABASE_URL_FILE", "LANG", "LC_ALL", "TMPDIR", "TZ",
]);
const EXACT_FORBIDDEN_PARENT_ENVIRONMENT_KEYS = new Set([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
]);
// The pinned Node executes this one-liner so the OS — not a JavaScript fact —
// canonicalizes the verifier path. Both realpaths must be byte-for-byte equal.
const SECURITY_REALPATH_PROGRAM = 'const fs=require("node:fs");process.stdout.write(JSON.stringify(process.argv.slice(1).map((value)=>fs.realpathSync.native(value))))';

class GateFailure extends Error {
  constructor(code) {
    super(`E3-PERF-01 security handoff rejected (${code})`);
    this.name = "GateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new GateFailure(code);
}

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function normalizeSlashes(candidate) {
  return String(candidate).replaceAll("\\", "/");
}

function isAbsolutePinPath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/u.test(candidate)) return true;
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return true;
  return false;
}

function isForbiddenParentEnvironmentKey(key) {
  if (EXACT_FORBIDDEN_PARENT_ENVIRONMENT_KEYS.has(key)) return true;
  if (/^GIT_/u.test(key)) return true;
  if (/^AWS_/u.test(key)) return true;
  if (/_PROXY$/u.test(key)) return true;
  if (/^SSL_CERT_/u.test(key)) return true;
  return false;
}

function scanSensitiveStrings(value, seen = new Set()) {
  const visit = (entry) => {
    if (typeof entry === "string") {
      if (/E3_[A-Z0-9_]*CANARY/iu.test(entry)) fail("__canary__");
      if (/authorization\s*:\s*bearer\s+\S+/iu.test(entry)) fail("__canary__");
      if (/password\s*=/iu.test(entry)) fail("__canary__");
      if (/AKIA[0-9A-Z]{16}/u.test(entry)) fail("__canary__");
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) fail("__canary__");
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
    } else {
      for (const child of Object.values(entry)) visit(child);
    }
    seen.delete(entry);
  };
  visit(value);
  return true;
}

function assertSecurityCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    fail("security_capabilities");
  }
  if (!isDeepStrictEqual(Object.keys(capabilities).sort(), ["artifact", "clock", "process", "store"])) {
    fail("security_capabilities");
  }
  for (const key of ["artifact", "clock", "process", "store"]) {
    const value = capabilities[key];
    if (!value || (typeof value !== "object" && typeof value !== "function")) fail("security_capabilities");
  }
}

function assertNoForbiddenParentEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("security_parent_environment");
  }
  for (const key of Object.keys(environment)) {
    if (isForbiddenParentEnvironmentKey(key)) fail("security_parent_environment");
  }
}

function parseSecurityArgv(argv) {
  if (Array.isArray(argv) && argv.length === 6 &&
      argv[0] === "--manifest" && argv[2] === "--qa" && argv[4] === "--output") {
    return { manifestArg: argv[1], qaArg: argv[3], outputArg: argv[5] };
  }
  fail("security_arguments");
}

async function readJsonArtifact(artifact, path, code) {
  let bytes;
  try {
    bytes = await artifact.readFile(path);
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail(code);
  }
}

async function readPinnedBytes(artifact, path, code) {
  try {
    return Buffer.from(await artifact.readFile(path));
  } catch {
    fail(code);
  }
}

function validateSecurityBootstrap(bootstrap) {
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) fail("security_bootstrap_schema");
  if (!isDeepStrictEqual(Object.keys(bootstrap).sort(), [...SECURITY_BOOTSTRAP_KEYS])) fail("security_bootstrap_schema");
  if (bootstrap.schemaVersion !== 1) fail("security_bootstrap_schema");
  const parentEnvironment = bootstrap.parentEnvironment;
  if (!parentEnvironment || typeof parentEnvironment !== "object" || Array.isArray(parentEnvironment)) {
    fail("security_parent_environment");
  }
  if (!isDeepStrictEqual(Object.keys(parentEnvironment).sort(), [...SECURITY_PARENT_ENVIRONMENT_KEYS])) {
    fail("security_parent_environment");
  }
  if (parentEnvironment.LANG !== "C" || parentEnvironment.LC_ALL !== "C" || parentEnvironment.TZ !== "UTC") {
    fail("security_parent_environment");
  }
  if (!isAbsolutePinPath(parentEnvironment.TMPDIR) ||
      !isAbsolutePinPath(parentEnvironment.AOA_E3_PERF_DATABASE_URL_FILE)) {
    fail("security_parent_environment");
  }
}

function assertCompliantObjectRetention(retention, nowMs) {
  if (!retention || typeof retention !== "object") fail("security_object_retention");
  if (String(retention.mode).toUpperCase() !== OBJECT_LOCK_MODE) fail("security_object_retention");
  const retainMs = Date.parse(retention.retainUntil);
  if (!Number.isFinite(retainMs) || retainMs - nowMs < MINIMUM_RETENTION_MS) fail("security_object_retention");
}

// Reimplemented archive decode + manifest binding + evidence schema + canary scan.
// (Deliberately local so this verifier never depends on the campaign runner.)
function validateSecurityArchive(archiveBytes) {
  let document;
  try {
    document = JSON.parse(Buffer.from(archiveBytes).toString("utf8"));
  } catch {
    fail("security_archive_schema");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("security_archive_schema");
  if (!isDeepStrictEqual(Object.keys(document).sort(), ["entries", "format", "manifest"])) fail("security_archive_schema");
  if (document.format !== ARCHIVE_FORMAT) fail("security_archive_schema");
  if (!Array.isArray(document.entries) || !Array.isArray(document.manifest)) fail("security_archive_schema");
  if (document.entries.length !== document.manifest.length) fail("security_archive_schema");
  const seenPaths = new Set();
  const recomputed = document.entries.map((entry) => {
    // Full per-entry validation mirroring the canonical decode: exact keys, regular-file type,
    // safe relative path, and no duplicate path — so a smuggled non-file / path-escape / duplicate
    // entry cannot ride alongside the evidence entry.
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("security_archive_schema");
    if (!isDeepStrictEqual(Object.keys(entry).sort(), ["bytesBase64", "path", "type"])) fail("security_archive_schema");
    if (typeof entry.bytesBase64 !== "string" || entry.type !== "file") fail("security_archive_schema");
    if (!isSafeArchivePath(entry.path) || seenPaths.has(entry.path)) fail("security_archive_schema");
    seenPaths.add(entry.path);
    const entryBytes = Buffer.from(entry.bytesBase64, "base64");
    if (entryBytes.toString("base64") !== entry.bytesBase64) fail("security_archive_schema");
    // Canary/credential scan on EVERY entry's bytes, not only the evidence entry, so a secret
    // smuggled in a second entry cannot pass an "archive is canary-free" handoff receipt.
    try {
      scanSensitiveStrings(entryBytes.toString("utf8"));
    } catch {
      fail("security_archive_canary");
    }
    return {
      path: entry.path,
      type: entry.type,
      byteLength: entryBytes.length,
      sha256: sha256(entryBytes),
    };
  });
  if (!isDeepStrictEqual(recomputed, document.manifest)) fail("security_archive_schema");
  const evidenceEntry = document.entries.find((entry) => entry.path === EVIDENCE_ENTRY_PATH);
  if (!evidenceEntry) fail("security_archive_schema");
  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(evidenceEntry.bytesBase64, "base64").toString("utf8"));
  } catch {
    fail("security_archive_schema");
  }
  if (!validateEvidenceSchema(evidence)) fail("security_archive_schema");
  try {
    scanSensitiveStrings(evidence);
  } catch {
    fail("security_archive_canary");
  }
}

function isSafeArchivePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export async function runSecurityHandoffCommand(argv, capabilities) {
  try {
    assertSecurityCapabilities(capabilities);
    const { process: processCapability, artifact, store, clock } = capabilities;
    const { qaArg, outputArg } = parseSecurityArgv(argv);
    const parentEnvironment = processCapability.parentEnvironment();
    assertNoForbiddenParentEnvironment(parentEnvironment);

    const bootstrap = await readJsonArtifact(artifact, SECURITY_BOOTSTRAP_PATH, "security_bootstrap_schema");
    validateSecurityBootstrap(bootstrap);

    if (!isAbsolutePinPath(bootstrap.checkoutPath)) fail("security_checkout_path");
    if (!isAbsolutePinPath(bootstrap.outputDirectory)) fail("security_output_path");

    if (!isAbsolutePinPath(bootstrap.nodeExecutable)) fail("security_node_path");
    const nodeBytes = await readPinnedBytes(artifact, bootstrap.nodeExecutable, "security_node_digest");
    if (sha256(nodeBytes) !== bootstrap.nodeSha256) fail("security_node_digest");

    const verifierPath = bootstrap.runnerScriptPath;
    if (!isAbsolutePinPath(verifierPath) ||
        !normalizeSlashes(verifierPath).endsWith(SECURITY_VERIFIER_RELATIVE)) {
      fail("security_verifier_path");
    }
    const verifierBytes = await readPinnedBytes(artifact, verifierPath, "security_verifier_digest");
    if (sha256(verifierBytes) !== bootstrap.runnerScriptSha256) fail("security_verifier_digest");

    if (!isAbsolutePinPath(bootstrap.manifestPath)) fail("security_manifest_path");
    const manifestBytes = await readPinnedBytes(artifact, bootstrap.manifestPath, "security_manifest_digest");
    if (sha256(manifestBytes) !== bootstrap.manifestSha256) fail("security_manifest_digest");

    // The pinned Node realpaths the verifier and the canonical checkout location;
    // both must resolve to the identical (case-sensitive) path.
    const expectedVerifier = `${bootstrap.checkoutPath}/${SECURITY_VERIFIER_RELATIVE}`;
    const probe = await processCapability.run({
      executable: bootstrap.nodeExecutable,
      argv: ["-e", SECURITY_REALPATH_PROGRAM, verifierPath, expectedVerifier],
      cwd: bootstrap.checkoutPath,
      env: bootstrap.parentEnvironment,
      shell: false,
    });
    if (!probe || probe.code !== 0) fail("security_verifier_path");
    let realpaths;
    try {
      realpaths = JSON.parse(String(probe.stdout));
    } catch {
      fail("security_verifier_path");
    }
    if (!Array.isArray(realpaths) || realpaths.length !== 2 || realpaths[0] !== realpaths[1]) {
      fail("security_verifier_path");
    }

    const qa = await readJsonArtifact(artifact, qaArg, "security_qa_schema");
    const nowMs = clock.now().getTime();
    const versionRef = { objectUri: qa.objectUri, versionId: qa.objectVersion };

    let head;
    try {
      head = await store.headObject({ ...versionRef });
    } catch {
      fail("security_store_readback");
    }
    if (!head || head.versionId !== qa.objectVersion) fail("security_object_version");
    if (head.checksumSha256 !== qa.checksumSha256) fail("security_object_checksum");
    if (qa.archiveSha256 !== head.checksumSha256) fail("security_archive_digest");

    let archiveBytes;
    try {
      archiveBytes = Buffer.from(await store.getObject({ ...versionRef }));
    } catch {
      fail("security_store_readback");
    }
    if (sha256(archiveBytes) !== qa.archiveSha256) fail("security_archive_readback");
    validateSecurityArchive(archiveBytes);

    const retention = await store.getObjectRetention({ ...versionRef });
    assertCompliantObjectRetention(retention, nowMs);

    const securityVerifierSha256 = sha256(verifierBytes);
    const campaignRunnerPath = `${bootstrap.checkoutPath}/${CAMPAIGN_RUNNER_RELATIVE}`;
    const campaignRunnerBytes = await readPinnedBytes(artifact, campaignRunnerPath, "security_verifier_digest");
    const campaignRunnerSha256 = sha256(campaignRunnerBytes);
    // A pinned campaign-runner digest can never authorize substituted Security bytes.
    if (securityVerifierSha256 === campaignRunnerSha256) fail("security_verifier_digest");

    if (!normalizeSlashes(outputArg).endsWith(SECURITY_HANDOFF_FILENAME)) fail("security_output_path");
    const handoffDocument = {
      schemaVersion: 1,
      gate: "E3-PERF-01",
      disposition: "pass",
      objectUri: qa.objectUri,
      objectVersion: qa.objectVersion,
      securityVerifierSha256,
      campaignRunnerSha256,
      retentionUntil: qa.retentionUntil,
      objectLockMode: OBJECT_LOCK_MODE,
    };
    const wrote = await artifact.writeExclusive(outputArg, Buffer.from(JSON.stringify(handoffDocument)));
    if (wrote !== true) fail("security_handoff_exclusive");
    return { disposition: "pass", objectVersion: qa.objectVersion };
  } catch (error) {
    return {
      disposition: "fail",
      failureCode: error instanceof GateFailure ? error.code : "security_internal_error",
    };
  }
}

// Production adapters for `runSecurityHandoffCommand`. Module-private and frozen:
// the store is read-only (head / get / GetObjectRetention only). No CLI option,
// environment variable, or dynamic module path can select a substitute.
async function loadS3Client() {
  return import("@aws-sdk/client-s3");
}

function parseObjectUri(objectUri) {
  const match = String(objectUri).match(/^s3:\/\/([^/]+)\/(.+)$/u);
  if (!match) fail("security_store_readback");
  return { bucket: match[1], key: match[2] };
}

function createProductionSecurityCapabilities() {
  const processCapability = Object.freeze({
    parentEnvironment() {
      return { ...process.env };
    },
    run(input) {
      return new Promise((resolvePromise) => {
        let child;
        try {
          child = spawn(input.executable, [...input.argv], {
            cwd: input.cwd,
            env: { ...input.env },
            shell: input.shell === true,
            windowsHide: true,
          });
        } catch {
          resolvePromise({ code: 127, stdout: "", stderr: "spawn failed" });
          return;
        }
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", () => resolvePromise({ code: 127, stdout, stderr: stderr || "spawn error" }));
        child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
      });
    },
  });
  const artifactCapability = Object.freeze({
    async realpath(path) {
      return realpathSync.native(path);
    },
    async readFile(path) {
      return readFileSync(path);
    },
    async stat(path) {
      const stats = lstatSync(path);
      return {
        type: stats.isDirectory() ? "directory" : "file",
        mode: (stats.mode & 0o7777).toString(8),
        size: stats.size,
      };
    },
    async writeExclusive(path, bytes) {
      try {
        writeFileSync(path, bytes, { flag: "wx" });
        return true;
      } catch (error) {
        if (error && error.code === "EEXIST") return false;
        throw error;
      }
    },
  });
  const storeCapability = Object.freeze({
    async headObject(input) {
      const { S3Client, HeadObjectCommand } = await loadS3Client();
      const { bucket, key } = parseObjectUri(input.objectUri);
      const client = new S3Client({});
      const response = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: input.versionId,
        ChecksumMode: "ENABLED",
      }));
      const checksum = response.ChecksumSHA256
        ? Buffer.from(response.ChecksumSHA256, "base64").toString("hex")
        : undefined;
      return {
        versionId: response.VersionId ?? input.versionId,
        checksumSha256: checksum,
        byteLength: response.ContentLength ?? 0,
      };
    },
    async getObject(input) {
      const { S3Client, GetObjectCommand } = await loadS3Client();
      const { bucket, key } = parseObjectUri(input.objectUri);
      const client = new S3Client({});
      const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: input.versionId,
      }));
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async getObjectRetention(input) {
      const { S3Client, GetObjectRetentionCommand } = await loadS3Client();
      const { bucket, key } = parseObjectUri(input.objectUri);
      const client = new S3Client({});
      const response = await client.send(new GetObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        VersionId: input.versionId,
      }));
      const retention = response.Retention;
      if (!retention) return null;
      return { mode: retention.Mode, retainUntil: new Date(retention.RetainUntilDate).toISOString() };
    },
  });
  return Object.freeze({
    process: processCapability,
    artifact: artifactCapability,
    store: storeCapability,
    clock: Object.freeze({ now: () => new Date() }),
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const outcome = await runSecurityHandoffCommand(
    process.argv.slice(2),
    createProductionSecurityCapabilities(),
  );
  const record = outcome && outcome.disposition === "pass"
    ? {
      kind: "e3_perf_01_security_result",
      mode: "security-handoff",
      phase: "security-verification",
      disposition: "pass",
    }
    : {
      kind: "e3_perf_01_security_failure",
      mode: "security-handoff",
      phase: "security-verification",
      disposition: "fail",
    };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (record.disposition !== "pass") process.exitCode = 1;
}
