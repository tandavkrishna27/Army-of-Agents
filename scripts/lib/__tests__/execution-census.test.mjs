#!/usr/bin/env node
/**
 * Tests for TRACK-002's execution-census logic.
 *
 * The comment-stripping test is the most important one here. The defect it pins is not
 * hypothetical: during this ticket's terrain a basename grep counted the unrun population
 * as 8 instead of 9, because `image-startup-smoke.test.mjs` is named in a COMMENT
 * explaining why it is NOT wired. If that protection is ever removed, this guard starts
 * crediting prose as execution.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { evaluateExecutionCensus, stripCommentLines } from "../execution-census.mjs";

const BASE = {
  mjsTestFiles: ["scripts/a.test.mjs"],
  manifest: { files: { "scripts/a.test.mjs": { status: "runs", workflow: "pr.yml", step: "S" } } },
  stepRunText: new Map([["pr.yml::S", "node --test scripts/a.test.mjs"]]),
  vitestProjects: ["server"],
  packagesWithSpecs: ["server"],
};

test("a clean tree passes", () => {
  assert.equal(evaluateExecutionCensus(BASE).ok, true);
});

test("a test file with no manifest entry FAILS", () => {
  const r = evaluateExecutionCensus({ ...BASE, mjsTestFiles: [...BASE.mjsTestFiles, "scripts/b.test.mjs"] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "undeclared" && p.file === "scripts/b.test.mjs"));
});

test("★ a COMMENT naming the file does NOT satisfy 'runs'", () => {
  // The exact defect that produced a wrong baseline for this ticket. If this test fails,
  // the guard is crediting prose as execution — do not "fix" it by relaxing the check.
  const r = evaluateExecutionCensus({
    ...BASE,
    stepRunText: new Map([["pr.yml::S", "# scripts/a.test.mjs is deliberately not wired\nnode --test scripts/other.test.mjs"]]),
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "not_named_in_step"));
});

test("'unrun' with no reason FAILS — a reason is not optional", () => {
  const r = evaluateExecutionCensus({
    ...BASE,
    manifest: { files: { "scripts/a.test.mjs": { status: "unrun", reason: "   " } } },
    stepRunText: new Map(),
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "missing_reason"));
});

test("'unrun' with a reason passes", () => {
  const r = evaluateExecutionCensus({
    ...BASE,
    manifest: { files: { "scripts/a.test.mjs": { status: "unrun", reason: "red; fix the mutation helper first" } } },
    stepRunText: new Map(),
  });
  assert.equal(r.ok, true);
});

test("a 'runs' entry naming a step that no longer exists FAILS", () => {
  const r = evaluateExecutionCensus({ ...BASE, stepRunText: new Map([["pr.yml::Renamed", "node --test scripts/a.test.mjs"]]) });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "unknown_step"));
});

test("a manifest entry for a file that no longer exists FAILS as stale", () => {
  const r = evaluateExecutionCensus({ ...BASE, mjsTestFiles: [] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "stale"));
});

test("a package with vitest specs missing from projects[] FAILS", () => {
  const r = evaluateExecutionCensus({ ...BASE, packagesWithSpecs: ["server", "packages/newthing"] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "vitest_project_missing" && p.file === "packages/newthing"));
});

test("★ anti-vacuity: an empty discovery, manifest, or projects list each FAIL", () => {
  // A census that found nothing to census is a broken checker, not a clean tree.
  assert.ok(evaluateExecutionCensus({ ...BASE, mjsTestFiles: [] }).problems.some((p) => p.kind === "vacuous"));
  assert.ok(evaluateExecutionCensus({ ...BASE, manifest: { files: {} } }).problems.some((p) => p.kind === "vacuous"));
  assert.ok(evaluateExecutionCensus({ ...BASE, vitestProjects: [] }).problems.some((p) => p.kind === "vacuous"));
  assert.ok(evaluateExecutionCensus({ ...BASE, packagesWithSpecs: [] }).problems.some((p) => p.kind === "vacuous"));
});

test("an unknown status is malformed, not silently accepted", () => {
  const r = evaluateExecutionCensus({ ...BASE, manifest: { files: { "scripts/a.test.mjs": { status: "maybe" } } } });
  assert.ok(r.problems.some((p) => p.kind === "malformed"));
});

test("'runs' without workflow+step is malformed", () => {
  const r = evaluateExecutionCensus({ ...BASE, manifest: { files: { "scripts/a.test.mjs": { status: "runs" } } } });
  assert.ok(r.problems.some((p) => p.kind === "malformed"));
});

test("stripCommentLines removes only whole comment lines", () => {
  assert.equal(stripCommentLines("# a\nb\n  # c\nd"), "b\nd");
  assert.equal(stripCommentLines("echo 'not # a comment'"), "echo 'not # a comment'");
});

test("path separators are normalised so a Windows walk matches a POSIX declaration", () => {
  const r = evaluateExecutionCensus({
    ...BASE,
    mjsTestFiles: ["scripts\\a.test.mjs"],
  });
  assert.equal(r.ok, true);
});

test("★ a package owning a vitest.config.ts but absent from projects[] FAILS", () => {
  // The blind spot this guard shipped with. `packages/plugins/examples/plugin-authoring-smoke-example`
  // names its suite `tests/plugin.spec.ts`, so the *.test.ts(x) walk never saw it — a whole
  // passing suite that had never run, invisible to the census written to find such things.
  const r = evaluateExecutionCensus({
    ...BASE,
    vitestConfigPackages: ["server", "packages/orphan"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "vitest_config_not_in_projects" && p.file === "packages/orphan"));
});

test("the vitest-config axis does not fire when the package IS listed", () => {
  const r = evaluateExecutionCensus({ ...BASE, vitestConfigPackages: ["server"] });
  assert.equal(r.ok, true);
});
