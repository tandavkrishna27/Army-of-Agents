/**
 * check-frozen-worker-protocol-consumer.mjs
 *
 * Independently re-verify the frozen, hash-pinned worker-protocol v1 consumer
 * baseline (`tests/fixtures/worker-protocol-consumers/v1/`). It NEVER trusts the
 * freeze script's output — it recomputes every hash, checks the recorded source
 * SHA / Zod + esbuild versions / lockfile + package integrity / bundler config,
 * and rejects any runtime dependency, current-protocol-source import, absolute
 * path, embedded build path/timestamp, or test file. The CLI additionally imports
 * the frozen root in isolated "server" and "worker" smoke child processes.
 *
 * Verification helpers are exported for the dependency-free `node:test`
 * mutation corpus, which operates on isolated temp copies and never mutates
 * the checked-in fixture. Source and anchor verification invoke Git; static
 * fixture verification and manifest recomputation only read filesystem bytes.
 *
 * Usage:
 *   node scripts/check-frozen-worker-protocol-consumer.mjs --source-sha <40-hex>
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The frozen fixture location, relative to the repo root, as POSIX segments. */
export const FIXTURE_SEGMENTS = ["tests", "fixtures", "worker-protocol-consumers", "v1"];
export const MANIFEST_NAME = "manifest.sha256";
export const LOCK_NAME = "dependency-lock.json";
export const PACKAGE_NAME = "package.json";

const SOURCE_PACKAGE_PATH = "packages/worker-protocol/package.json";
const SOURCE_LOCK_PATH = "pnpm-lock.yaml";
const SOURCE_TREE_PATH = "packages/worker-protocol/src";
const FIXTURE_PATH = FIXTURE_SEGMENTS.join("/");
export const FROZEN_FIXTURE_ANCHOR_SHA = "c68053421ac53c5b49066b041c8fbcdd920dad62";
const SMOKE_TIMEOUT_MS = 5_000;
const SMOKE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** The FIXED, deterministic esbuild bundler options the freeze uses and the lock
 * records. Any drift here changes the frozen bytes and must mint a new fixture. */
export const BUNDLER_OPTIONS = Object.freeze({
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
  minify: false,
});

/** The only top-level entries a frozen fixture may contain. */
const ALLOWED_TOP_LEVEL = new Set([PACKAGE_NAME, LOCK_NAME, MANIFEST_NAME, "dist"]);

// --- Filesystem helpers ------------------------------------------------------

function walkPosix(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const abs = path.join(dir, entry.name);
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      out.push({ rel, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      walkPosix(abs, rel, out);
      continue;
    }
    out.push({ rel, symlink: false });
  }
  return out;
}

/** Every file under `dir` as sorted POSIX-relative paths, EXCLUDING the manifest
 * (a manifest never hashes itself). Symlinks are surfaced (and rejected). */
export function listFrozenFiles(dir) {
  return walkPosix(dir, "", []).filter((f) => f.rel !== MANIFEST_NAME);
}

/** Recompute the manifest bytes: sorted `<sha256>  <posix>\n` over every frozen
 * file except the manifest, UTF-8/LF with a final LF. Deterministic. */
export function recomputeManifestBytes(dir) {
  const files = listFrozenFiles(dir);
  const lines = [];
  for (const { rel, symlink } of files) {
    if (symlink) throw new Error(`frozen fixture contains a symlink: ${rel}`);
    const digest = createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
    lines.push(`${digest}  ${rel}`);
  }
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66), "en"));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

// --- Static verification (pure; no import/exec) ------------------------------

