#!/usr/bin/env node
/**
 * check-image-deps-stages.mjs — split-image deps-stage parity gate (DEP-001).
 *
 * Extends the `pr.yml` Dockerfile-deps validation to the two NEW split images:
 * each of `docker/control-plane/Dockerfile` and `docker/worker/Dockerfile` must
 * `COPY`, in its `deps` stage, EXACTLY the workspace-package manifests in its own
 * runtime dependency closure — no fewer, and NO MORE. The existing combined
 * `Dockerfile` "all packages present" awk check in `pr.yml` is left untouched and
 * keeps running alongside this one.
 *
 * The control-plane closure is the transitive runtime workspace closure of
 * `@armyofagents/server` + `@armyofagents/ui`. The worker closure is fixed by
 * E4-D01 to `@armyofagents/worker-daemon` + `@armyofagents/worker-protocol`
 * (a worker deps stage that would pull server/db/shared/adapter-utils FAILS).
 *
 * This file is the filesystem/command layer only; all parity logic lives in the
 * pure `scripts/lib/image-deps-stage.mjs`.
 *
 * ★ WHAT THIS GATE DOES NOT DO, because its name reads wider than its reach. It is
 * static text analysis over three Dockerfiles and the workspace manifests. It builds
 * NO image and reads NO lockfile, and it does not report "a workspace devDependency
 * was added" — when a `COPY . .` build stage absorbs a widening by construction it
 * stays green, correctly, and prints nothing but `split-image deps-stage parity: PASS`.
 * It is therefore NOT coverage for a manifest or lockfile edit; the lane that builds
 * the images (`.github/workflows/d1-merge-train.yml`) is, and that file says so.
 *
 * Usage:
 *   node scripts/check-image-deps-stages.mjs
 *   node scripts/check-image-deps-stages.mjs --root <fixture-dir>
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  evaluateBuildSelectionCoverage,
  evaluateBuildStageAbsorption,
  evaluateImageDepsStage,
  indexPackages,
} from "./lib/image-deps-stage.mjs";

/** Images validated by this gate and their build entry packages. */
export const IMAGES = [
  {
    imageName: "control-plane",
    dockerfile: "docker/control-plane/Dockerfile",
    entryPackages: ["@armyofagents/server", "@armyofagents/ui"],
  },
  {
    // ★ TWO entry packages since Blocker B. The image now carries BOTH the daemon and
    // `worker-networked-host` — DEP-011 Slice 2b's CONTAINER boot root, the only thing in the
    // fleet that can construct a per-run provider over the gated adapter-manager wire. Its
    // closure adds provider-wire, provider-capability, sandbox-e2b-provider and
    // sandbox-provider-contract, so the image is SEVEN workspace packages, not two.
    //
    // E4-D01's real invariant is untouched: `worker-daemon` still imports no provider
    // (`check-worker-daemon-boundary.mjs`), the networked driver lives OUTSIDE it, and the two
    // deploy trees are separate so nothing here reaches the daemon's own node_modules.
    imageName: "worker",
    dockerfile: "docker/worker/Dockerfile",
    entryPackages: ["@armyofagents/worker-daemon", "@armyofagents/worker-networked-host"],
  },
  {
    // DEP-012 Slice 4+5 — the out-of-process provider HOST. Its runtime closure is
    // the transitive runtime workspace deps of @armyofagents/adapter-manager:
    // provider-wire, sandbox-e2b-provider, worker-daemon, worker-protocol,
    // provider-capability (a devDep of adapter-manager but a RUNTIME dep of
    // provider-wire), and sandbox-provider-contract. sandbox-fake-provider is a
    // devDep of sandbox-provider-contract only and is deliberately OUT of the closure.
    imageName: "adapter-manager",
    dockerfile: "docker/adapter-manager/Dockerfile",
    entryPackages: ["@armyofagents/adapter-manager"],
  },
];

/** Workspace manifest search roots (mirrors pnpm-workspace.yaml layout). */
const SINGLE_ROOTS = ["server", "ui", "cli"];
const GLOB_ROOTS = ["packages", "packages/adapters", "packages/plugins"];

function collectManifestRecords(root, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const readdir = deps.readdir ?? ((p) => readdirSync(p, { withFileTypes: true }));
  const exists = deps.exists ?? ((p) => existsSync(p));
  const records = [];

  const addDir = (relDir) => {
    const manifestPath = path.join(root, relDir, "package.json");
    if (!exists(manifestPath)) return;
    let manifest;
    try {
      manifest = JSON.parse(readFile(manifestPath));
    } catch {
      return;
    }
    records.push({ dir: relDir.replaceAll("\\", "/"), manifest });
  };

  for (const r of SINGLE_ROOTS) addDir(r);
  for (const g of GLOB_ROOTS) {
    const base = path.join(root, g);
    if (!exists(base)) continue;
    let entries;
    try {
      entries = readdir(base);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      addDir(path.join(g, e.name));
    }
  }
  return records;
}

/**
 * Run the parity check against a repo root.
 * @returns {{errors:string[]}}
 */
export function runDepsStageCheck(root, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const exists = deps.exists ?? ((p) => existsSync(p));
  const records = collectManifestRecords(root, deps);
  const packagesByName = indexPackages(records);
  const errors = [];
  for (const image of IMAGES) {
    const dockerfilePath = path.join(root, image.dockerfile);
    if (!exists(dockerfilePath)) {
      errors.push(`${image.imageName}: Dockerfile not found at ${image.dockerfile}`);
      continue;
    }
    let dockerfileText;
    try {
      dockerfileText = readFile(dockerfilePath);
    } catch (err) {
      errors.push(`${image.imageName}: could not read ${image.dockerfile} (${err.message})`);
      continue;
    }
    errors.push(
      ...evaluateImageDepsStage({
        imageName: image.imageName,
        dockerfileText,
        entryPackages: image.entryPackages,
        packagesByName,
      }),
      // E6-F012 — the SECOND, separately-reported set. The deps-stage pass above
      // decides what is INSTALLED (prod closure, exact). This one decides whether
      // the build stage absorbs the wider set `pnpm --filter "X..." build` will
      // actually compile. They are different questions about different stages and
      // neither may be relaxed into the other.
      ...evaluateBuildStageAbsorption({
        imageName: image.imageName,
        dockerfileText,
        entryPackages: image.entryPackages,
        packagesByName,
      }),
      // E6-F012 clause (a2). The absorption pass above tests the FLAG on the
      // build stage's re-install ("is it non-prod?"); it is satisfied by an
      // install that selects a narrower set than the build line and therefore
      // absorbs nothing — measured green on the real tree before this pass
      // existed. This one compares the two SELECTIONS.
      ...evaluateBuildSelectionCoverage({
        imageName: image.imageName,
        dockerfileText,
        packagesByName,
      }),
    );
  }
  return { errors };
}

export function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

function main() {
  const root = resolveRoot(process.argv.slice(2));
  const { errors } = runDepsStageCheck(root);
  if (errors.length > 0) {
    console.error("split-image deps-stage parity violations:");
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("split-image deps-stage parity: PASS");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
