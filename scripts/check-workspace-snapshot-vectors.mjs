#!/usr/bin/env node
/**
 * check-workspace-snapshot-vectors.mjs
 *
 * Independent reference verifier for the frozen workspace-snapshot hash fixture
 * `tests/fixtures/workspace-snapshot/v1/vectors.json` (DAT-001). This checker
 * owns a THIRD, from-scratch implementation of BOTH pinned digests:
 *
 *   - `contentRevision` — for a `content_manifest` base, the sha256 of the
 *     canonicalized `{v:1, caseMode, ignorePolicy, inclusion, entries}` subset
 *     (excludes capture metadata + dirty ⇒ repeatable); for a `git_commit` base
 *     it IS `base.revision` (the git HEAD sha).
 *   - `manifestHash` — the sha256 of the canonicalized full manifest.
 *
 * The canonicalizer here is re-derived from the RFC-8785 (subset) contract, NOT
 * imported from `@armyofagents/worker-protocol`, so it catches a fixture that
 * agrees with a drifted producer canonicalizer. It also re-implements the
 * fail-closed structural validation (`isSafeWorkspacePath`, directory invariants,
 * case-collision, algorithm↔revision format, entry cap) so every `rejectInputs`
 * entry is proven rejected. Because two independent implementations (the producer
 * and this reference) pin to one fixture, neither can silently diverge.
 *
 * The helpers are exported for the dependency-free node:test corpus
 * (`check-workspace-snapshot-vectors.test.mjs`), which mutates isolated in-memory
 * copies and never touches the checked-in fixture.
 *
 * Usage:
 *   node scripts/check-workspace-snapshot-vectors.mjs
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FIXTURE_SEGMENTS = ["tests", "fixtures", "workspace-snapshot", "v1", "vectors.json"];
export const SCHEMA_MAX_ENTRIES = 1_000_000;

/** Thrown by the reference derivation/validation for any invalid input. */
export class SnapshotVectorError extends Error {}

// --- from-scratch RFC-8785 (subset) canonicalizer ----------------------------

function canonicalizeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) throw new SnapshotVectorError("lone high surrogate");
      out += str[i] + str[i + 1];
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new SnapshotVectorError("lone low surrogate");
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += str[i];
  }
  return `${out}"`;
}

function canonicalizeNumber(num) {
  if (!Number.isFinite(num)) throw new SnapshotVectorError("non-finite number");
  if (!Number.isInteger(num)) throw new SnapshotVectorError("float not allowed");
  if (!Number.isSafeInteger(num)) throw new SnapshotVectorError("unsafe integer");
  if (Object.is(num, -0)) return "0";
  return String(num);
}

