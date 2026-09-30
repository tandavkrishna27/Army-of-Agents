#!/usr/bin/env node
/**
 * check-bundled-snapshot-inputs.mjs
 *
 * FND-005 build reproducibility gate. The authoritative repository/CI build
 * (`pnpm build`) must consume only pinned checked-in inputs, perform no network
 * fetch, and leave tracked bytes unchanged. This dependency-free checker (Node
 * stdlib + `node:crypto`) validates the committed manifest
 * `scripts/bundled-snapshots.manifest.json` and, for any pinned snapshot file
 * that is present on disk, verifies its SHA-256 matches the pinned digest.
 *
 * Contract:
 *   - The manifest pins each bundled snapshot's `file`, `sourceUrl`, `version`,
 *     `sha256`, and `order`. The set of pinned files must be exactly the known
 *     bundled snapshots, each with its canonical source URL, unique files, and
 *     a strictly 1..N `order` that matches array position (a reorder fails).
 *   - The snapshot JSON files themselves stay generated (gitignored). This
 *     manifest is the checked-in provenance/digest pin. `pnpm build` runs this
 *     checker at `prebuild` (network-free). Intentional refresh is the explicit
 *     `pnpm refresh:bundled-snapshots` (network) which runs this checker with
 *     `--write` to re-pin digests from the freshly fetched files.
 *   - A present snapshot whose bytes drift from the pinned digest fails with an
 *     actionable message; an absent snapshot (fresh checkout / CI policy lane)
 *     is fine — only the manifest shape is enforced there.
 *
 * Usage:
 *   node scripts/check-bundled-snapshot-inputs.mjs            # verify
 *   node scripts/check-bundled-snapshot-inputs.mjs --write    # re-pin digests
 *   node scripts/check-bundled-snapshot-inputs.mjs --root <dir>   # test harness
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const MANIFEST_REL = "scripts/bundled-snapshots.manifest.json";

// The complete, canonical set of pinned bundled snapshots. The manifest must
// cover exactly these files, each with its canonical CDN source URL. Changing a
// manifest entry's source away from its canonical value is rejected.
export const EXPECTED_SNAPSHOTS = [
  {
    file: "ui/src/aoa-marketplace-snapshot.json",
    sourceUrl: "https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json",
  },
  {
    file: "ui/src/aoa-connectors-snapshot.json",
    sourceUrl: "https://meteoritelabs.github.io/aoa-marketplace-cdn/connectors.json",
  },
];

const REQUIRED_ENTRY_FIELDS = ["file", "sourceUrl", "version", "sha256", "order"];
const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function readOrNull(abs) {
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Validate the manifest and (for present files) verify digests. Returns
 * { errors, notes, manifest }. `errors` non-empty ⇒ failure.
 */
