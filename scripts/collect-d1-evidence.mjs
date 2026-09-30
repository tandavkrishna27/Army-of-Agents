#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-004 — D1 merge-train failure-evidence collector (Linux/CI + Docker).
//
//   node scripts/collect-d1-evidence.mjs \
//     --compose docker-compose.d1.yml --out ./d1-evidence \
//     --run-id "$GITHUB_RUN_ID" --reason "d1-merge-train failure"
//
// Invoked by d1-merge-train.yml's `if: failure()` step. Gathers the four retained
// evidence sections from the live D1 stack — per-service container logs, the
// worker event stream, a control-plane DB-state dump, and the object-store
// (MinIO) manifests — assembles them via the pure scripts/lib/d1-evidence-bundle
// lib, and writes the bundle + manifest + per-section files into --out for
// `actions/upload-artifact`.
//
// Every gather is BEST-EFFORT: a stack that never came up (or a section that
// legitimately produced nothing) yields an empty section marked `present:false`,
// never a crash and never a silently dropped section. The bundle ALWAYS carries
// all four sections (fail-closed shape from buildEvidenceBundle).
// -----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEvidenceBundle, validateEvidenceBundle, REQUIRED_SECTIONS } from "./lib/d1-evidence-bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The D1 compose services whose logs are retained on failure.
const D1_SERVICES = [
  "postgres",
  "minio",
  "toxiproxy",
  "migrate",
  "control-plane",
  "control-plane-b",
  "worker-a",
  "worker-b",
  "fake-provider",
  "test-runner",
];

function parseArgs(argv) {
  const args = { compose: "docker-compose.d1.yml", out: "d1-evidence", runId: null, reason: "d1-merge-train failure" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--compose") args.compose = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--run-id") args.runId = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
  }
  return args;
}

/** Run a command, returning stdout (best-effort: never throws). */
function run(cmd, cmdArgs) {
  try {
    const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (res.error) return { ok: false, out: String(res.error.message || res.error) };
    return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

function dc(composeFile, extra) {
  return run("docker", ["compose", "-f", composeFile, ...extra]);
}

/** Section 1 — per-service container logs. */
function gatherLogs(composeFile) {
  const logs = [];
  for (const service of D1_SERVICES) {
    const { ok, out } = dc(composeFile, ["logs", "--no-color", "--timestamps", service]);
    if (ok && out.trim() !== "") logs.push({ service, content: out });
  }
  return logs;
}

// Section 2 — the durable worker event stream. DEP-007 repoint: the real JOB-005 ledger
// is `job_events` (there is NO `worker_events` table and no `seq` column — the pre-DEP-007
// query silently returned an empty events section on every retained failure bundle). The
// trace the telemetry-contract test reconstructs (exec-source→job→attempt→lease→sandbox)
// lives in these rows. Retain the MOST-RECENT 500 rows CHRONOLOGICALLY by `occurred_at`
// (tie-broken by the per-attempt `sequence`) — NOT by `sequence` alone, which is a
// per-attempt ordinal that would evict a job's low-sequence rows under campaign load.
export const EVENTS_QUERY =
  "SELECT COALESCE(json_agg(row_to_json(e) ORDER BY e.occurred_at, e.sequence), '[]') " +
  "FROM (SELECT * FROM job_events ORDER BY occurred_at DESC, sequence DESC LIMIT 500) e;";

/** Section 2 — worker event stream (control-plane `job_events` table, best-effort). */
export function gatherEvents(composeFile) {
  const { ok, out } = dc(composeFile, [
    "exec", "-T", "postgres",
    "psql", "-U", "aoa", "-d", "aoa", "-t", "-A", "-c", EVENTS_QUERY,
  ]);
  if (!ok) return [];
  try {
    const parsed = JSON.parse(out.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Section 3 — control-plane DB-state dump (schema-only + row counts, best-effort). */
function gatherDbState(composeFile) {
  const dump = dc(composeFile, ["exec", "-T", "postgres", "pg_dump", "-U", "aoa", "-s", "aoa"]);
  const counts = dc(composeFile, [
    "exec", "-T", "postgres",
    "psql", "-U", "aoa", "-d", "aoa", "-t", "-A", "-c",
    "SELECT relname || '=' || n_live_tup FROM pg_stat_user_tables ORDER BY relname;",
  ]);
  const state = {};
  if (dump.ok && dump.out.trim() !== "") state.schemaDump = dump.out;
  if (counts.ok && counts.out.trim() !== "") state.rowCounts = counts.out.trim().split(/\r?\n/).filter(Boolean);
  return state;
}

/** Section 4 — object-store (MinIO) manifests (best-effort). */
function gatherObjectManifests(composeFile) {
  // The minio container ships the `mc` client; alias + recursive listing.
  const alias = dc(composeFile, ["exec", "-T", "minio", "mc", "alias", "set", "local", "http://127.0.0.1:9000", "minioadmin", "minioadmin"]);
  if (!alias.ok) return [];
  const { ok, out } = dc(composeFile, ["exec", "-T", "minio", "mc", "ls", "--recursive", "--json", "local"]);
  if (!ok) return [];
  const manifests = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      manifests.push(JSON.parse(t));
    } catch {
      /* non-JSON noise line; skip */
    }
  }
  return manifests;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const composeFile = path.isAbsolute(args.compose) ? args.compose : path.join(repoRoot, args.compose);
  const outDir = path.isAbsolute(args.out) ? args.out : path.join(repoRoot, args.out);

  console.log(`[collect-d1-evidence] gathering from ${composeFile} -> ${outDir}`);

  const inputs = {
    runId: args.runId,
    reason: args.reason,
    generatedAt: new Date().toISOString(),
    logs: gatherLogs(composeFile),
    events: gatherEvents(composeFile),
    dbState: gatherDbState(composeFile),
    objectManifests: gatherObjectManifests(composeFile),
  };

  const bundle = buildEvidenceBundle(inputs);
  const violations = validateEvidenceBundle(bundle);
  if (violations.length > 0) {
    // Structural failure of the assembler itself — should never happen.
    console.error("[collect-d1-evidence] FAIL: assembled bundle is structurally incomplete:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(bundle.manifest, null, 2));
  writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2));
  for (const name of REQUIRED_SECTIONS) {
    writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(bundle.sections[name], null, 2));
  }

  console.log("[collect-d1-evidence] retained sections:");
  for (const s of bundle.manifest.sections) {
    console.log(`  - ${s.name}: present=${s.present} count=${s.count} bytes=${s.bytes} sha256=${s.sha256.slice(0, 12)}…`);
  }
  console.log(`[collect-d1-evidence] wrote bundle + ${REQUIRED_SECTIONS.length} section files to ${outDir}`);
}

// Run as a CLI entry point only. When imported (e.g. by the DEP-007 telemetry-contract
// D1 test, which calls gatherEvents directly, or by the collector unit test) main() must
// NOT execute — importing the module has zero side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
