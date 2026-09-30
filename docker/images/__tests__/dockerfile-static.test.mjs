#!/usr/bin/env node
/**
 * dockerfile-static.test.mjs — STATIC (no-build) assertions on the DEP-001 split
 * Dockerfiles. Runs locally (no Docker, no network); the built-image behavioural
 * proofs live in image-contents.test.mjs / image-startup-smoke.test.mjs and are
 * Linux/CI-only.
 *
 * Run with:
 *   node --test docker/images/__tests__/dockerfile-static.test.mjs
 *
 * Proves, by parsing the Dockerfile TEXT:
 *   - both bases are pinned BY DIGEST (@sha256:...);
 *   - both run NON-ROOT (USER node) with a read-only-root posture (rootfs label
 *     + externalized writable VOLUME) and a HEALTHCHECK + OCI revision label;
 *   - control-plane builds server + UI and contains NO docker-cli, NO agent
 *     CLIs, NO worker daemon;
 *   - worker runs the daemon and contains NO server/db/ui/drizzle/adapter-utils/
 *     shared (E4-D01), with a loopback-only /healthz surface;
 *   - the entrypoints do NO runtime usermod/gosu/chown (read-only-root safe).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const CONTROL = read("docker/control-plane/Dockerfile");
const WORKER = read("docker/worker/Dockerfile");
const CONTROL_ENTRY = read("docker/control-plane/entrypoint.sh");
const WORKER_ENTRY = read("docker/worker/entrypoint.sh");

/**
 * Strip full-line comments (`#`-led, after indentation) so absence assertions
 * test the EFFECTIVE build/run instructions, not the explanatory prose that
 * legitimately names the very things we forbid ("NO docker-cli", etc.).
 */
function stripComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const CONTROL_CODE = stripComments(CONTROL);
const WORKER_CODE = stripComments(WORKER);
const CONTROL_ENTRY_CODE = stripComments(CONTROL_ENTRY);
const WORKER_ENTRY_CODE = stripComments(WORKER_ENTRY);

const DIGEST_PIN_RE = /^FROM\s+node:lts-trixie-slim@sha256:[0-9a-f]{64}\s+AS\s+base\s*$/m;

/**
 * Extract the body lines of a named build stage (`FROM ... AS <stage>` up to the
 * next `FROM`) from ALREADY-comment-stripped text. Returns "" if not found. Used
 * to inspect the EFFECTIVE copied artifact set of the final/production stage.
 */
function extractStage(codeText, stageName) {
  const lines = String(codeText).split(/\r?\n/);
  const fromRe = /^\s*FROM\s+/i;
  const asRe = new RegExp(`^\\s*FROM\\s+.+\\s+AS\\s+${stageName}\\s*$`, "i");
  let inStage = false;
  const body = [];
  for (const line of lines) {
    if (asRe.test(line)) {
      inStage = true;
      continue;
    }
    if (inStage && fromRe.test(line)) break;
    if (inStage) body.push(line);
  }
  return body.join("\n");
}

/**
 * True iff some `COPY --from=build` line in `stageCode` names the WHOLE build
 * tree `/app` as a source (e.g. `COPY --chown=... --from=build /app /app`). Run
 * on comment-stripped text: it inspects the effective COPY *source* set (not the
 * literal string `packages/worker-daemon`, which a broad `COPY . .` never spells)
 * so a whole-tree copy can no longer smuggle the excluded packages in vacuously.
 * `/app/ui/dist` (a sub-path) is NOT the whole tree and is allowed.
 */
