/**
 * Cross-platform process-isolation regressions for the frozen-consumer checker.
 *
 * Run separately from the 30-case mutation corpus because the parallel case
 * intentionally launches two complete copies of that corpus.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { smokeImport } from "./check-frozen-worker-protocol-consumer.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(SCRIPT_DIR, "check-frozen-worker-protocol-consumer.test.mjs");
const WAIT_SLICE_MS = 25;
const ISOLATION_TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-wp-isolation-run-"));

after(() => {
  fs.rmSync(ISOLATION_TEMP_ROOT, { recursive: true, force: true });
});

function ownedTempDir(prefix) {
  return fs.mkdtempSync(path.join(ISOLATION_TEMP_ROOT, prefix));
}

function withProcessEnv(overrides, fn) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function spawnCorpus(readyPath, releasePath) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", CORPUS_PATH], {
    cwd: path.resolve(SCRIPT_DIR, ".."),
    env: {
      ...childEnv,
      FROZEN_WP_OWNERSHIP_READY: readyPath,
      FROZEN_WP_OWNERSHIP_RELEASE: releasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error }));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
  return { child, completion };
}

async function waitForOwnershipReport(reportPath, run, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (!fs.existsSync(reportPath)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      const result = await run.completion;
      assert.fail(`corpus exited before publishing owned live repository (${result.code}/${result.signal}):\n${result.stderr || result.stdout}`);
    }
    assert.ok(Date.now() - startedAt < timeoutMs, `timed out waiting for ownership report ${reportPath}`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_SLICE_MS));
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

async function terminateIfRunning(run, releasePath) {
  if (!run) return;
  if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release\n");
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  await run.completion;
}

test("the valid smoke module observes zero JavaScript environment keys", () => {
  const dir = ownedTempDir("environment-probe-");
  try {
    const modulePath = path.join(dir, "environment-probe.mjs");
    fs.writeFileSync(modulePath, `
      const visibleEnvironmentKeys = Object.keys(process.env).sort();
      if (visibleEnvironmentKeys.length !== 0) {
        throw new Error("visible environment keys: " + JSON.stringify(visibleEnvironmentKeys));
      }
      export const jobEnvelopeV1Schema = {};
      export const enrollmentRequestV1Schema = {};
      export const controlCommandV1Schema = {};
      export const protocolErrorV1Schema = {};
      export const PROTOCOL_VERSION = 1;
      export const protocolErrorCodeSchema = { safeParse: (value) => ({ success: value === "stale_fence" }) };
      export { visibleEnvironmentKeys };
    `);

    const failure = withProcessEnv({
      REVIEW_PARENT_SECRET: "must-not-propagate",
      NODE_OPTIONS: "--stack-trace-limit=23",
      NODE_PATH: path.join(dir, "must-not-propagate"),
    }, () => smokeImport("environment-probe", pathToFileURL(modulePath).href));

    assert.equal(failure, null, failure);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("staggered full corpus processes cannot remove each other's owned live repository", { timeout: 240_000 }, async () => {
  const coordinationRoot = ownedTempDir("parallel-coordination-");
  const firstReady = path.join(coordinationRoot, "first.ready.json");
  const firstRelease = path.join(coordinationRoot, "first.release");
  const secondReady = path.join(coordinationRoot, "second.ready.json");
  const secondRelease = path.join(coordinationRoot, "second.release");
  let first;
  let second;
  try {
    first = spawnCorpus(firstReady, firstRelease);
    const firstOwnership = await waitForOwnershipReport(firstReady, first);
    second = spawnCorpus(secondReady, secondRelease);
    const secondOwnership = await waitForOwnershipReport(secondReady, second);

    assert.notEqual(firstOwnership.parentRoot, secondOwnership.parentRoot, "corpus processes must own distinct temp parents");
    for (const ownership of [firstOwnership, secondOwnership]) {
      assert.equal(path.dirname(ownership.repoRoot), ownership.parentRoot, "live repository must be a direct child of its run-owned parent");
      assert.equal(fs.existsSync(path.join(ownership.repoRoot, ".git", "HEAD")), true, "ownership report must identify a live Git repository");
    }

    fs.writeFileSync(firstRelease, "release\n");
    const firstResult = await first.completion;
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    assert.match(firstResult.stdout, /pass 30\b/);
    assert.equal(
      fs.existsSync(path.join(secondOwnership.repoRoot, ".git", "HEAD")),
      true,
      "the completed first corpus must not remove the blocked second corpus's live repository",
    );
    assert.equal(fs.existsSync(firstOwnership.parentRoot), false, "first corpus must remove its owned parent at exit");

    fs.writeFileSync(secondRelease, "release\n");
    const secondResult = await second.completion;
    assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);
    assert.match(secondResult.stdout, /pass 30\b/);
    assert.equal(fs.existsSync(secondOwnership.parentRoot), false, "second corpus must remove its owned parent at exit");
    assert.deepEqual(
      fs.readdirSync(coordinationRoot).sort(),
      ["first.ready.json", "first.release", "second.ready.json", "second.release"],
      "parallel regression must leave only its own expected coordination files",
    );
  } finally {
    await terminateIfRunning(first, firstRelease);
    await terminateIfRunning(second, secondRelease);
    fs.rmSync(coordinationRoot, { recursive: true, force: true });
  }
});
