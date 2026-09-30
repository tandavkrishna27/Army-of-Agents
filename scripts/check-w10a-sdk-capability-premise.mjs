#!/usr/bin/env node
/**
 * check-w10a-sdk-capability-premise.mjs
 *
 * A NEGATIVE CAPABILITY CLAIM ABOUT A DEPENDENCY IS A CLAIM, AND NOTHING CHECKED ONE.
 *
 * The programme recorded "managed-E2B egress is not fully lockable" as settled fact in six
 * tracked files — including a production code comment beside the only call that could have
 * carried the configuration, and inside `E8-F003`'s own reasoning, where it supplied the
 * premise for "option (b) is unavailable". The installed, lockfile-pinned `e2b@2.30.5`
 * contradicts it. See `E8-F007` and `scripts/w10a-sdk-capability-premise.json`.
 *
 * This guard does NOT assert that egress enforcement works — nobody has run it. It asserts
 * that the CAPABILITY IS PRESENT IN THE INSTALLED ARTIFACT, and that while it is, the
 * refuted sentence cannot be reintroduced without a correction marker beside it.
 *
 * Usage:
 *   node scripts/check-w10a-sdk-capability-premise.mjs                # lockfile + tree
 *   node scripts/check-w10a-sdk-capability-premise.mjs --require-sdk  # + live SDK surface
 *   node scripts/check-w10a-sdk-capability-premise.mjs --list         # what matched, and where
 *
 * `--require-sdk` is how the dependency-installing lane runs it. The dependency-free `policy`
 * lane runs it without, and REPORTS that the surface was not measured there — it never counts
 * an unmeasurable half as a pass.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  evaluateSdkCapabilityPremise,
  scanTextForStaleClaims,
} from "./lib/w10a-sdk-capability-premise.mjs";

export const MANIFEST_RELATIVE_PATH = "scripts/w10a-sdk-capability-premise.json";

/** Extensions the tree scan reads. Deliberately a list, so a new binary format cannot make
 * the scan silently slower or noisier; a format not on it is not scanned, and that is stated
 * in the `--list` output rather than left for a reader to discover. */
export const SCANNED_EXTENSIONS = Object.freeze([
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".sql",
  ".sh",
  ".txt",
]);