function copiesWholeBuildTree(stageCode) {
  for (const raw of String(stageCode).split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^COPY\b/i.test(line)) continue;
    if (!/--from=build\b/.test(line)) continue;
    const rest = line.replace(/^COPY\b/i, "").trim();
    const tokens = rest.split(/\s+/).filter((t) => !t.startsWith("--"));
    const sources = tokens.slice(0, -1); // last token is the COPY destination
    if (sources.includes("/app")) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Shared posture: digest-pinned base, non-root, read-only-root, healthcheck,
// OCI revision label.
// --------------------------------------------------------------------------

for (const [name, df] of [
  ["control-plane", CONTROL],
  ["worker", WORKER],
]) {
  test(`${name}: base image is pinned by digest (@sha256:)`, () => {
    assert.match(df, DIGEST_PIN_RE, `${name} base must be node:lts-trixie-slim@sha256:<64hex>`);
    assert.ok(!/^FROM\s+node:lts-trixie-slim\s+AS/m.test(df), `${name} base must NOT be an unpinned tag`);
  });

  test(`${name}: runs as a non-root USER`, () => {
    assert.match(df, /^USER\s+node\s*$/m, `${name} must declare USER node`);
    assert.ok(!/^USER\s+root\s*$/m.test(df), `${name} must not end as USER root`);
  });

  test(`${name}: read-only-root posture (rootfs label + writable VOLUME)`, () => {
    assert.match(df, /org\.armyofagents\.image\.rootfs="read-only"/, `${name} must declare the read-only rootfs label`);
    assert.match(df, /^VOLUME\s+\[/m, `${name} must externalize writable state to a VOLUME`);
  });

  test(`${name}: declares a HEALTHCHECK`, () => {
    assert.match(df, /^HEALTHCHECK\s+/m, `${name} must declare a HEALTHCHECK`);
  });

  test(`${name}: carries the OCI source-revision label`, () => {
    assert.match(df, /org\.opencontainers\.image\.revision="\$\{AOA_IMAGE_REVISION\}"/, `${name} must label image.revision from the recorded source SHA`);
    assert.match(df, /^ARG\s+AOA_IMAGE_REVISION/m, `${name} must accept the AOA_IMAGE_REVISION build-arg`);
  });
}

// --------------------------------------------------------------------------
// Control-plane exclusions + inclusions.
// --------------------------------------------------------------------------

test("control-plane: builds the server AND the UI (full closure)", () => {
  // A single closure build (`@armyofagents/server...` + `@armyofagents/ui...`)
  // compiles the server, the UI, AND every transitive workspace dep to dist so
  // the production stage can ship the pruned `pnpm deploy` output.
  assert.match(CONTROL, /pnpm\s+--filter\s+"@armyofagents\/server\.\.\."/, "must build the server closure");
  assert.match(CONTROL, /--filter\s+"@armyofagents\/ui\.\.\."\s+build/, "must build the UI closure");
});

test("control-plane: HEALTHCHECK targets /api/health", () => {
  assert.match(CONTROL, /\/api\/health/);
});

test("control-plane: contains NO docker-cli", () => {
  assert.ok(!/\bdocker-cli\b/.test(CONTROL_CODE), "control-plane must not install docker-cli");
});

test("control-plane: installs NO agent CLIs", () => {
  for (const cli of ["@anthropic-ai/claude-code", "@openai/codex", "@google/gemini-cli", "opencode-ai"]) {
    assert.ok(!CONTROL_CODE.includes(cli), `control-plane must not install ${cli}`);
  }
  assert.ok(!/npm install --global/.test(CONTROL_CODE), "control-plane must not npm-global-install agent CLIs");
});

test("control-plane: does NOT include the worker daemon", () => {
  assert.ok(!/packages\/worker-daemon/.test(CONTROL_CODE), "control-plane must not reference packages/worker-daemon");
  assert.ok(!/worker-daemon\.js/.test(CONTROL_CODE));
});

test("control-plane: production stage does NOT copy the whole /app build tree (non-vacuous)", () => {
  const prodStage = extractStage(CONTROL_CODE, "production");
  assert.ok(prodStage.length > 0, "control-plane must declare a `FROM ... AS production` stage");

  // GREEN — the reworked production stage copies the pruned deploy closure, never
  // the whole `/app` build tree. This is the exclusion that the text-grep tests
  // above (packages/worker-daemon, agent CLIs) can only prove NON-vacuously once
  // a broad whole-tree copy is itself forbidden: `COPY . .` → `COPY /app /app`
  // literally spells none of those package paths, yet ships them all.
  assert.ok(
    !copiesWholeBuildTree(prodStage),
    "control-plane production stage must NOT `COPY --from=build /app ...` — that ships the whole repo source (worker-daemon, cli, every packages/adapters/*). Ship the pruned /cp-app deploy closure instead.",
  );

  // RED-proof (guards THIS test against vacuousness): the SAME detector MUST fire
  // on the OLD whole-tree copy. If this stops matching, the assertion above is
  // meaningless — so we assert the detector is load-bearing on the old text.
  const OLD_PRODUCTION_STAGE = [
    "WORKDIR /app",
    "COPY --chown=node:node --from=build /app /app",
    "USER node",
  ].join("\n");
  assert.ok(
    copiesWholeBuildTree(OLD_PRODUCTION_STAGE),
    "sanity: the whole-tree-copy detector MUST catch the OLD `COPY --from=build /app /app` (else the check above is vacuous)",
  );
});

test("control-plane: production stage ships ONLY the pruned deploy closure + UI assets", () => {
  const prodStage = extractStage(CONTROL_CODE, "production");
  assert.match(
    prodStage,
    /COPY\b[^\n]*--from=build\s+\/cp-app\s+\/cp-app/,
    "must copy the pruned server deploy closure (/cp-app)",
  );
  assert.match(
    prodStage,
    /COPY\b[^\n]*--from=build\s+\/app\/ui\/dist\s+\/cp-app\/ui-dist/,
    "must copy the built UI assets to the server-served ui-dist directory",
  );
});

// --------------------------------------------------------------------------
// Worker exclusions + inclusions (E4-D01).
// --------------------------------------------------------------------------

test("worker: runs the worker daemon binary", () => {
  assert.match(WORKER, /dist\/bin\/worker-daemon\.js/);
});

// WRK-017. `docker-compose.d1.yml` enters `dist/bin/container-host.js` on one worker via a
// `command:` override, and a `command:` naming a file the image does not contain is NOT a build
// failure — the container starts, node exits ERR_MODULE_NOT_FOUND, and `up --wait` reports an
// unhealthy service with no hint that the BIN is what is missing. Both guards are asserted: the
// build tree (does tsc emit it?) and the DEPLOY tree (does `pnpm deploy` ship it?), because those
// are two different questions and only the second is what the container actually runs.
test("worker: build AND deploy stages assert the container-host bin (WRK-017)", () => {
  assert.match(
    WORKER_CODE,
    /test -f packages\/worker-daemon\/dist\/bin\/container-host\.js/,
    "the build stage must assert tsc emitted the container-host bin",
  );
  assert.match(
    WORKER_CODE,
    /test -f \/worker-app\/dist\/bin\/container-host\.js/,
    "the deploy stage must assert the container-host bin actually SHIPS at the path the D1 command: names",
  );
});

// WRK-017. The D1-harness-only enrolment seed must reach /cp-app, where the deployed `postgres`
// driver and `@armyofagents/worker-protocol` resolve. Placed anywhere else it is an
// ERR_MODULE_NOT_FOUND inside the migrate job, which fails the whole bring-up.
test("control-plane: ships the D1 enrolment seed under /cp-app (WRK-017)", () => {
  assert.match(
    CONTROL_CODE,
    /COPY[^\n]*docker\/control-plane\/seed-d1-worker-enrolment\.mjs \/cp-app\/seed-d1-worker-enrolment\.mjs/,
    "the enrolment seed must be COPYed to /cp-app so its imports resolve",
  );
});

test("worker: loopback-only /healthz health surface", () => {
  assert.match(WORKER, /\/healthz/);
  assert.match(WORKER, /127\.0\.0\.1/);
});

test("worker: contains NO server/db/ui/drizzle/adapter-utils/shared", () => {
  for (const forbidden of [
    "@armyofagents/server",
    "packages/db",
    "@armyofagents/ui",
    "packages/adapter-utils",
    "packages/shared",
    "drizzle",
  ]) {
    assert.ok(!WORKER_CODE.includes(forbidden), `worker image must not reference ${forbidden}`);
  }
});

test("worker: installs NO agent CLIs or docker-cli", () => {
  for (const cli of ["@anthropic-ai/claude-code", "@openai/codex", "@google/gemini-cli", "opencode-ai", "docker-cli"]) {
    assert.ok(!WORKER_CODE.includes(cli), `worker must not install ${cli}`);
  }
});

// --------------------------------------------------------------------------
// Entrypoints are read-only-root safe (no runtime privilege escalation).
// --------------------------------------------------------------------------

for (const [name, entryCode, entryRaw] of [
  ["control-plane", CONTROL_ENTRY_CODE, CONTROL_ENTRY],
  ["worker", WORKER_ENTRY_CODE, WORKER_ENTRY],
]) {
  test(`${name} entrypoint: no runtime usermod/groupmod/gosu/chown`, () => {
    for (const forbidden of ["usermod", "groupmod", "gosu", "chown"]) {
      assert.ok(!entryCode.includes(forbidden), `${name} entrypoint must not ${forbidden} (breaks read-only root)`);
    }
  });
  test(`${name} entrypoint: execs the passed command`, () => {
    assert.match(entryRaw, /^exec "\$@"/m, `${name} entrypoint must exec "$@"`);
  });
}

// === WRK-017: a file the image COPYs must actually be IN the repository ======
//
// This clause exists because it bit, on this ticket, in exactly the way that is hardest to
// see: `.gitignore` carries an UNANCHORED `seed-*.mjs` (a scratch-script convention), and it
// silently swallowed `docker/control-plane/seed-d1-worker-enrolment.mjs` — a real, shipped file
// that the control-plane image COPYs and the migrate job runs.
//
// NOTHING local noticed. The Docker build context obeys `.dockerignore`, not `.gitignore`, so
// the image built and the live stack ran a green enrol end to end on a working tree that
// contained the file. CI then checked out a repository that did not, and the first thing to
// fail was a node:test import. A local green over an incomplete commit is precisely the shape
// this repository's CI redesign exists to catch.
//
// So: every LOCAL path a split Dockerfile COPYs must exist on disk AND be tracked by git.
// `git ls-files` is the authority rather than a hand-maintained list, because the question is
// literally "would a fresh clone have this file".
test("every local path the split Dockerfiles COPY is present and NOT gitignored (WRK-017)", () => {
  const copied = new Set();
  for (const text of [CONTROL_CODE, WORKER_CODE]) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*COPY\s+(.*)$/i.exec(line);
      if (!m) continue;
      const args = m[1].trim().split(/\s+/);
      // `COPY --from=<stage> ...` copies from an earlier STAGE, not the build context.
      if (args.some((a) => /^--from=/.test(a))) continue;
      const sources = args.filter((a) => !a.startsWith("--")).slice(0, -1);
      for (const src of sources) {
        // Only concrete files; directories and the bare-root context copies are covered by
        // their own assertions above and would drag in the whole tree here.
        if (src === "." || src.endsWith("/") || !path.extname(src)) continue;
        copied.add(src);
      }
    }
  }
  assert.ok(copied.size >= 5, `expected several COPYed files, parsed ${copied.size} — the parser is vacuous`);

  // This assertion is ABOUT the repository, so it is meaningless outside one — and it FAILS
  // rather than skips in that case, deliberately. A guard that quietly stands down where it
  // cannot answer is indistinguishable from one that passes.
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(
    (inRepo.stdout ?? "").trim(),
    "true",
    "this test asks whether a fresh clone would carry the COPYed files, so it must run inside a git checkout",
  );

  const missing = [];
  const ignored = [];
  for (const rel of copied) {
    if (!existsSync(path.join(ROOT, rel))) { missing.push(rel); continue; }
    // `git ls-files --error-unmatch` asks the question that actually matters — "is this path
    // IN the repository" — rather than "does an ignore rule match it". The two differ, and the
    // difference is the whole bug: `git check-ignore` skips already-TRACKED paths, so it answers
    // "not ignored" for a file that is only tracked because someone force-added it, and it would
    // stop biting the moment the mistake was half-fixed. Tracked-or-not is unambiguous.
    const res = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: ROOT });
    if (res.error) throw res.error;
    if (res.status !== 0) ignored.push(rel);
  }
  assert.deepEqual(missing, [], `Dockerfile COPYs a file that is not on disk: ${missing.join(", ")}`);
  assert.deepEqual(
    ignored,
    [],
    `Dockerfile COPYs a file git does NOT track, so a fresh clone would not have it: ${ignored.join(", ")}`,
  );
});