function findModuleSpecifiers(source) {
  const values = [];
  const patterns = [
    /(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) values.push(m[1]);
  return values;
}

const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;

function absolutePathHits(text, repoRoot) {
  const hits = [];
  if (/\bfile:\/\//i.test(text)) hits.push("file:// URL");
  if (DRIVE_PATH.test(text)) hits.push("windows drive path");
  if (/(?<![A-Za-z0-9])\/(?:Users|home|root)\//.test(text)) hits.push("unix home path");
  if (repoRoot && text.includes(repoRoot)) hits.push("absolute repo root path");
  return hits;
}

/**
 * Statically verify a frozen fixture directory. Pure: reads bytes only, never
 * imports or execs. Returns `{ errors: string[] }`. Every provided `expected*`
 * value that is non-undefined is asserted against the recorded lock value.
 */
export function verifyFrozenConsumerStatic({
  dir,
  sourceSha,
  expectedZodVersion,
  expectedEsbuildVersion,
  expectedLockfileIntegrity,
  expectedPackageIntegrity,
  repoRoot,
} = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!dir || !fs.existsSync(dir)) {
    return { errors: [`frozen fixture directory is missing: ${dir}`] };
  }

  // 1. Only allowed top-level entries.
  for (const entry of fs.readdirSync(dir)) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) fail(`unexpected top-level entry in frozen fixture: ${entry}`);
  }

  // 2. Manifest recompute + byte match.
  let recomputed;
  try {
    recomputed = recomputeManifestBytes(dir);
  } catch (err) {
    fail(`manifest recompute failed: ${err.message}`);
  }
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    fail(`missing ${MANIFEST_NAME}`);
  } else if (recomputed && Buffer.compare(fs.readFileSync(manifestPath), recomputed) !== 0) {
    fail(`${MANIFEST_NAME} does not match the recomputed hash of the frozen bytes`);
  }

  // 3. dependency-lock.json.
  const lockPath = path.join(dir, LOCK_NAME);
  let lock;
  if (!fs.existsSync(lockPath)) {
    fail(`missing ${LOCK_NAME}`);
  } else {
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch (err) {
      fail(`${LOCK_NAME} is not valid JSON: ${err.message}`);
    }
  }
  if (lock) {
    if (!/^[0-9a-f]{40}$/.test(String(lock.sourceSha))) fail(`${LOCK_NAME}: sourceSha is not a 40-hex commit`);
    if (sourceSha !== undefined && String(lock.sourceSha) !== String(sourceSha)) {
      fail(`${LOCK_NAME}: recorded sourceSha ${lock.sourceSha} != expected ${sourceSha}`);
    }
    if (JSON.stringify(lock.bundlerOptions) !== JSON.stringify(BUNDLER_OPTIONS)) {
      fail(`${LOCK_NAME}: bundlerOptions do not match the fixed deterministic configuration`);
    }
    for (const key of ["zodVersion", "esbuildVersion", "lockfileIntegrity", "packageIntegrity"]) {
      if (typeof lock[key] !== "string" || lock[key].length === 0) fail(`${LOCK_NAME}: missing ${key}`);
    }
    if (expectedZodVersion !== undefined && lock.zodVersion !== expectedZodVersion) {
      fail(`${LOCK_NAME}: recorded zodVersion ${lock.zodVersion} != expected ${expectedZodVersion}`);
    }
    if (expectedEsbuildVersion !== undefined && lock.esbuildVersion !== expectedEsbuildVersion) {
      fail(`${LOCK_NAME}: recorded esbuildVersion ${lock.esbuildVersion} != expected ${expectedEsbuildVersion}`);
    }
    if (expectedLockfileIntegrity !== undefined && lock.lockfileIntegrity !== expectedLockfileIntegrity) {
      fail(`${LOCK_NAME}: recorded lockfileIntegrity does not match the expected lockfile integrity`);
    }
    if (expectedPackageIntegrity !== undefined && lock.packageIntegrity !== expectedPackageIntegrity) {
      fail(`${LOCK_NAME}: recorded packageIntegrity does not match the expected package integrity`);
    }
  }

  // 4. package.json — no runtime dependency; minimal metadata.
  const pkgPath = path.join(dir, PACKAGE_NAME);
  if (!fs.existsSync(pkgPath)) {
    fail(`missing ${PACKAGE_NAME}`);
  } else {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch (err) {
      fail(`${PACKAGE_NAME} is not valid JSON: ${err.message}`);
    }
    if (pkg) {
      for (const depKey of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        if (pkg[depKey] && Object.keys(pkg[depKey]).length > 0) fail(`frozen ${PACKAGE_NAME} declares ${depKey} — the baseline must have NO runtime dependency`);
      }
      if (pkg.type !== "module") fail(`frozen ${PACKAGE_NAME} must be an ES module`);
      if (pkg.main !== "./dist/index.js") fail(`frozen ${PACKAGE_NAME} main must be ./dist/index.js`);
    }
  }

  // 5. Per-file content checks.
  let files = [];
  try {
    files = listFrozenFiles(dir);
  } catch (err) {
    fail(err.message);
  }
  let sawBundle = false;
  for (const { rel, symlink } of files) {
    if (symlink) {
      fail(`frozen fixture contains a symlink: ${rel}`);
      continue;
    }
    if (/\.test\./.test(rel) || rel.endsWith(".test.js") || rel.endsWith(".test.ts")) {
      fail(`frozen fixture contains a test file: ${rel}`);
    }
    const bytes = fs.readFileSync(path.join(dir, rel));
    if (bytes.includes(0x0d)) fail(`frozen file has a CR byte (must be LF): ${rel}`);
    const text = bytes.toString("utf8");
    if (rel === "dist/index.js") {
      sawBundle = true;
      const specifiers = findModuleSpecifiers(text);
      if (specifiers.length > 0) {
        fail(`frozen dist/index.js is not fully bundled — it imports/requires: ${[...new Set(specifiers)].join(", ")}`);
      }
      if (/\/\/#\s*sourceMappingURL=/.test(text)) fail("frozen dist/index.js embeds a sourceMappingURL (build path/timestamp leak)");
      for (const hit of absolutePathHits(text, repoRoot)) fail(`frozen dist/index.js embeds an absolute path (${hit})`);
    } else if (rel.endsWith(".d.ts")) {
      if (/packages[\\/]worker-protocol[\\/]src/.test(text)) fail(`frozen declaration ${rel} references current protocol source`);
      if (/\/\/#\s*sourceMappingURL=/.test(text)) fail(`frozen declaration ${rel} embeds a sourceMappingURL`);
      for (const hit of absolutePathHits(text, repoRoot)) fail(`frozen declaration ${rel} embeds an absolute path (${hit})`);
    }
  }
  if (!sawBundle) fail("frozen fixture is missing dist/index.js");

  return { errors };
}

// --- Immutable source-revision verification --------------------------------

function runVerificationGit(repoRoot, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  return spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: repoRoot,
    encoding: null,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    windowsHide: true,
    maxBuffer,
  });
}

