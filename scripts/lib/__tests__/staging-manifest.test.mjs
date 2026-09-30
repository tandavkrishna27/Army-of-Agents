/**
 * DSK-003 — the installer staging manifest.
 *
 * WHY THIS EXISTS. The embedded-secret scan and the installer admission verifier were both
 * built and both had nothing to run against, because no artifact was ever assembled. The
 * manifest is what makes an artifact a THING rather than a directory: a declared file set
 * with a digest over it.
 *
 * The property that carries the weight is the one about files nobody declared:
 *
 *   A STRAY FILE IS A FAILURE. "Everything I listed is present and correct" is not the
 *   same statement as "nothing else is here", and only the second one is worth anything
 *   for an artifact you are about to sign. A build that swept in a `.env`, a fixture, or a
 *   developer's keystore blob would satisfy the first and fail the second.
 *
 * Ships nothing but Node built-ins, matching `image-admission.mjs` and
 * `embedded-secret-scan.mjs` — these run around a build, not inside it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  STAGING_VERIFY_FAILURES,
  buildStagingManifest,
  collectStagingFiles,
  isShippableStagingPath,
  verifyStagingRoot,
} from "../staging-manifest.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const FILES = [
  { path: "node_modules/@armyofagents/worker-daemon/dist/index.js", text: "export const a = 1;" },
  { path: "node_modules/@armyofagents/worker-daemon/package.json", text: '{"name":"d"}' },
  { path: "aoa-worker-desktop.js", text: "import './x.js';" },
];

describe("DSK-003 — the manifest declares the artifact", () => {
  it("lists every file with its digest and size", () => {
    const m = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
    assert.equal(m.files.length, 3);
    for (const entry of m.files) {
      const src = FILES.find((f) => f.path === entry.path);
      assert.equal(entry.sha256, sha256(src.text));
      assert.equal(entry.sizeBytes, Buffer.byteLength(src.text));
    }
  });

  it("sorts entries so the digest does not depend on walk order", () => {
    const forward = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
    const reversed = buildStagingManifest([...FILES].reverse(), { version: "0.1.0", platform: "win32" });
    assert.deepEqual(forward.files.map((f) => f.path), reversed.files.map((f) => f.path));
    assert.equal(forward.digest, reversed.digest);
  });

  it("is byte-stable for identical input", () => {
    const a = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
    const b = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
    assert.equal(a.digest, b.digest);
  });

  it("binds the version and the platform into the digest", () => {
    // The same bytes built for a different platform or version are a DIFFERENT artifact,
    // and `installer-admission.mjs` binds all three for exactly this reason.
    const base = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" }).digest;
    const otherVersion = buildStagingManifest(FILES, { version: "0.1.1", platform: "win32" }).digest;
    const otherPlatform = buildStagingManifest(FILES, { version: "0.1.0", platform: "darwin" }).digest;
    assert.equal(new Set([base, otherVersion, otherPlatform]).size, 3);
  });

  it("changes when any file's content changes", () => {
    const base = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" }).digest;
    const tweaked = buildStagingManifest(
      FILES.map((f) => (f.path.endsWith("index.js") ? { ...f, text: "export const a = 2;" } : f)),
      { version: "0.1.0", platform: "win32" },
    ).digest;
    assert.notEqual(base, tweaked);
  });

  it("emits a digest in the sha256 shape the admission verifier expects", () => {
    const m = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
    assert.match(m.digest, /^sha256:[0-9a-f]{64}$/);
  });
});

describe("DSK-003 — development files never enter the artifact", () => {
  it("refuses test files, fixtures and sourcemaps", () => {
    // My OWN secret-scan tests contain planted credentials. Shipping them would fail the
    // embedded-secret gate — correctly — so the exclusion is what keeps that gate
    // meaningful rather than permanently red.
    for (const p of [
      "dist/__tests__/thing.test.js",
      "dist/thing.test.js",
      "dist/thing.spec.js",
      "dist/index.js.map",
      "dist/thing.d.ts.map",
      "tests/fixtures/vectors.json",
      ".env",
      "dist/.env.local",
    ]) {
      assert.equal(isShippableStagingPath(p), false, p);
    }
  });

  it("refuses third-party docs and benchmarks", () => {
    // Found by running the scan over a REAL `pnpm deploy` root: pino's README and
    // @pinojs/redact's benchmarks contain example code like `password: "hunter2"`, which
    // tripped the secret gate. They are not credentials — but they are not runtime files
    // either, and the choice was between pruning them and weakening the gate.
    for (const p of [
      "node_modules/.pnpm/pino@9.14.0/node_modules/pino/README.md",
      "node_modules/pino/docs/transports.md",
      "node_modules/@pinojs/redact/benchmarks/basic.js",
      "node_modules/x/examples/demo.js",
      "node_modules/x/.github/workflows/ci.yml",
      "node_modules/x/CHANGELOG.md",
      "node_modules/x/test/unit.js",
    ]) {
      assert.equal(isShippableStagingPath(p), false, p);
    }
  });

  it("KEEPS licence and notice files", () => {
    // A redistributed dependency's licence must travel with it. Dropping these to tidy
    // the artifact would be an attribution failure, not a cleanup.
    for (const p of [
      "node_modules/pino/LICENSE",
      "node_modules/x/LICENSE.md",
      "node_modules/x/NOTICE",
    ]) {
      assert.equal(isShippableStagingPath(p), true, p);
    }
  });

  it("admits real runtime files — non-vacuity", () => {
    for (const p of [
      "dist/index.js",
      "dist/index.d.ts",
      "package.json",
      "dist/bin/aoa-worker-desktop.js",
    ]) {
      assert.equal(isShippableStagingPath(p), true, p);
    }
  });
});

describe("DSK-003 — a stray file is a failure", () => {
  const manifest = buildStagingManifest(FILES, { version: "0.1.0", platform: "win32" });
  const onDisk = FILES.map((f) => ({ path: f.path, text: f.text }));

  it("accepts a root that matches exactly", () => {
    assert.deepEqual(verifyStagingRoot(onDisk, manifest), { ok: true });
  });

  it("REJECTS a file present on disk but absent from the manifest", () => {
    // "Everything I listed is present" is not "nothing else is here", and only the second
    // is worth anything for an artifact about to be signed.
    const withStray = [...onDisk, { path: "dist/.env", text: "SECRET=1" }];
    const result = verifyStagingRoot(withStray, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "undeclared_file");
    assert.ok(result.detail.includes("dist/.env"));
  });

  it("rejects a manifest entry with no file on disk", () => {
    const result = verifyStagingRoot(onDisk.slice(1), manifest);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_file");
  });

  it("rejects a file whose content does not match its digest", () => {
    const tampered = onDisk.map((f) =>
      f.path.endsWith("index.js") ? { ...f, text: "export const a = 999;" } : f);
    const result = verifyStagingRoot(tampered, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "digest_mismatch");
  });

  it("rejects SAME-LENGTH tampering, which the size check cannot see", () => {
    // The case that makes the digest comparison load-bearing. Every other tampering test
    // changes the length, so the size check catches it first and a mutant deleting the
    // digest comparison survives. Swapping bytes without changing the count is exactly
    // what an attacker editing a shipped file would do.
    const original = FILES.find((f) => f.path.endsWith("index.js")).text;
    const sameLength = `export const a = 9;`;
    assert.equal(sameLength.length, original.length, "the two must be the same length");
    assert.notEqual(sameLength, original);
    const tampered = onDisk.map((f) =>
      f.path.endsWith("index.js") ? { ...f, text: sameLength } : f);
    const result = verifyStagingRoot(tampered, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "digest_mismatch");
  });

  it("rejects a file whose size does not match", () => {
    const tampered = onDisk.map((f) =>
      f.path.endsWith("package.json") ? { ...f, text: '{"name":"dd"}' } : f);
    assert.equal(verifyStagingRoot(tampered, manifest).ok, false);
  });

  it("declares a closed failure vocabulary", () => {
    const produced = [
      verifyStagingRoot([...onDisk, { path: "x", text: "y" }], manifest),
      verifyStagingRoot(onDisk.slice(1), manifest),
      verifyStagingRoot(
        onDisk.map((f) => (f.path.endsWith("index.js") ? { ...f, text: "z" } : f)), manifest),
    ];
    for (const r of produced) {
      assert.equal(r.ok, false);
      assert.ok(STAGING_VERIFY_FAILURES.includes(r.reason), r.reason);
    }
    assert.equal(new Set(produced.map((r) => r.reason)).size, 3);
  });

  it("refuses an empty root rather than calling it a match", () => {
    // Zero files verified against a three-file manifest is not a pass, and an empty
    // manifest verified against an empty root is not an artifact.
    assert.equal(verifyStagingRoot([], manifest).ok, false);
    const emptyManifest = buildStagingManifest([], { version: "0.1.0", platform: "win32" });
    assert.equal(verifyStagingRoot([], emptyManifest).ok, false);
  });
});

describe("DSK-003 — a symlink in the artifact is refused, never followed", () => {
  // A REAL defect in the first version of the assembler, found by comparing its file
  // count against the tree's: it used `statSync`, followed 36 symlinks in a `pnpm deploy`
  // root, and declared 3548 files where 346 existed. Two harms, and the second is worse
  // than the bloat: a junction pointing OUTSIDE the staging root pulls external files
  // into an artifact about to be signed — for a pnpm store, potentially the whole store.
  //
  // Refusing rather than skipping is deliberate. A symlink in a shipped installer is
  // either a duplicate (bloat) or a pointer into a machine that will not exist at install
  // time. Silently dropping it would produce an artifact missing a file it needs.
  const fsFor = (entries) => ({
    readdir: (dir) => Object.keys(entries).filter((p) => {
      const rest = p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : null;
      return rest !== null && !rest.includes("/");
    }).map((p) => p.slice(dir.length + 1)),
    lstat: (p) => entries[p] ?? { kind: "dir" },
    readFile: (p) => entries[p]?.text ?? "",
  });

  it("refuses a root containing a symlink", () => {
    const entries = {
      "root/dist": { kind: "dir" },
      "root/dist/index.js": { kind: "file", text: "a" },
      "root/node_modules": { kind: "dir" },
      "root/node_modules/pino": { kind: "symlink" },
    };
    const result = collectStagingFiles("root", fsFor(entries));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "symlink_in_artifact");
    assert.ok(result.detail.includes("node_modules/pino"));
  });

  it("collects a link-free root — non-vacuity", () => {
    const entries = {
      "root/dist": { kind: "dir" },
      "root/dist/index.js": { kind: "file", text: "a" },
      "root/package.json": { kind: "file", text: "{}" },
    };
    const result = collectStagingFiles("root", fsFor(entries));
    assert.equal(result.ok, true);
    assert.deepEqual(result.files.map((f) => f.path).sort(), ["dist/index.js", "package.json"]);
  });

  it("refuses a symlinked DIRECTORY, not just a file", () => {
    const entries = {
      "root/node_modules": { kind: "symlink" },
      "root/package.json": { kind: "file", text: "{}" },
    };
    assert.equal(collectStagingFiles("root", fsFor(entries)).reason, "symlink_in_artifact");
  });

  it("refuses rather than skipping, so nothing the host needs goes missing", () => {
    // Skipping would produce an artifact that verifies and then fails to run.
    const entries = {
      "root/package.json": { kind: "file", text: "{}" },
      "root/link": { kind: "symlink" },
    };
    const result = collectStagingFiles("root", fsFor(entries));
    assert.equal(result.ok, false);
  });
});
