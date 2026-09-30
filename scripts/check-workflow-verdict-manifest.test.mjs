// -----------------------------------------------------------------------------
// DEP-013 Slice A — the manifest guard, asserted on its REAL EXIT CODE.
//
// The pure completeness rules are proven in `scripts/lib/__tests__/workflow-verdict.test.mjs`.
// What can only be proven by SPAWNING the CLI is that it REFUSES rather than carrying on:
// an unparseable manifest, and a manifest with a duplicated key — the exact shape a `git
// rerere` replay of a stale conflict resolution produced on 2026-09-03, which `JSON.parse`
// accepts while silently keeping only the last copy.
// -----------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "check-workflow-verdict-manifest.mjs");
const REAL = path.join(ROOT, "scripts", "workflow-verdict-manifest.json");

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function withManifest(text) {
  const dir = mkdtempSync(path.join(tmpdir(), "wvm-"));
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, text, "utf8");
  return file;
}

test("the committed manifest PASSES, and says what it is watching", () => {
  const { code, out } = run([]);
  assert.equal(code, 0, out);
  assert.match(out, /workflow-verdict-manifest: OK/);
  assert.match(out, /watched/);
});

test("★ it REFUSES an unparseable manifest rather than guessing", () => {
  const { code, out } = run(["--manifest", withManifest("{ not json")]);
  assert.equal(code, 1);
  assert.match(out, /not valid JSON/);
});

test("★★ it REFUSES a manifest with a DUPLICATED key — the 2026-09-03 rerere shape", () => {
  // JSON.parse accepts this and silently keeps the LAST copy, so the losing copy — which on a
  // rerere replay is often the CORRECTED one — exists only in the raw text.
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  const text = JSON.stringify(real, null, 2).replace(
    '"toleratedSilenceHours": 72,',
    '"toleratedSilenceHours": 72,\n    "toleratedSilenceHours": 9999,',
  );
  const { code, out } = run(["--manifest", withManifest(text)]);
  assert.equal(code, 1, out);
  assert.match(out, /repeats a key/);
  assert.match(out, /rerere/);
});

test("★ a workflow with no manifest entry FAILS — proven on the real workflow directory", () => {
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  delete real.streams["cross-platform-weekly.yml@main"];
  const { code, out } = run(["--manifest", withManifest(JSON.stringify(real, null, 2))]);
  assert.equal(code, 1);
  assert.match(out, /workflow_undeclared/);
  assert.match(out, /cross-platform-weekly\.yml/);
});

test("★ a push workflow with only ONE of its declared branches FAILS — proven on d1-merge-train", () => {
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  delete real.streams["d1-merge-train.yml@main"];
  const { code, out } = run(["--manifest", withManifest(JSON.stringify(real, null, 2))]);
  assert.equal(code, 1);
  assert.match(out, /branch_undeclared/);
  assert.match(out, /mask a red on the other/);
});

test("★ a not-watched entry that does not say what would have to change FAILS", () => {
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  delete real.streams["release-smoke.yml@*"].wouldTakeToWatch;
  const { code, out } = run(["--manifest", withManifest(JSON.stringify(real, null, 2))]);
  assert.equal(code, 1);
  assert.match(out, /reason_missing/);
});

test("★ ANTI-VACUITY: a manifest that watches nothing FAILS", () => {
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  for (const key of Object.keys(real.streams)) {
    real.streams[key] = { ...real.streams[key], watch: "not-watched", reason: "x", wouldTakeToWatch: "y" };
  }
  const { code, out } = run(["--manifest", withManifest(JSON.stringify(real, null, 2))]);
  assert.equal(code, 1);
  assert.match(out, /no_watched_streams/);
});

test("★ pr.yml runs this guard with NO flags — the --manifest escape hatch is test-only", () => {
  const pr = readFileSync(path.join(ROOT, ".github", "workflows", "pr.yml"), "utf8");
  const invocations = pr
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .filter((l) => l.includes("check-workflow-verdict-manifest.mjs"));
  assert.ok(invocations.length >= 1, "pr.yml must invoke the guard — a check nothing runs is not a check");
  for (const line of invocations) {
    if (line.includes("--test")) continue; // `node --test scripts/…test.mjs` is the self-test
    assert.ok(!line.includes("--manifest"), `pr.yml must not pass --manifest: ${line.trim()}`);
  }
});