function gitObjectType(repoRoot, objectName) {
  const result = runVerificationGit(repoRoot, ["cat-file", "-t", objectName]);
  return result.status === 0 ? result.stdout.toString("utf8").trim() : null;
}

function resolveGitObject(repoRoot, objectName) {
  const result = runVerificationGit(repoRoot, ["rev-parse", "--verify", objectName]);
  return result.status === 0 ? result.stdout.toString("utf8").trim() : null;
}

function replacementRefExists(repoRoot, objectId) {
  const result = runVerificationGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/replace/${objectId}`]);
  return result.status === 0;
}

function readGitObject(repoRoot, type, objectName, unavailableMessage) {
  const result = runVerificationGit(repoRoot, ["cat-file", type, objectName]);
  if (result.status !== 0) throw new Error(unavailableMessage);
  return result.stdout;
}

function readGitBlob(repoRoot, sourceSha, relativePath) {
  const objectName = `${sourceSha}:${relativePath}`;
  return readGitObject(
    repoRoot,
    "blob",
    objectName,
    `recorded source blob ${objectName} is unavailable; fetch the E1 source revision and retry`,
  );
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function importerDependency(lockText, importerName, sectionName, dependencyName) {
  const lines = lockText.replace(/\r\n/g, "\n").split("\n");
  const importersStart = lines.findIndex((line) => line === "importers:");
  if (importersStart === -1) return null;

  const importerHeader = `  ${importerName}:`;
  const importerStart = lines.findIndex((line, index) => index > importersStart && line === importerHeader);
  if (importerStart === -1) return null;
  let importerEnd = lines.length;
  for (let index = importerStart + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) || (/^  \S/.test(lines[index]) && !/^    /.test(lines[index]))) {
      importerEnd = index;
      break;
    }
  }

  const sectionHeader = `    ${sectionName}:`;
  let sectionStart = -1;
  for (let index = importerStart + 1; index < importerEnd; index += 1) {
    if (lines[index] === sectionHeader) {
      sectionStart = index;
      break;
    }
  }
  if (sectionStart === -1) return null;
  let sectionEnd = importerEnd;
  for (let index = sectionStart + 1; index < importerEnd; index += 1) {
    if (/^    \S/.test(lines[index]) && !/^      /.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const dependencyHeader = `      ${dependencyName}:`;
  let dependencyStart = -1;
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (lines[index] === dependencyHeader) {
      dependencyStart = index;
      break;
    }
  }
  if (dependencyStart === -1) return null;
  let dependencyEnd = sectionEnd;
  for (let index = dependencyStart + 1; index < sectionEnd; index += 1) {
    if (/^      \S/.test(lines[index]) && !/^        /.test(lines[index])) {
      dependencyEnd = index;
      break;
    }
  }

  const fields = {};
  for (let index = dependencyStart + 1; index < dependencyEnd; index += 1) {
    const match = /^        (specifier|version):\s*(.+)$/.exec(lines[index]);
    if (match) fields[match[1]] = yamlScalar(match[2]);
  }
  return fields.specifier && fields.version ? fields : null;
}

/** Verify the fixture's dependency evidence against immutable Git objects at
 * its recorded source revision. This deliberately needs no checkout state and
 * no installed dependency, so it is deterministic in a clean clone. */
export function verifyFrozenConsumerSourceSnapshot({ repoRoot, sourceSha, dependencyLock } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!repoRoot || !sourceSha || !dependencyLock) return { errors: ["source snapshot verification inputs are incomplete"] };

  if (replacementRefExists(repoRoot, sourceSha)) {
    return {
      errors: [`replacement ref exists for recorded source commit ${sourceSha}; remove refs/replace/${sourceSha} and retry`],
    };
  }

  const sourceType = gitObjectType(repoRoot, sourceSha);
  if (sourceType === null) {
    return { errors: [`recorded source commit ${sourceSha} is unavailable; fetch the E1 source revision and retry`] };
  }
  if (sourceType !== "commit") {
    return { errors: [`recorded source object ${sourceSha} is ${sourceType}; expected commit`] };
  }

  const sourceTreeObject = `${sourceSha}:${SOURCE_TREE_PATH}`;
  const sourceTreeType = gitObjectType(repoRoot, sourceTreeObject);
  const sourceTreeOid = sourceTreeType === "tree" ? resolveGitObject(repoRoot, sourceTreeObject) : null;
  if (!sourceTreeOid) {
    fail(`recorded source tree ${sourceSha}:${SOURCE_TREE_PATH} is unavailable; fetch the E1 source revision and retry`);
  }

  let packageBytes;
  let lockBytes;
  try {
    packageBytes = readGitBlob(repoRoot, sourceSha, SOURCE_PACKAGE_PATH);
  } catch (error) {
    fail(error.message);
  }
  try {
    lockBytes = readGitBlob(repoRoot, sourceSha, SOURCE_LOCK_PATH);
  } catch (error) {
    fail(error.message);
  }
  if (!packageBytes || !lockBytes) return { errors };

  const sourcePackageIntegrity = createHash("sha256").update(packageBytes).digest("hex");
  const sourceLockfileIntegrity = createHash("sha256").update(lockBytes).digest("hex");
  if (dependencyLock.packageIntegrity !== sourcePackageIntegrity) {
    fail(`${LOCK_NAME}: recorded packageIntegrity does not match source blob ${sourceSha}:${SOURCE_PACKAGE_PATH}`);
  }
  if (dependencyLock.lockfileIntegrity !== sourceLockfileIntegrity) {
    fail(`${LOCK_NAME}: recorded lockfileIntegrity does not match source blob ${sourceSha}:${SOURCE_LOCK_PATH}`);
  }

  let sourcePackage;
  try {
    sourcePackage = JSON.parse(packageBytes.toString("utf8"));
  } catch (error) {
    fail(`recorded source blob ${sourceSha}:${SOURCE_PACKAGE_PATH} is not valid JSON: ${error.message}`);
  }
  const lockText = lockBytes.toString("utf8");
  const zod = importerDependency(lockText, "packages/worker-protocol", "dependencies", "zod");
  const esbuild = importerDependency(lockText, ".", "devDependencies", "esbuild");
  if (!zod) fail(`recorded source blob ${sourceSha}:${SOURCE_LOCK_PATH} lacks packages/worker-protocol dependencies.zod evidence`);
  if (!esbuild) fail(`recorded source blob ${sourceSha}:${SOURCE_LOCK_PATH} lacks root devDependencies.esbuild evidence`);

  if (sourcePackage && sourcePackage.dependencies?.zod !== zod?.specifier) {
    fail(`source package zod specifier ${sourcePackage.dependencies?.zod} != source lock snapshot ${zod?.specifier}`);
  }
  if (zod && dependencyLock.zodVersion !== zod.version) {
    fail(`${LOCK_NAME}: recorded zodVersion ${dependencyLock.zodVersion} != source snapshot ${zod.version}`);
  }
  if (esbuild && dependencyLock.esbuildVersion !== esbuild.version) {
    fail(`${LOCK_NAME}: recorded esbuildVersion ${dependencyLock.esbuildVersion} != source snapshot ${esbuild.version}`);
  }

  return {
    errors,
    zodVersion: zod?.version,
    esbuildVersion: esbuild?.version,
    sourceTreeOid,
  };
}

function frozenAnchorEntries(repoRoot, anchorSha) {
  const result = runVerificationGit(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", anchorSha, "--", FIXTURE_PATH]);
  if (result.status !== 0) throw new Error(`immutable freeze anchor tree ${anchorSha}:${FIXTURE_PATH} is unavailable`);

  const prefix = `${FIXTURE_PATH}/`;
  const entries = [];
  for (const record of result.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\S+) ([0-9a-f]+)\t(.+)$/.exec(record);
    if (!match || !match[4].startsWith(prefix)) throw new Error(`immutable freeze anchor contains an invalid tree record: ${record}`);
    if (match[2] !== "blob") throw new Error(`immutable freeze anchor contains non-blob entry: ${match[4]}`);
    entries.push({ mode: match[1], oid: match[3], rel: match[4].slice(prefix.length) });
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
  return entries;
}

/** Authenticate every current frozen fixture byte against the separate E1
 * freeze commit whose sole parent is the recorded source revision. All Git
 * lookups ignore replacement objects. */
export function verifyFrozenConsumerAnchor({
  repoRoot,
  dir,
  sourceSha,
  anchorSha = FROZEN_FIXTURE_ANCHOR_SHA,
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!repoRoot || !dir || !sourceSha || !anchorSha) return { errors: ["freeze anchor verification inputs are incomplete"] };

  if (replacementRefExists(repoRoot, anchorSha)) {
    return { errors: [`replacement ref exists for immutable freeze anchor commit ${anchorSha}; remove refs/replace/${anchorSha} and retry`] };
  }
  const anchorType = gitObjectType(repoRoot, anchorSha);
  if (anchorType === null) {
    return { errors: [`immutable freeze anchor commit ${anchorSha} is unavailable; fetch the E1 freeze revision and retry`] };
  }
  if (anchorType !== "commit") return { errors: [`immutable freeze anchor object ${anchorSha} is ${anchorType}; expected commit`] };

  let anchorCommitBytes;
  try {
    anchorCommitBytes = readGitObject(
      repoRoot,
      "commit",
      anchorSha,
      `immutable freeze anchor commit ${anchorSha} is unavailable; fetch the E1 freeze revision and retry`,
    );
  } catch (error) {
    return { errors: [error.message] };
  }
  const parents = [...anchorCommitBytes.toString("utf8").matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1]);
  if (parents.length !== 1 || parents[0] !== sourceSha) {
    fail(`immutable freeze anchor ${anchorSha} must have recorded source ${sourceSha} as its sole parent`);
  }

  const anchorFixtureObject = `${anchorSha}:${FIXTURE_PATH}`;
  const fixtureTreeOid = gitObjectType(repoRoot, anchorFixtureObject) === "tree"
    ? resolveGitObject(repoRoot, anchorFixtureObject)
    : null;
  if (!fixtureTreeOid) {
    fail(`immutable freeze anchor tree ${anchorFixtureObject} is unavailable`);
    return { errors };
  }

  let anchorEntries;
  try {
    anchorEntries = frozenAnchorEntries(repoRoot, anchorSha);
  } catch (error) {
    fail(error.message);
    return { errors, fixtureTreeOid };
  }

  let currentEntries;
  try {
    currentEntries = walkPosix(dir, "", []).sort((a, b) => a.rel.localeCompare(b.rel, "en"));
  } catch (error) {
    fail(`cannot enumerate frozen fixture for immutable authentication: ${error.message}`);
    return { errors, fixtureTreeOid };
  }
  const anchorPaths = anchorEntries.map((entry) => entry.rel);
  const currentPaths = currentEntries.map((entry) => entry.rel);
  if (JSON.stringify(currentPaths) !== JSON.stringify(anchorPaths)) {
    fail(`frozen fixture path set does not match immutable freeze anchor ${anchorSha}`);
    return { errors, fixtureTreeOid };
  }

  for (let index = 0; index < anchorEntries.length; index += 1) {
    const anchorEntry = anchorEntries[index];
    if (currentEntries[index].symlink) continue;
    let anchorBytes;
    try {
      anchorBytes = readGitObject(
        repoRoot,
        "blob",
        anchorEntry.oid,
        `immutable freeze anchor blob ${anchorEntry.oid} for ${anchorEntry.rel} is unavailable`,
      );
    } catch (error) {
      fail(error.message);
      continue;
    }
    const currentBytes = fs.readFileSync(path.join(dir, anchorEntry.rel));
    if (Buffer.compare(currentBytes, anchorBytes) !== 0) {
      fail(`frozen fixture ${anchorEntry.rel} does not match immutable freeze anchor ${anchorSha}`);
    }
  }

  return { errors, fixtureTreeOid };
}

// --- Isolated smoke import (CLI only) ----------------------------------------

export function smokeImport(role, indexUrl, { timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
  const code = `
    for (const key of Object.keys(process.env)) delete process.env[key];
    const m = await import(${JSON.stringify(indexUrl)});
    const required = ["jobEnvelopeV1Schema", "enrollmentRequestV1Schema", "controlCommandV1Schema", "protocolErrorV1Schema", "PROTOCOL_VERSION"];
    for (const name of required) {
      if (!(name in m)) { console.error("[${role}] missing export " + name); process.exit(2); }
    }
    const parsed = m.protocolErrorCodeSchema.safeParse("stale_fence");
    if (!parsed.success) { console.error("[${role}] frozen zod runtime failed to parse"); process.exit(3); }
    if (m.PROTOCOL_VERSION !== 1) { console.error("[${role}] unexpected PROTOCOL_VERSION"); process.exit(4); }
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.dirname(fileURLToPath(indexUrl)),
    encoding: "utf8",
    env: {},
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: SMOKE_MAX_OUTPUT_BYTES,
  });
  if (res.error?.code === "ETIMEDOUT") {
    return `[${role}] frozen-root smoke import timed out after ${timeoutMs}ms and was terminated`;
  }
  if (res.error) {
    return `[${role}] frozen-root smoke import could not complete: ${res.error.message}`;
  }
  if (res.status !== 0) {
    return `[${role}] frozen-root smoke import failed (exit ${res.status}, signal ${res.signal || "none"}): ${(res.stderr || res.stdout || "").trim()}`;
  }
  return null;
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const i = argv.indexOf("--source-sha");
  const sourceSha = i !== -1 ? argv[i + 1] : undefined;
  return { sourceSha };
}