/** Reference canonicalization; keys sorted by UTF-16 code units (JS default sort). */
export function referenceCanonicalize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return canonicalizeNumber(value);
  if (t === "string") return canonicalizeString(value);
  if (Array.isArray(value)) return `[${value.map((item) => referenceCanonicalize(item)).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${canonicalizeString(key)}:${referenceCanonicalize(value[key])}`).join(",")}}`;
  }
  throw new SnapshotVectorError(`unsupported value of type ${t}`);
}

export function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// --- from-scratch structural validation (mirrors the frozen schema) ----------

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Re-derived path-safety predicate (mirrors worker-protocol `isSafeWorkspacePath`). */
export function isSafeWorkspacePath(p) {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > 4096) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  if (p.includes(":")) return false;
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  for (const seg of p.split("/")) {
    if (seg.length === 0) return false;
    if (seg === "." || seg === "..") return false;
    if (seg.length > 255) return false;
  }
  return true;
}

function utf8Compare(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

/** Validate a manifest's structure fail-closed; throws on any violation. */
export function validateManifestStructure(manifest) {
  if (typeof manifest !== "object" || manifest === null) throw new SnapshotVectorError("manifest not an object");
  if (manifest.protocolVersion !== 1) throw new SnapshotVectorError("protocolVersion must be 1");
  const base = manifest.base;
  if (typeof base !== "object" || base === null) throw new SnapshotVectorError("base missing");
  if (base.kind !== "git_commit" && base.kind !== "content_manifest") throw new SnapshotVectorError("bad base.kind");
  if (!["git_sha1", "git_sha256", "sha256"].includes(base.algorithm)) throw new SnapshotVectorError("bad algorithm");
  if (base.dirty !== true && base.dirty !== false) throw new SnapshotVectorError("bad dirty");
  if (base.caseMode !== "sensitive" && base.caseMode !== "insensitive_preserving") throw new SnapshotVectorError("bad caseMode");
  const revRe = base.algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (typeof base.revision !== "string" || !revRe.test(base.revision)) throw new SnapshotVectorError("revision format vs algorithm");
  const ip = base.ignorePolicy;
  if (typeof ip !== "object" || ip === null) throw new SnapshotVectorError("ignorePolicy missing");
  if (ip.kind !== "gitignore_plus_aoa" && ip.kind !== "explicit") throw new SnapshotVectorError("bad ignorePolicy.kind");
  if (typeof ip.digest !== "string" || !SHA256_HEX.test(ip.digest)) throw new SnapshotVectorError("bad ignorePolicy.digest");
  const inc = base.inclusion;
  if (typeof inc !== "object" || inc === null) throw new SnapshotVectorError("inclusion missing");
  if (inc.tracked !== true) throw new SnapshotVectorError("inclusion.tracked must be true");
  if (inc.untracked !== "include" && inc.untracked !== "exclude") throw new SnapshotVectorError("bad inclusion.untracked");
  if (inc.ignored !== false) throw new SnapshotVectorError("inclusion.ignored must be false");

  const entries = manifest.entries;
  if (!Array.isArray(entries)) throw new SnapshotVectorError("entries not an array");
  if (entries.length > SCHEMA_MAX_ENTRIES) throw new SnapshotVectorError("too many entries");
  const seen = new Set();
  const seenLower = new Set();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) throw new SnapshotVectorError("entry not an object");
    if (!isSafeWorkspacePath(entry.path)) throw new SnapshotVectorError(`unsafe path: ${entry.path}`);
    if (entry.kind !== "file" && entry.kind !== "directory") throw new SnapshotVectorError("bad entry.kind (symlink not representable)");
    if (!["tracked", "untracked", "generated"].includes(entry.provenance)) throw new SnapshotVectorError("bad provenance");
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) throw new SnapshotVectorError("bad sizeBytes");
    if (entry.kind === "file") {
      if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) throw new SnapshotVectorError("file needs content hash");
      if (typeof entry.executable !== "boolean") throw new SnapshotVectorError("bad executable");
    } else {
      if (entry.sha256 !== null) throw new SnapshotVectorError("directory must have null hash");
      if (entry.sizeBytes !== 0) throw new SnapshotVectorError("directory must have zero size");
      if (entry.executable !== false) throw new SnapshotVectorError("directory not executable");
    }
    if (seen.has(entry.path)) throw new SnapshotVectorError(`duplicate path: ${entry.path}`);
    const lower = entry.path.toLowerCase();
    if (seenLower.has(lower)) throw new SnapshotVectorError(`case-colliding path: ${entry.path}`);
    seen.add(entry.path);
    seenLower.add(lower);
  }
  // Entry ordering must be the pinned UTF-8 byte order.
  for (let i = 1; i < entries.length; i += 1) {
    if (utf8Compare(entries[i - 1].path, entries[i].path) >= 0) {
      throw new SnapshotVectorError(`entries not sorted by UTF-8 byte order at index ${i}`);
    }
  }
}

// --- digest derivation -------------------------------------------------------

function pickEntry(entry) {
  return {
    path: entry.path,
    kind: entry.kind,
    provenance: entry.provenance,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    executable: entry.executable,
  };
}

/** Re-derive `contentRevision` for a manifest (content base → subset hash; git base → HEAD). */
export function deriveContentRevision(manifest) {
  const base = manifest.base;
  if (base.kind === "git_commit") return base.revision;
  return sha256Hex(
    referenceCanonicalize({
      v: 1,
      caseMode: base.caseMode,
      ignorePolicy: { kind: base.ignorePolicy.kind, digest: base.ignorePolicy.digest },
      inclusion: { tracked: base.inclusion.tracked, untracked: base.inclusion.untracked, ignored: base.inclusion.ignored },
      entries: manifest.entries.map(pickEntry),
    }),
  );
}

/** Re-derive `manifestHash` over the full manifest. */
export function deriveManifestHash(manifest) {
  return sha256Hex(referenceCanonicalize(manifest));
}

// --- fixture verification ----------------------------------------------------

export function verifyFixture(fixture) {
  const problems = [];
  if (fixture?.version !== "1") problems.push(`version must be "1", got ${JSON.stringify(fixture?.version)}`);
  if (fixture?.schema !== "aoa-workspace-snapshot-vectors/v1") problems.push("schema id mismatch");
  const positives = Array.isArray(fixture?.positiveVectors) ? fixture.positiveVectors : null;
  if (!positives || positives.length === 0) problems.push("positiveVectors must be a non-empty array");
  const rejects = Array.isArray(fixture?.rejectInputs) ? fixture.rejectInputs : null;
  if (!rejects) problems.push("rejectInputs must be an array");

  const seenNames = new Set();
  for (const [i, v] of (positives ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seenNames.has(v.name)) problems.push(`positive vector ${label}: missing or duplicate name`);
    seenNames.add(v?.name);
    if (typeof v?.contentRevision !== "string" || typeof v?.manifestHash !== "string") {
      problems.push(`positive vector ${label}: contentRevision/manifestHash must be strings`);
      continue;
    }
    try {
      validateManifestStructure(v.manifest);
    } catch (error) {
      problems.push(`positive vector ${label}: reference validator rejected a positive manifest: ${error.message}`);
      continue;
    }
    const cr = deriveContentRevision(v.manifest);
    const mh = deriveManifestHash(v.manifest);
    if (cr !== v.contentRevision) problems.push(`positive vector ${label}: stored contentRevision != reference derivation`);
    if (mh !== v.manifestHash) problems.push(`positive vector ${label}: stored manifestHash != reference derivation`);
    // For a content base, revision IS the contentRevision.
    if (v.manifest.base.kind === "content_manifest" && v.manifest.base.revision !== cr) {
      problems.push(`positive vector ${label}: content base revision must equal contentRevision`);
    }
  }

  for (const [i, r] of (rejects ?? []).entries()) {
    const label = r?.name ?? `#${i}`;
    if (!r?.name || seenNames.has(r.name)) problems.push(`reject input ${label}: missing or duplicate name`);
    seenNames.add(r?.name);
    let threw = false;
    try {
      validateManifestStructure(r?.manifest);
    } catch {
      threw = true;
    }
    if (!threw) problems.push(`reject input ${label}: reference validator ACCEPTED a manifest that must be rejected`);
  }

  if (problems.length > 0) {
    throw new SnapshotVectorError(`workspace-snapshot fixture invalid:\n - ${problems.join("\n - ")}`);
  }
  return positives.length;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadFixture(root = repoRoot()) {
  const file = path.join(root, ...FIXTURE_SEGMENTS);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  let fixture;
  try {
    fixture = loadFixture();
  } catch (error) {
    console.error(`workspace-snapshot vectors: FAIL — cannot read/parse fixture: ${error.message}`);
    process.exit(1);
  }
  try {
    const count = verifyFixture(fixture);
    console.log(`workspace-snapshot vectors: PASS (${count} positive vectors, ${fixture.rejectInputs.length} reject inputs)`);
  } catch (error) {
    console.error(`workspace-snapshot vectors: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
