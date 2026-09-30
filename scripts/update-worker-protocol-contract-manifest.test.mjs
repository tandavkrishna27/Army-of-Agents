/**
 * update-worker-protocol-contract-manifest.test.mjs
 *
 * Dependency-free `node:test` corpus for the deterministic manifest generator.
 * It uses isolated in-memory byte inputs (no filesystem writes) and proves:
 *   - valid UTF-8/LF bytes produce the SAME digest independent of host OS;
 *   - CRLF, lone CR, BOM, invalid UTF-8, and a missing final LF all fail;
 *   - Windows-style / non-POSIX paths fail;
 *   - altered bytes and a stale/unsorted manifest all fail (byte inequality);
 *   - the generator never hashes `manifest.sha256` into itself.
 *
 * Run: node --test scripts/update-worker-protocol-contract-manifest.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  MANIFEST_FILE,
  buildManifestBytes,
  validateContractTextBytes,
} from "./update-worker-protocol-contract-manifest.mjs";

const enc = (text) => new TextEncoder().encode(text);
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toText = (bytes) => new TextDecoder("utf-8").decode(bytes);

const VALID = enc('{"contractVersion":"1.0.0"}\n');

test("valid UTF-8/LF bytes hash deterministically (host-OS independent)", () => {
  const a = buildManifestBytes([{ file: "conformance.json", bytes: VALID }]);
  const b = buildManifestBytes([{ file: "conformance.json", bytes: VALID }]);
  assert.deepEqual(a, b);
  // The manifest line is exactly `<hex>  <file>\n`.
  assert.equal(toText(a), `${sha256hex(VALID)}  conformance.json\n`);
});

test("multibyte UTF-8 content is byte-stable and correctly hashed", () => {
  const content = enc('{"note":"café — 🚀"}\n');
  const manifest = buildManifestBytes([{ file: "conformance.json", bytes: content }]);
  assert.equal(toText(manifest), `${sha256hex(content)}  conformance.json\n`);
});

test("sorting is stable regardless of input order (POSIX localeCompare)", () => {
  const a = buildManifestBytes([
    { file: "b.json", bytes: enc("b\n") },
    { file: "a.json", bytes: enc("a\n") },
  ]);
  const b = buildManifestBytes([
    { file: "a.json", bytes: enc("a\n") },
    { file: "b.json", bytes: enc("b\n") },
  ]);
  assert.deepEqual(a, b);
  const lines = toText(a).trimEnd().split("\n");
  assert.equal(lines[0].endsWith("  a.json"), true);
  assert.equal(lines[1].endsWith("  b.json"), true);
});

test("CRLF is rejected", () => {
  assert.throws(() => validateContractTextBytes("conformance.json", enc('{"a":1}\r\n')), /CR\/CRLF is forbidden/);
  assert.throws(() => buildManifestBytes([{ file: "conformance.json", bytes: enc("a\r\n") }]), /CR\/CRLF is forbidden/);
});

test("a lone CR is rejected", () => {
  assert.throws(() => validateContractTextBytes("conformance.json", enc("a\rb\n")), /CR\/CRLF is forbidden/);
});

test("a UTF-8 BOM is rejected", () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("a\n")]);
  assert.throws(() => validateContractTextBytes("conformance.json", withBom), /BOM is forbidden/);
});

test("invalid UTF-8 is rejected", () => {
  const invalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x0a]); // { <0xff> <0xfe> \n
  assert.throws(() => validateContractTextBytes("conformance.json", invalid), /./);
});

test("a missing final LF is rejected", () => {
  assert.throws(() => validateContractTextBytes("conformance.json", enc('{"a":1}')), /final LF is required/);
});

test("Windows-style / non-POSIX paths are rejected", () => {
  assert.throws(() => validateContractTextBytes("sub\\conformance.json", VALID), /non-POSIX contract path/);
  assert.throws(() => validateContractTextBytes("sub/conformance.json", VALID), /non-POSIX contract path/);
});

test("the generator never hashes the manifest into itself", () => {
  assert.throws(() => validateContractTextBytes(MANIFEST_FILE, VALID), /must never hash itself/);
  assert.throws(
    () => buildManifestBytes([{ file: MANIFEST_FILE, bytes: enc("deadbeef  conformance.json\n") }]),
    /must never hash itself/,
  );
});

test("duplicate contract files are rejected", () => {
  assert.throws(
    () =>
      buildManifestBytes([
        { file: "conformance.json", bytes: VALID },
        { file: "conformance.json", bytes: VALID },
      ]),
    /duplicate contract file/,
  );
});

test("altered bytes change the manifest (tamper-evident)", () => {
  const original = buildManifestBytes([{ file: "conformance.json", bytes: VALID }]);
  const altered = buildManifestBytes([{ file: "conformance.json", bytes: enc('{"contractVersion":"1.0.1"}\n') }]);
  assert.notDeepEqual(original, altered);
});

test("a stale / unsorted manifest fails a byte comparison against the fresh build", () => {
  const fresh = buildManifestBytes([
    { file: "a.json", bytes: enc("a\n") },
    { file: "b.json", bytes: enc("b\n") },
  ]);
  // A hand-authored manifest with the lines in the wrong (unsorted) order.
  const lines = toText(fresh).trimEnd().split("\n");
  const unsorted = enc(`${lines[1]}\n${lines[0]}\n`);
  assert.equal(Buffer.compare(Buffer.from(fresh), Buffer.from(unsorted)) !== 0, true);
});