function exitWithFailures(errors) {
  console.error("frozen worker-protocol v1 consumer verification FAILED:");
  for (const line of errors) console.error(`  ${line}`);
  process.exit(1);
}

async function main() {
  const repoRoot = process.cwd();
  const { sourceSha } = parseArgs(process.argv.slice(2));
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    console.error("usage: node scripts/check-frozen-worker-protocol-consumer.mjs --source-sha <40-hex>");
    process.exit(1);
  }
  const dir = path.join(repoRoot, ...FIXTURE_SEGMENTS);

  const { errors } = verifyFrozenConsumerStatic({
    dir,
    sourceSha,
    repoRoot,
  });
  let dependencyLock;
  try {
    dependencyLock = JSON.parse(fs.readFileSync(path.join(dir, LOCK_NAME), "utf8"));
  } catch {
    // Static verification already reports a missing or malformed lock precisely.
  }
  const sourceEvidence = dependencyLock
    ? verifyFrozenConsumerSourceSnapshot({ repoRoot, sourceSha, dependencyLock })
    : { errors: [] };
  errors.push(...sourceEvidence.errors);
  const anchorEvidence = verifyFrozenConsumerAnchor({
    repoRoot,
    dir,
    sourceSha,
  });
  errors.push(...anchorEvidence.errors);

  // Never import or execute fixture bytes until every static, dependency,
  // source-object, and external-anchor check has authenticated them.
  if (errors.length > 0) exitWithFailures(errors);

  const indexUrl = pathToFileURL(path.join(dir, "dist", "index.js")).href;
  for (const role of ["server", "worker"]) {
    const err = smokeImport(role, indexUrl);
    if (err) errors.push(err);
  }

  if (errors.length > 0) exitWithFailures(errors);
  console.log(`frozen worker-protocol v1 consumer: OK (sourceSha ${sourceSha}, zod ${sourceEvidence.zodVersion}, esbuild ${sourceEvidence.esbuildVersion})`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
