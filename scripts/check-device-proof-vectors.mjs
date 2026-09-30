#!/usr/bin/env node
/**
 * check-device-proof-vectors.mjs
 *
 * Independent reference verifier for the neutral shared device-proof
 * canonicalization fixture `tests/fixtures/device-proof/v1/vectors.json`
 * (JOB-002 / E4-F001). This checker owns a THIRD, from-scratch implementation
 * of the AOA-DEVICE-PROOF-V1 canonicalization, independent of both the server
 * verify-side (`server/src/services/worker-device-proof.ts`) and the worker
 * sign-side (WRK-002). It re-derives the canonical string for every positive
 * vector and asserts byte-equality with the stored value, and asserts every
 * `rejectInputs` entry is rejected. Because three independent implementations
 * (server, worker, this reference) all pin to one fixture, a single consumer
 * cannot silently diverge, and the fixture itself cannot drift from the
 * algorithm without failing here.
 *
 * The verification helpers are exported for the dependency-free node:test
 * corpus (`check-device-proof-vectors.test.mjs`), which mutates isolated
 * in-memory copies and never touches the checked-in fixture.
 *
 * Usage:
 *   node scripts/check-device-proof-vectors.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FIXTURE_SEGMENTS = ["tests", "fixtures", "device-proof", "v1", "vectors.json"];
export const DEVICE_PROOF_PREFIX = "AOA-DEVICE-PROOF-V1";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROOF_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Thrown by the reference canonicalizer for any invalid input. */
export class DeviceProofReferenceError extends Error {}

/**
 * Reference AOA-DEVICE-PROOF-V1 canonicalization. Deliberately re-derived from
 * the documented field contract, NOT imported from the server, so it can catch
 * a fixture that agrees with a drifted server implementation.
 */
export function referenceCanonical(input) {
  if (typeof input !== "object" || input === null) throw new DeviceProofReferenceError("input not object");
  const { method, path: rawPath, bodyDigest, correlationId, issuedAt, proofId } = input;
  for (const [k, v] of Object.entries({ method, path: rawPath, bodyDigest, correlationId, issuedAt, proofId })) {
    if (typeof v !== "string") throw new DeviceProofReferenceError(`field ${k} is not a string`);
  }
  if (!SHA256_HEX.test(bodyDigest)) throw new DeviceProofReferenceError("bodyDigest not sha256 hex");
  if (!PROOF_ID.test(proofId)) throw new DeviceProofReferenceError("proofId not in pattern");
  if (correlationId.length === 0 || correlationId.includes("\n")) throw new DeviceProofReferenceError("correlationId empty or has newline");
  if (issuedAt.includes("\n")) throw new DeviceProofReferenceError("issuedAt has newline");
  let normalizedPath;
  try {
    const parsed = new URL(rawPath, "https://aoa.invalid");
    if (parsed.origin !== "https://aoa.invalid") throw new DeviceProofReferenceError("path resolves to foreign origin");
    normalizedPath = parsed.pathname;
  } catch (error) {
    if (error instanceof DeviceProofReferenceError) throw error;
    throw new DeviceProofReferenceError("path is not parseable");
  }
  return [
    DEVICE_PROOF_PREFIX,
    method.toUpperCase(),
    normalizedPath,
    bodyDigest,
    correlationId,
    issuedAt,
    proofId,
  ].join("\n");
}

/** Validate a parsed fixture object; return the number of positive vectors. Throws on any problem. */
export function verifyFixture(fixture) {
  const problems = [];
  if (fixture?.version !== "1") problems.push(`version must be "1", got ${JSON.stringify(fixture?.version)}`);
  if (fixture?.prefix !== DEVICE_PROOF_PREFIX) problems.push(`prefix must be ${DEVICE_PROOF_PREFIX}`);
  const positives = Array.isArray(fixture?.canonicalVectors) ? fixture.canonicalVectors : null;
  if (!positives || positives.length === 0) problems.push("canonicalVectors must be a non-empty array");
  const rejects = Array.isArray(fixture?.rejectInputs) ? fixture.rejectInputs : null;
  if (!rejects) problems.push("rejectInputs must be an array");

  const seenNames = new Set();
  for (const [i, v] of (positives ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seenNames.has(v.name)) problems.push(`positive vector ${label}: missing or duplicate name`);
    seenNames.add(v?.name);
    if (typeof v?.canonical !== "string") { problems.push(`positive vector ${label}: canonical must be a string`); continue; }
    // The prefix must be the first line and there must be exactly 7 fields.
    if (!v.canonical.startsWith(`${DEVICE_PROOF_PREFIX}\n`)) problems.push(`positive vector ${label}: canonical must start with the prefix line`);
    if (v.canonical.split("\n").length !== 7) problems.push(`positive vector ${label}: canonical must have exactly 7 newline-joined fields`);
    let derived;
    try {
      derived = referenceCanonical(v.input);
    } catch (error) {
      problems.push(`positive vector ${label}: reference canonicalizer rejected a positive input: ${error.message}`);
      continue;
    }
    if (derived !== v.canonical) {
      problems.push(`positive vector ${label}: stored canonical does not match the reference derivation`);
    }
  }

  for (const [i, r] of (rejects ?? []).entries()) {
    const label = r?.name ?? `#${i}`;
    if (!r?.name || seenNames.has(r.name)) problems.push(`reject input ${label}: missing or duplicate name`);
    seenNames.add(r?.name);
    let threw = false;
    try {
      referenceCanonical(r?.input);
    } catch {
      threw = true;
    }
    if (!threw) problems.push(`reject input ${label}: reference canonicalizer ACCEPTED an input that must be rejected`);
  }

  if (problems.length > 0) {
    throw new DeviceProofReferenceError(`device-proof fixture invalid:\n - ${problems.join("\n - ")}`);
  }
  return positives.length;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadFixture(root = repoRoot()) {
  const file = path.join(root, ...FIXTURE_SEGMENTS);
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

function main() {
  let fixture;
  try {
    fixture = loadFixture();
  } catch (error) {
    console.error(`device-proof vectors: FAIL — cannot read/parse fixture: ${error.message}`);
    process.exit(1);
  }
  try {
    const count = verifyFixture(fixture);
    console.log(`device-proof vectors: PASS (${count} canonical vectors, ${fixture.rejectInputs.length} reject inputs)`);
  } catch (error) {
    console.error(`device-proof vectors: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
