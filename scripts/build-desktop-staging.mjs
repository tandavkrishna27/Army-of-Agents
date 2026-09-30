#!/usr/bin/env node
/**
 * build-desktop-staging.mjs — turn a deployed directory into a verified artifact (DSK-003).
 *
 * WHAT THIS IS AND IS NOT. It does not invent a packaging toolchain. Given a LINK-FREE
 * directory containing the built packages and their runtime dependencies, it makes that
 * directory an ARTIFACT:
 *
 *   1. PRUNE what must never ship (sourcemaps, tests, fixtures, `.env`).
 *   2. BUILD the manifest — the declared file set, digest bound to version + platform.
 *   3. VERIFY the root against it, which is what proves the prune and the manifest agree
 *      and that nothing undeclared is present.
 *   4. SCAN for embedded credentials, over real bytes rather than a hypothetical set.
 *
 * Step 3 is the one worth having. A manifest built by walking the same directory it then
 * verifies would be trivially self-consistent — so the verification is not there to catch
 * the manifest being wrong, it is there to catch the PRUNE being wrong: any file the
 * pruner should have removed and did not is now an undeclared file, and undeclared is a
 * failure.
 *
 * PRODUCING THAT INPUT IS AN UNSOLVED STEP, and this script refuses rather than pretending
 * otherwise. Measured on this workspace:
 *
 *   pnpm deploy --prod                          complete, but 36 SYMLINKS → refused
 *   pnpm deploy --prod --node-linker=hoisted    link-free, but NO node_modules at all
 *
 * Neither is shippable. The gap is real packaging work (a bundler, or a copy step that
 * dereferences pnpm's links) and it is recorded in the DSK-003 result rather than papered
 * over with a command that does not work.
 *
 * Once a link-free root exists:
 *   node scripts/build-desktop-staging.mjs --root <root> --version 0.1.0 --platform win32
 *
 * Exit 0 = a verified, credential-free artifact. Non-zero = a reason, never a guess.
 *
 * SIGNING IS NOT HERE. REL-004 owns signing and attestation of every desktop installer
 * artifact; `installer-admission.mjs` consumes the digest this emits. Packaging the
 * verified root into a `.msi`/`.pkg` and notarizing it needs a toolchain and certificates
 * this script deliberately does not reach for.
 *
 * Dependencies: Node built-ins only.
 */

import { lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { scanFileSetForSecrets } from "./lib/embedded-secret-scan.mjs";
import {
  buildStagingManifest,
  collectStagingFiles,
  isShippableStagingPath,
  verifyStagingRoot,
} from "./lib/staging-manifest.mjs";

const MANIFEST_NAME = "staging-manifest.v1.json";

/**
 * The real filesystem, shaped for `collectStagingFiles`.
 *
 * `lstatSync`, NEVER `statSync`. The first version of this script used `statSync`, which
 * FOLLOWS links: pointed at a `pnpm deploy` root it followed 36 symlinks and declared
 * 3548 files where 346 existed. The bloat was the lesser harm — a junction pointing
 * outside the root pulls external files into an artifact about to be signed.
 */
export const realIo = {
  readdir: (dir) => readdirSync(dir),
  lstat: (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return { kind: "symlink" };
    if (st.isDirectory()) return { kind: "dir" };
    if (st.isFile()) return { kind: "file" };
    return { kind: "other" };
  },
  readFile: (p) => readFileSync(p, "utf8"),
};

function arg(argv, name) {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  const root = arg(argv, "root");
  const version = arg(argv, "version");
  const platform = arg(argv, "platform");
  if (!root || !version || !platform) {
    console.error(
      "usage: node scripts/build-desktop-staging.mjs --root <dir> --version <v> --platform <win32|darwin>",
    );
    return 1;
  }
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`staging: ${root} is not a directory`);
    return 1;
  }

  // 1. Collect, refusing any symlink, then prune what must not ship. The manifest name
  //    is excluded because it is written afterwards and cannot describe itself.
  const collected = collectStagingFiles(root, realIo);
  if (!collected.ok) {
    console.error(`staging: ${collected.reason} — ${collected.detail}`);
    console.error(
      "staging: the artifact must be link-free. `pnpm deploy` produces symlinks; a " +
        "link-free complete root is an unsolved packaging step (see DSK-003 result S5c).",
    );
    return 1;
  }

  const pruned = [];
  const files = [];
  for (const file of collected.files) {
    if (file.path === MANIFEST_NAME) continue;
    if (isShippableStagingPath(file.path)) {
      files.push(file);
      continue;
    }
    rmSync(path.join(root, ...file.path.split("/")), { force: true });
    pruned.push(file.path);
  }

  if (files.length === 0) {
    console.error("staging: nothing left to ship — refusing to declare an empty artifact");
    return 1;
  }

  // 2. Build.
  const manifest = buildStagingManifest(files, { version, platform });

  // 3. Verify — this catches a PRUNE that missed something, not a manifest that lied.
  const after = collectStagingFiles(root, realIo);
  if (!after.ok) {
    console.error(`staging: ${after.reason} — ${after.detail}`);
    return 1;
  }
  const onDisk = after.files.filter((f) => f.path !== MANIFEST_NAME);
  const verified = verifyStagingRoot(onDisk, manifest);
  if (!verified.ok) {
    console.error(`staging: verification FAILED (${verified.reason}) — ${verified.detail}`);
    return 1;
  }

  // 4. Scan, over the real bytes.
  const findings = scanFileSetForSecrets(files);
  if (findings.length > 0) {
    console.error(`staging: embedded-secret scan FAILED — ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.patternId}]`);
    return 1;
  }

  writeFileSync(path.join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `staging: ${manifest.files.length} file(s) declared, ${pruned.length} pruned, ` +
      `scan clean\nstaging: digest ${manifest.digest}`,
  );
  return 0;
}

// Only when RUN, never when imported. A module that exits at load cannot be tested, and
// `realIo`'s use of `lstatSync` is exactly the thing that needs a test — a mutant swapping
// it for `statSync` survived until this guard made the module importable.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
