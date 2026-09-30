#!/usr/bin/env node
/**
 * image-startup-smoke.test.mjs — startup + healthcheck smoke for the BUILT
 * DEP-001 images, proving they run on a READ-ONLY root filesystem.
 * LINUX/CI-ONLY (needs Docker + built images); SKIPs locally.
 *
 * Run (in CI, after build.sh):
 *   AOA_DEP001_IMAGE_TEST=1 node --test docker/images/__tests__/image-startup-smoke.test.mjs
 *
 * For each image: `docker run --read-only` (writable state only via a tmpfs
 * volume), then poll the container's HEALTHCHECK status until healthy. A failure
 * to reach healthy on a read-only root is a fail-closed test failure.
 */

import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DIGESTS = path.join(ROOT, "docker/images/digests.env");

function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ACTIVE = process.env.AOA_DEP001_IMAGE_TEST === "1" && existsSync(DIGESTS) && dockerAvailable();
const SKIP = ACTIVE
  ? false
  : "requires Docker + built images (build.sh) — Linux/CI-only (deferred; this host has no Docker)";

const env = {};
before(() => {
  if (!ACTIVE) return;
  for (const line of readFileSync(DIGESTS, "utf8").split(/\r?\n/)) {
    // build.sh emits `CONTROL-PLANE_IMAGE` (bash `^^` does not translate the
    // hyphen), which `[A-Z_]+` silently dropped — so the control-plane case here
    // ran against `undefined:latest`. Same defect as image-contents.test.mjs.
    // NOTE: fixing this does NOT make this file pass. Its worker case mounts
    // `--tmpfs /worker`, which lands root-owned OVER the Dockerfile's
    // `chown node:node /worker`, so the non-root daemon dies with
    // "mkdir: cannot create directory '/worker/tmp': Permission denied".
    // That is a defect in THIS TEST, not in the image: D1 uses a named volume,
    // which inherits the image's ownership. Tracked separately; this file is
    // deliberately still not wired into CI.
    const m = line.match(/^([A-Z0-9_-]+)=(.*)$/);
    if (m) env[m[1].replace(/-/g, "_")] = m[2];
  }
});

async function runReadOnlyUntilHealthy(image, extraArgs) {
  // --read-only root; writable state ONLY on a tmpfs-backed named path.
  const cid = execFileSync(
    "docker",
    ["run", "-d", "--read-only", ...extraArgs, image],
    { encoding: "utf8" },
  ).trim();
  try {
    const deadline = Date.now() + 120_000;
    let status = "starting";
    while (Date.now() < deadline) {
      status = execFileSync(
        "docker",
        ["inspect", "--format", "{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}none{{ end }}", cid],
        { encoding: "utf8" },
      ).trim();
      if (status === "healthy") return status;
      if (status === "unhealthy") break;
      await sleep(3000);
    }
    const logs = execFileSync("docker", ["logs", "--tail", "50", cid], { encoding: "utf8" });
    throw new Error(`container ${image} did not become healthy (last=${status}); logs:\n${logs}`);
  } finally {
    execFileSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
  }
}

test("control-plane starts healthy on a read-only root", { skip: SKIP }, async () => {
  const status = await runReadOnlyUntilHealthy(env.CONTROL_PLANE_IMAGE, [
    "--tmpfs", "/aoa:rw,size=64m",
    "-e", "AOA_DEPLOYMENT_MODE=authenticated",
  ]);
  assert.equal(status, "healthy");
});

test("worker starts healthy on a read-only root", { skip: SKIP }, async () => {
  const status = await runReadOnlyUntilHealthy(env.WORKER_IMAGE, [
    "--tmpfs", "/worker:rw,size=32m",
  ]);
  assert.equal(status, "healthy");
});
