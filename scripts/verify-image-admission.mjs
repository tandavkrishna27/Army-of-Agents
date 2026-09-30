#!/usr/bin/env node
/**
 * verify-image-admission.mjs — CLI wrapper around the pure image-admission
 * logic in `scripts/lib/image-admission.mjs` (DEP-001).
 *
 * This is the filesystem/argv layer only: it loads the signed-digest allowlist,
 * the trust-root public key (PEM), and a per-image admission bundle
 * (`{digest, signature, provenance}`), then delegates the decision to
 * `evaluateAdmission`. It admits ONLY allowlisted, signed, provenance-matched
 * digests and exits NON-ZERO (fail-closed) on any rejection, missing file, or
 * parse error.
 *
 * D1 (DEP-002) invokes this before running any image so that only recorded,
 * signed digests are launched; a tampered or unsigned digest exits 1.
 *
 * Usage:
 *   node scripts/verify-image-admission.mjs \
 *     --allowlist docker/images/allowlist.json \
 *     --trust-root <public-key.pem> \
 *     --bundle <admission-bundle.json>
 *
 *   # or a single digest+signature+provenance on the CLI:
 *   node scripts/verify-image-admission.mjs \
 *     --allowlist docker/images/allowlist.json --trust-root key.pem \
 *     --digest sha256:... --signature <base64> --source-revision <sha>
 *
 * Defaults: --allowlist docker/images/allowlist.json,
 *           --trust-root docker/images/trust-root.pub.pem.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { evaluateAdmission } from "./lib/image-admission.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Assemble the admission input from CLI args + files. Returns
 * `{input}` or throws a descriptive Error (mapped to a fail-closed exit).
 */
export function buildAdmissionInput(args, deps = {}) {
  const readFile = deps.readFile ?? ((f) => readFileSync(f, "utf8"));
  const readJsonFile = deps.readJson ?? ((f) => JSON.parse(readFile(f)));

  const allowlistPath = args.allowlist ?? "docker/images/allowlist.json";
  const trustRootPath = args["trust-root"] ?? "docker/images/trust-root.pub.pem";

  const allowlist = readJsonFile(allowlistPath);
  const trustRootPem = readFile(trustRootPath);

  let bundle;
  if (args.bundle) {
    bundle = readJsonFile(args.bundle);
  } else {
    bundle = {
      digest: args.digest,
      signature: args.signature,
      provenance: args["source-revision"]
        ? { sourceRevision: args["source-revision"] }
        : args.provenance
          ? readJsonFile(args.provenance)
          : undefined,
    };
  }

  return {
    input: {
      digest: bundle.digest,
      signature: bundle.signature,
      provenance: bundle.provenance,
      allowlist,
      trustRoot: { publicKey: trustRootPem },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  try {
    ({ input } = buildAdmissionInput(args));
  } catch (err) {
    // A missing/unreadable/invalid input file is a fail-closed REJECT, not a crash.
    console.error(`image admission: REJECTED — input error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }

  const result = evaluateAdmission(input);
  if (result.admitted) {
    console.log(`image admission: ADMITTED — ${result.reason}`);
    process.exit(0);
  }
  console.error(`image admission: REJECTED — ${result.reason}`);
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
