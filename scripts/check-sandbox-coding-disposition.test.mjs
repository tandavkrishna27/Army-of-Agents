/**
 * Unit tests for the pure CLI-002 disposition-coverage policy logic
 * (`scripts/lib/sandbox-coding-disposition.mjs`) + the real repo check.
 *
 * Run: node --test scripts/check-sandbox-coding-disposition.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractRegisteredTypes,
  extractDispositions,
  evaluateDispositionCoverage,
} from "./lib/sandbox-coding-disposition.mjs";
import { runDispositionCheck } from "./check-sandbox-coding-disposition.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REGISTRY_FIXTURE = `export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "hermes_local",
  "process",
]);`;

const MATRIX_FIXTURE = `export const CODING_ADAPTER_DISPOSITIONS = {
  claude_local: { adapterType: "claude_local", bucket: "v1", provider: "anthropic" },
  codex_local: { adapterType: "codex_local", bucket: "v1", provider: "openai" },
  hermes_local: { adapterType: "hermes_local", bucket: "out_of_scope", reason: "external wire protocol" },
  process: { adapterType: "process", bucket: "infra", reason: "not a coding CLI" },
};`;

test("extractRegisteredTypes pulls the Set members", () => {
  assert.deepEqual(extractRegisteredTypes(REGISTRY_FIXTURE), ["claude_local", "codex_local", "hermes_local", "process"]);
});

test("extractDispositions pulls type/bucket/hasReason", () => {
  const d = extractDispositions(MATRIX_FIXTURE);
  assert.equal(d.length, 4);
  const hermes = d.find((x) => x.type === "hermes_local");
  assert.equal(hermes.bucket, "out_of_scope");
  assert.equal(hermes.hasReason, true);
  const claude = d.find((x) => x.type === "claude_local");
  assert.equal(claude.bucket, "v1");
  assert.equal(claude.hasReason, false);
});

test("full coverage passes clean", () => {
  const errors = evaluateDispositionCoverage({
    registeredTypes: extractRegisteredTypes(REGISTRY_FIXTURE),
    dispositions: extractDispositions(MATRIX_FIXTURE),
  });
  assert.deepEqual(errors, []);
});

test("an undispositioned registered type is a violation (fail-closed drift)", () => {
  const registry = REGISTRY_FIXTURE.replace('"process",', '"process",\n  "grok_local",');
  const errors = evaluateDispositionCoverage({
    registeredTypes: extractRegisteredTypes(registry),
    dispositions: extractDispositions(MATRIX_FIXTURE),
  });
  assert.ok(errors.some((e) => e.includes("grok_local") && e.includes("NO disposition")));
});

test("a non-v1 bucket without a reason is a violation", () => {
  const matrix = MATRIX_FIXTURE.replace(', reason: "external wire protocol"', "");
  const errors = evaluateDispositionCoverage({
    registeredTypes: extractRegisteredTypes(REGISTRY_FIXTURE),
    dispositions: extractDispositions(matrix),
  });
  assert.ok(errors.some((e) => e.includes("hermes_local") && e.includes("attributable reason")));
});

test("an invalid bucket is a violation", () => {
  const matrix = MATRIX_FIXTURE.replace('bucket: "infra"', 'bucket: "bogus"');
  const errors = evaluateDispositionCoverage({
    registeredTypes: extractRegisteredTypes(REGISTRY_FIXTURE),
    dispositions: extractDispositions(matrix),
  });
  assert.ok(errors.some((e) => e.includes("process") && e.includes("invalid bucket")));
});

test("the REAL repo matrix + registry pass the check", async () => {
  const { errors, readErrors } = await runDispositionCheck(REPO_ROOT);
  assert.deepEqual(readErrors, [], `read errors: ${readErrors.join(", ")}`);
  assert.deepEqual(errors, [], `coverage violations: ${errors.join(", ")}`);
});