export function loadManifest(root) {
  const file = path.join(root, MANIFEST_RELATIVE_PATH);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Versions the lockfile resolves for a package name.
 *
 * Reads the `<name>@<version>:` keys of the `packages:`/`snapshots:` sections. Importer
 * entries (`  e2b:` with a nested `specifier`/`version`) are deliberately NOT read: they
 * carry the RANGE, and a range is not what was measured.
 *
 * @returns {string[]|null} null when there is no lockfile to read.
 */
export function readLockfileVersions(root, name) {
  const file = path.join(root, "pnpm-lock.yaml");
  if (!existsSync(file)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s{2}${escaped}@([^:@\\s]+):\\s*$`, "gm");
  const out = new Set();
  for (const match of readFileSync(file, "utf8").matchAll(pattern)) out.add(match[1]);
  return [...out].sort();
}

/**
 * Resolve the installed package from each declaring workspace manifest and check the declared
 * surface markers against what is actually on disk.
 *
 * Resolution is from the packages that DECLARE the dependency, not from the repo root: a pnpm
 * workspace does not hoist it to the root, and resolving from the root would have reported
 * "not installed" on a fully installed tree — an unmeasurable half dressed as a measured one.
 *
 * @returns {null | {version: string|null, resolvedFrom: Record<string,string|null>,
 *                   missingMarkers: Array<{file: string, needle: string}>, packageDir: string|null}}
 */
export function measureSdkSurface(root, manifest) {
  const name = manifest.package;
  const from = Array.isArray(manifest.resolveFrom) ? manifest.resolveFrom : [];
  const resolvedFrom = {};
  let packageDir = null;

  for (const rel of from) {
    const base = path.join(root, rel);
    let resolved = null;
    if (existsSync(base)) {
      try {
        resolved = createRequire(base).resolve(`${name}/package.json`);
      } catch {
        resolved = null;
      }
    }
    resolvedFrom[rel] = resolved;
    if (resolved && packageDir === null) packageDir = path.dirname(resolved);
  }

  if (packageDir === null) return null;

  let version = null;
  try {
    version = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version ?? null;
  } catch {
    version = null;
  }

  const missingMarkers = [];
  const cache = new Map();
  for (const marker of Array.isArray(manifest.surfaceMarkers) ? manifest.surfaceMarkers : []) {
    if (!marker || typeof marker.file !== "string" || typeof marker.needle !== "string") continue;
    if (!cache.has(marker.file)) {
      const abs = path.join(packageDir, marker.file);
      cache.set(
        marker.file,
        existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null,
      );
    }
    const text = cache.get(marker.file);
    if (text === null || !text.includes(marker.needle)) {
      missingMarkers.push({ file: marker.file, needle: marker.needle });
    }
  }

  return { version, resolvedFrom, missingMarkers, packageDir };
}

/** Tracked files only — `git ls-files`. An untracked scratch file is not the record. */
export function listTrackedFiles(root) {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((f) => f.length > 0);
}

/**
 * ★ THE DECLARATION IS NOT THE RECORD, and this exclusion is load-bearing rather than tidy.
 *
 * The manifest stores each ban as a regex SOURCE STRING, and quotes the sentence it bans in
 * that pattern's `why`. Scanning it made the `pattern_matches_nothing` clause VACUOUS, and
 * that was MEASURED, not reasoned: mutating the pattern to a token appearing nowhere in the
 * record left the guard GREEN with "1 quotation … all marked", because the mutated pattern
 * matched its own declaration — a ban that had stopped banning anything, reporting success.
 * With the manifest out of the scan the same mutation goes red, which is the state pinned by
 * the "MANIFEST is not scanned" case in the self-test. A guard may not be its own evidence.
 */
export const SCAN_EXCLUDED_FILES = Object.freeze([MANIFEST_RELATIVE_PATH]);

export function scanTree(root, manifest, files) {
  const opts = {
    patterns: manifest.stalePatterns,
    markers: manifest.correctionMarkers,
    contextWindowLines: manifest.contextWindowLines,
  };
  const out = [];
  for (const rel of files) {
    if (SCAN_EXCLUDED_FILES.includes(rel.split(path.sep).join("/"))) continue;
    if (!SCANNED_EXTENSIONS.includes(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(root, rel);
    let text;
    try {
      if (!statSync(abs).isFile()) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const hit of scanTextForStaleClaims(text, opts)) out.push({ file: rel, ...hit });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const EXPLAIN = {
  malformed_input: "internal: the evaluator was handed something it could not read",
  malformed_declaration: "the declaration manifest is not usable",
  lockfile_not_measured: "internal: no lockfile was read",
  lockfile_package_absent: "the lockfile no longer resolves the package the declaration measured",
  lockfile_version_ambiguous: "the lockfile resolves several versions — re-measure and declare one",
  lockfile_version_mismatch:
    "the dependency moved. The surface declaration is true OF A VERSION; re-read the resolved package and update measuredVersion + surfaceMarkers together",
  sdk_not_resolvable: "the dependency could not be resolved in a lane that must measure it",
  sdk_version_mismatch: "the resolved package is not the version the declaration measured",
  sdk_surface_missing:
    "a declared capability marker is GONE from the installed package — the declaration no longer describes the artifact, and the ban it justifies is suspended until it is re-derived",
  pattern_matches_nothing: "a declared ban pattern matches nothing — a check that nothing runs",
  stale_claim_unmarked:
    "a tracked file asserts the refuted premise with no correction marker near it",
};

export function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

/** The whole CLI minus process exit + printing, so the self-test can drive it on a fixture
 * repository rather than on this one. A guard whose only proof is "it is green on the tree
 * it was written against" has never been observed red. */
export function runPremiseCheck(root, { requireSdk = false } = {}) {
  const manifest = loadManifest(root);
  if (manifest === null) return { manifest: null, result: null, occurrences: [], sdkSurface: null, lockfileVersions: null };

  const lockfileVersions =
    typeof manifest.package === "string" ? readLockfileVersions(root, manifest.package) : null;
  const sdkSurface = typeof manifest.package === "string" ? measureSdkSurface(root, manifest) : null;
  const occurrences =
    Array.isArray(manifest.stalePatterns) && manifest.stalePatterns.length > 0
      ? scanTree(root, manifest, listTrackedFiles(root))
      : [];

  const result = evaluateSdkCapabilityPremise({
    declaration: manifest,
    lockfileVersions,
    sdkSurface,
    occurrences,
    requireSdk,
  });
  return { manifest, result, occurrences, sdkSurface, lockfileVersions };
}

function main() {
  const root = resolveRoot(process.argv.slice(2));
  const requireSdk = process.argv.includes("--require-sdk");
  const list = process.argv.includes("--list");

  const { manifest, result, occurrences, sdkSurface, lockfileVersions } = runPremiseCheck(root, {
    requireSdk,
  });
  if (manifest === null) {
    console.error(
      `sdk-capability-premise: ${MANIFEST_RELATIVE_PATH} is missing or not valid JSON.\n` +
        "The guard REFUSES rather than passing: without the declaration it cannot tell a\n" +
        "held capability from a lost one, and either answer would be invented.",
    );
    process.exit(1);
  }

  if (list) {
    console.log(`package        ${manifest.package}@${manifest.measuredVersion}`);
    console.log(`lockfile       ${lockfileVersions ? lockfileVersions.join(", ") : "(unread)"}`);
    console.log(
      `sdk surface    ${
        sdkSurface
          ? `measured at ${sdkSurface.packageDir} (${sdkSurface.missingMarkers.length} marker(s) missing)`
          : "NOT MEASURED — dependency not installed in this lane"
      }`,
    );
    console.log(`scanned        ${SCANNED_EXTENSIONS.join(" ")}`);
    console.log(`occurrences    ${occurrences.length}`);
    for (const o of occurrences) {
      console.log(`  ${o.marked ? "marked  " : "UNMARKED"} ${o.file}:${o.line}  ${o.excerpt}`);
    }
  }

  for (const note of result.notes) console.log(`sdk-capability-premise: NOTE — ${note}`);

  if (!result.ok) {
    console.error("\nsdk-capability-premise: the record and the installed dependency disagree.\n");
    for (const p of result.problems) {
      console.error(`  - ${EXPLAIN[p.kind] ?? p.kind}${p.detail ? `\n      ${p.detail}` : ""}`);
    }
    console.error(
      "\nWhat this guard is for: 'managed-E2B egress is not fully lockable' (E8-F007) was\n" +
        "recorded as fact in six tracked files for a year while the installed SDK exposed\n" +
        "SandboxOpts.network, updateNetwork and a getInfo() read-back. If you are quoting that\n" +
        "sentence to correct it, keep a correction marker within " +
        `${manifest.contextWindowLines ?? 6} lines. If you are asserting it, do not: the\n` +
        "capability exists in the artifact. Whether the operator's tier HONOURS it is a\n" +
        "separate, open measurement — and saying that is always green here.",
    );
    process.exit(1);
  }

  console.log(
    `sdk-capability-premise: OK — ${manifest.package}@${manifest.measuredVersion} still exposes ` +
      `${(manifest.surfaceMarkers ?? []).length} declared capability marker(s)` +
      `${result.sdkMeasured ? " (measured live)" : " (surface not measured in this lane)"}; ` +
      `${result.occurrenceCount} quotation(s) of the refuted premise, all marked.`,
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
