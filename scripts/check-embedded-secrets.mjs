#!/usr/bin/env node
/**
 * check-embedded-secrets.mjs — DSK-003 Lane D, clause (1): "no credential is embedded".
 *
 * Walks a directory and fails if any file contains something shaped like a credential.
 * The detection lives in `lib/embedded-secret-scan.mjs`, which is pure and separately
 * tested — including the half that matters most, that PLANTED CI test identities are
 * actually found. A scanner that finds nothing looks exactly like a scanner that looks
 * for nothing.
 *
 * INTENDED TARGET: the PACKAGED artifact, not the source tree. Source proves nothing
 * about what packaging swept in — a `.env` beside the entry point, a fixture, a keystore
 * file from a developer's machine. It takes a directory argument precisely so DSK-003
 * Lane C can point it at the installer staging root once one exists.
 *
 *   node scripts/check-embedded-secrets.mjs <dir> [--max-bytes N]
 *
 * Exit 0 = clean, 1 = findings (or a bad invocation). Findings print WHERE, never WHAT.
 *
 * Dependencies: Node built-ins only.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { scanFileSetForSecrets } from "./lib/embedded-secret-scan.mjs";

/** Directories never worth walking; none of them ships inside an artifact. */
const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", ".next", "coverage"]);

/** Files above this are treated as binary payloads and skipped, with a printed count. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function collectFiles(root, maxBytes) {
  const files = [];
  let skippedLarge = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue; // an unreadable entry is not a credential; the manifest check is elsewhere
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxBytes) {
        skippedLarge += 1;
        continue;
      }
      let text;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      files.push({ path: path.relative(root, abs).split(path.sep).join("/"), text });
    }
  };
  walk(root);
  return { files, skippedLarge };
}

function main(argv) {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const root = positional[0];
  if (!root) {
    console.error("usage: node scripts/check-embedded-secrets.mjs <dir> [--max-bytes N]");
    return 1;
  }
  const maxFlag = argv.find((a) => a.startsWith("--max-bytes="));
  const maxBytes = maxFlag ? Number(maxFlag.split("=")[1]) : DEFAULT_MAX_BYTES;

  let stats;
  try {
    stats = statSync(root);
  } catch {
    console.error(`embedded-secret scan: ${root} does not exist`);
    return 1;
  }
  if (!stats.isDirectory()) {
    console.error(`embedded-secret scan: ${root} is not a directory`);
    return 1;
  }

  const { files, skippedLarge } = collectFiles(root, maxBytes);
  const findings = scanFileSetForSecrets(files);

  // NON-VACUITY, printed. "0 findings" over 0 files is not a pass, and a reader of CI
  // output should never have to guess which one happened.
  console.log(
    `embedded-secret scan: ${files.length} file(s) scanned under ${root}` +
      (skippedLarge > 0 ? `, ${skippedLarge} over the size cap skipped` : ""),
  );
  if (files.length === 0) {
    console.error("embedded-secret scan: NO FILES SCANNED — refusing to report a pass");
    return 1;
  }

  if (findings.length > 0) {
    console.error(`embedded-secret scan: FAIL — ${findings.length} finding(s)`);
    for (const f of findings) {
      // WHERE, never WHAT: this output goes to CI logs.
      console.error(`  ${f.file}:${f.line}  [${f.patternId}]`);
    }
    return 1;
  }

  console.log("embedded-secret scan: PASS");
  return 0;
}

process.exit(main(process.argv.slice(2)));