export async function runSnapshotCheck(root) {
  const errors = [];
  const notes = [];
  const manifestAbs = path.join(root, MANIFEST_REL);

  const raw = await readOrNull(manifestAbs);
  if (raw == null) {
    errors.push(`${MANIFEST_REL}: missing`);
    return { errors, notes, manifest: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    errors.push(`${MANIFEST_REL}: invalid JSON (${err.message})`);
    return { errors, notes, manifest: null };
  }

  if (typeof manifest.version !== "number") {
    errors.push(`${MANIFEST_REL}: missing numeric "version"`);
  }
  if (!Array.isArray(manifest.snapshots) || manifest.snapshots.length === 0) {
    errors.push(`${MANIFEST_REL}: "snapshots" must be a non-empty array`);
    return { errors, notes, manifest };
  }

  const expectedByFile = new Map(EXPECTED_SNAPSHOTS.map((s) => [s.file, s.sourceUrl]));
  const seenFiles = new Set();

  for (let i = 0; i < manifest.snapshots.length; i += 1) {
    const entry = manifest.snapshots[i];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${MANIFEST_REL}: snapshot at index ${i} is not an object`);
      continue;
    }
    const label = typeof entry.file === "string" && entry.file ? entry.file : `index ${i}`;

    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!(field in entry)) {
        errors.push(`${MANIFEST_REL}: snapshot ${label} is missing required field "${field}"`);
      }
    }

    // Ordering: `order` is strictly 1..N matching array position. Swapping the
    // array order OR the order values (either direction) breaks this.
    if (entry.order !== i + 1) {
      errors.push(`${MANIFEST_REL}: snapshot ${label} has order ${JSON.stringify(entry.order)} but must be ${i + 1} (matching position)`);
    }

    if (typeof entry.version !== "string" || entry.version.trim() === "") {
      errors.push(`${MANIFEST_REL}: snapshot ${label} field "version" must be a non-empty string`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      errors.push(`${MANIFEST_REL}: snapshot ${label} field "sha256" must be 64 lowercase hex chars`);
    }

    if (typeof entry.file !== "string" || !expectedByFile.has(entry.file)) {
      errors.push(`${MANIFEST_REL}: snapshot ${label} is not a known bundled snapshot file`);
      continue;
    }
    if (seenFiles.has(entry.file)) {
      errors.push(`${MANIFEST_REL}: duplicate snapshot file "${entry.file}"`);
    }
    seenFiles.add(entry.file);

    // Source URL must match the canonical source for this file (a changed
    // source is rejected).
    const expectedSource = expectedByFile.get(entry.file);
    if (entry.sourceUrl !== expectedSource) {
      errors.push(`${MANIFEST_REL}: snapshot ${entry.file} sourceUrl ${JSON.stringify(entry.sourceUrl)} must be ${JSON.stringify(expectedSource)}`);
    }

    // Digest verification for a present snapshot (absent ⇒ shape-only).
    if (SHA256_RE.test(String(entry.sha256))) {
      const abs = path.join(root, entry.file);
      let bytes = null;
      try {
        bytes = await readFile(abs);
      } catch (err) {
        if (!(err && err.code === "ENOENT")) {
          errors.push(`${entry.file}: unreadable (${(err && err.code) || "error"})`);
        }
      }
      if (bytes == null) {
        notes.push(`${entry.file}: absent (generated snapshot; digest not verified)`);
      } else {
        const actual = sha256Hex(bytes);
        if (actual !== entry.sha256) {
          errors.push(
            `${entry.file}: sha256 ${actual} does not match the pinned digest ${entry.sha256} ` +
              `(run \`pnpm refresh:bundled-snapshots\` to re-pin after an intentional update)`,
          );
        }
      }
    }
  }

  // Every known snapshot must be pinned.
  for (const { file } of EXPECTED_SNAPSHOTS) {
    if (!seenFiles.has(file)) {
      errors.push(`${MANIFEST_REL}: known bundled snapshot "${file}" is not pinned`);
    }
  }

  return { errors, notes, manifest };
}

/**
 * `--write`: recompute digests + versions from the present snapshot files and
 * rewrite the manifest. Never invoked by build or test — only by the explicit
 * `pnpm refresh:bundled-snapshots` command after a network fetch.
 */
export async function writeManifest(root) {
  const errors = [];
  const snapshots = [];
  for (let i = 0; i < EXPECTED_SNAPSHOTS.length; i += 1) {
    const { file, sourceUrl } = EXPECTED_SNAPSHOTS[i];
    const abs = path.join(root, file);
    let bytes;
    try {
      bytes = await readFile(abs);
    } catch {
      errors.push(`${file}: missing — fetch the snapshot before re-pinning`);
      continue;
    }
    let version = "unknown";
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      version = typeof parsed.generatedAt === "string" ? parsed.generatedAt : String(parsed.schemaVersion ?? "unknown");
    } catch {
      errors.push(`${file}: not valid JSON`);
      continue;
    }
    snapshots.push({ file, sourceUrl, version, sha256: sha256Hex(bytes), order: i + 1 });
  }
  if (errors.length > 0) return { errors };
  const manifest = {
    version: 1,
    description:
      "FND-005 pinned bundled-snapshot inputs. `pnpm build` verifies checked-in snapshots against these digests network-free; `pnpm refresh:bundled-snapshots` re-fetches and rewrites this manifest. The snapshot JSON files themselves remain generated (gitignored); this manifest is the checked-in provenance/digest pin verified by scripts/check-bundled-snapshot-inputs.mjs.",
    snapshots,
  };
  await writeFile(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { errors: [] };
}

function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

async function main() {
  const argv = process.argv.slice(2);
  const root = resolveRoot(argv);
  if (argv.includes("--write")) {
    const { errors } = await writeManifest(root);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("bundled snapshot manifest: re-pinned");
    return;
  }
  const { errors, notes } = await runSnapshotCheck(root);
  for (const note of notes) console.log(`note: ${note}`);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("bundled snapshot inputs: PASS");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
