#!/usr/bin/env node
/**
 * check-schema-migration-drift.mjs
 *
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK — and, its dual, a truth asserted in two
 * files where only one is read.
 *
 * Closes E8-F005 (docs/replatform/epics/E8-browser-automation/findings.md). The Drizzle
 * SCHEMA (`packages/db/src/schema/*.ts`) and the committed MIGRATIONS + meta snapshot
 * (`packages/db/src/migrations/`) are two independent statements of the same truth, and
 * until this gate nothing compared them. The `migrations` CI job validates the JOURNAL
 * (idx contiguity, a SQL file per entry, the committed-snapshot prevId chain) — all of
 * which stay valid while the schema and the DDL disagree. `drizzle-kit generate` is run
 * by a human and its output committed; nothing re-runs it in check mode. So reverting a
 * `.notNull()` in a schema file while leaving its migration in place ships CI-GREEN
 * (measured: BRW-004 mutation E5 on `agentRuntimeTrustRules.agentId`), and the RELAXING
 * direction — the load-bearing one — is exactly the direction nothing detects.
 *
 * THE MECHANISM, and why it is C14-SAFE.
 *   `drizzle-kit generate` emits a new migration ONLY when the compiled schema diverges
 *   from the LATEST meta snapshot. It does this by DIFFING schema-against-snapshot, not by
 *   re-deriving SQL from scratch. Therefore hand-authored DDL that drizzle-kit provably
 *   cannot emit — CLAUDE.md rule 1 / Decision #122's two C14 classes: (a) hand-appended
 *   idempotency guards + data backfills (e.g. 0189, 0195), and (b) delta-free `--custom`
 *   cluster/security DDL (roles, GRANT/REVOKE, RLS, policies, SECURITY DEFINER — e.g.
 *   0211, 0213, 0214, 0261, 0267, 0279) — does NOT change the snapshot and does NOT
 *   produce a delta. A naive "regenerate the whole set and diff the SQL" would false-fail
 *   on every one of those; asserting schema-vs-SNAPSHOT EMPTINESS does not. This is why
 *   the gate is GREEN on the unmodified HEAD tree (proven) and only reddens on a real
 *   schema↔snapshot divergence.
 *
 * HOW IT RUNS.
 *   1. COMPILES `packages/db/src/schema/*.ts` → `dist/schema/*.js` first, UNCONDITIONALLY
 *      (drizzle.config.ts reads the compiled schema; a stale dist would diff the OLD schema
 *      and false-pass — E8-F005 P2). `tsc` is deterministic + DB-free.
 *   2. Copies the committed `src/migrations` (SQL + meta) into a throwaway scratch dir
 *      INSIDE packages/db, and writes a scratch drizzle config pointing `out` at it.
 *      RELATIVE paths, cwd = packages/db: drizzle-kit silently no-ops on a Windows
 *      absolute/forward-slash schema glob (measured), so both schema and out stay
 *      relative-to-cwd exactly as the real config expresses them.
 *   3. Runs `drizzle-kit generate` against the scratch out. If it writes ANY new
 *      migration file, the schema and the committed snapshot DISAGREE → FAIL, and the
 *      generated SQL is printed so the diff is legible.
 *   4. The scratch dir + config are always removed. The real tree is never touched, and
 *      NO database is contacted (`generate` is DB-free).
 *
 * Usage:
 *   node scripts/check-schema-migration-drift.mjs
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const DB_DIR = path.join(ROOT, "packages", "db");
const DIST_SCHEMA = path.join(DB_DIR, "dist", "schema");
const SRC_MIGRATIONS = path.join(DB_DIR, "src", "migrations");
const SCRATCH_DIRNAME = ".schema-drift-scratch";
const SCRATCH_CONFIG = ".schema-drift.config.ts";

/**
 * PURE. Given the recursive file listings of the scratch migrations dir BEFORE and AFTER
 * `drizzle-kit generate`, decide whether the schema drifted from the committed snapshot.
 *
 * `generate` emits a NEW `NNNN_*.sql` and a NEW `meta/NNNN_snapshot.json` for any delta,
 * and touches nothing when the schema matches the snapshot. So a file PRESENT AFTER but
 * NOT BEFORE is the drift signal; the clean tree produces an empty `added` set.
 *
 * @param {{before: string[], after: string[]}} input relative paths within the scratch dir
 * @returns {{drift: boolean, added: string[]}}
 */
export function classifyDrift(input) {
  const before = new Set(Array.isArray(input?.before) ? input.before : []);
  const after = Array.isArray(input?.after) ? input.after : [];
  const added = after.filter((f) => !before.has(f)).sort();
  return { drift: added.length > 0, added };
}

function listFilesRecursive(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk("");
  return out.sort();
}

function distSchemaPresent() {
  try {
    return (
      statSync(DIST_SCHEMA).isDirectory() &&
      readdirSync(DIST_SCHEMA).some((f) => f.endsWith(".js"))
    );
  } catch {
    return false;
  }
}

/**
 * Compile `packages/db/src/schema/*.ts` → `dist/schema/*.js` BEFORE generating.
 *
 * WHY UNCONDITIONAL (E8-F005 P2). drizzle.config.ts reads the COMPILED schema, so a
 * stale `dist` makes the gate diff the OLD schema against the committed snapshot — it
 * false-passes the exact `.notNull()` relaxation it targets (measured: reverting
 * `agentRuntimeTrustRules.agentId` in src without rebuilding shipped exit 0). Compiling
 * first makes the check self-contained: it always compares the schema on disk NOW.
 *
 * This mirrors the FIRST half of the db package's own `generate` script
 * (`tsc -p tsconfig.json && drizzle-kit generate`) — the half the gate previously skipped.
 * `tsc` is deterministic and DB-free (pure TS→JS emit, no database contact), preserving
 * the gate's policy-lane property.
 */
function compileDbSchema() {
  const bin = resolveTscBin();
  const result = spawnSync(
    process.execPath,
    [bin, "-p", "tsconfig.json"],
    { cwd: DB_DIR, encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(
      `Could not spawn tsc to compile @armyofagents/db: ${result.error.message}. Run \`pnpm install\`.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not compile @armyofagents/db schema (tsc exit ${result.status}). The drift check ` +
        `needs a FRESH dist/schema/*.js because drizzle.config.ts reads the compiled schema.`,
    );
  }
}

function resolveTscBin() {
  const candidates = [
    path.join(DB_DIR, "node_modules", "typescript", "bin", "tsc"),
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "Could not locate typescript/bin/tsc under packages/db or the repo root. Run `pnpm install`.",
  );
}

function resolveDrizzleKitBin() {
  const candidates = [
    path.join(DB_DIR, "node_modules", "drizzle-kit", "bin.cjs"),
    path.join(ROOT, "node_modules", "drizzle-kit", "bin.cjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "Could not locate drizzle-kit/bin.cjs under packages/db or the repo root. Run `pnpm install`.",
  );
}

function main() {
  if (!existsSync(SRC_MIGRATIONS)) {
    console.error(`FAIL: committed migrations dir not found at ${SRC_MIGRATIONS}`);
    process.exit(1);
  }

  // Compile-first, UNCONDITIONALLY: a stale dist would diff the OLD schema and false-pass
  // (E8-F005 P2). tsc is deterministic + DB-free, so this stays a policy-lane check.
  console.log("Compiling @armyofagents/db schema (tsc) so the gate reads the current schema…");
  compileDbSchema();
  if (!distSchemaPresent()) {
    console.error(`FAIL: ${DIST_SCHEMA} still has no compiled schema after tsc.`);
    process.exit(1);
  }

  const scratchDir = path.join(DB_DIR, SCRATCH_DIRNAME);
  const scratchMigrations = path.join(scratchDir, "migrations");
  const scratchConfig = path.join(DB_DIR, SCRATCH_CONFIG);
  // Paths inside the scratch config are RELATIVE to cwd = DB_DIR, forward-slash.
  const relOut = `./${SCRATCH_DIRNAME}/migrations`;

  const cleanup = () => {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(scratchConfig, { force: true });
  };

  try {
    cleanup();
    mkdirSync(scratchDir, { recursive: true });
    cpSync(SRC_MIGRATIONS, scratchMigrations, { recursive: true });

    writeFileSync(
      scratchConfig,
      'import { defineConfig } from "drizzle-kit";\n\n' +
        "export default defineConfig({\n" +
        '  schema: "./dist/schema/*.js",\n' +
        `  out: "${relOut}",\n` +
        '  dialect: "postgresql",\n' +
        // generate is DB-free; a placeholder URL keeps drizzle-kit's config validator happy.
        '  dbCredentials: { url: "postgres://drift-check-does-not-connect" },\n' +
        "});\n",
    );

    const before = listFilesRecursive(scratchMigrations);

    const bin = resolveDrizzleKitBin();
    const run = spawnSync(
      process.execPath,
      [bin, "generate", "--config", SCRATCH_CONFIG],
      {
        cwd: DB_DIR,
        encoding: "utf8",
        input: "",
        timeout: 240_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdout = run.stdout || "";
    const stderr = run.stderr || "";

    if (run.error) {
      console.error(`FAIL: drizzle-kit generate could not be spawned: ${run.error.message}`);
      console.error(stdout);
      console.error(stderr);
      return 1;
    }
    if (run.status !== 0) {
      console.error(
        `FAIL: drizzle-kit generate exited ${run.status}. The drift check cannot render a ` +
          "verdict, so it fails closed. Output follows:",
      );
      console.error(stdout);
      console.error(stderr);
      return 1;
    }

    const after = listFilesRecursive(scratchMigrations);
    const { drift, added } = classifyDrift({ before, after });

    if (drift) {
      console.error(
        "FAIL: packages/db/src/schema/*.ts has drifted from the committed Drizzle migrations.\n" +
          "`drizzle-kit generate` produced a NEW migration when diffing the schema against the\n" +
          "committed meta snapshot, which means the two disagree. This is the E8-F005 class:\n" +
          "a schema edit (e.g. reverting a `.notNull()`) whose migration was never regenerated,\n" +
          "or a migration with no schema behind it. Run `pnpm --filter @armyofagents/db generate`\n" +
          "and commit the result — or revert the schema edit — so the two statements agree.\n",
      );
      console.error("New migration files drizzle-kit would emit:");
      for (const f of added) console.error(`  + ${f}`);
      const newSql = added.filter((f) => f.endsWith(".sql"));
      for (const f of newSql) {
        console.error(`\n----- ${f} -----`);
        try {
          console.error(readFileSync(path.join(scratchMigrations, f), "utf8").trim());
        } catch {
          /* best-effort diagnostics */
        }
      }
      return 1;
    }

    console.log(
      "OK: Drizzle schema matches the committed migrations/snapshot — `drizzle-kit generate` " +
        "produced no delta.",
    );
    return 0;
  } finally {
    // Runs on EVERY path — `main` returns a code rather than calling process.exit inside the
    // try, because process.exit would skip this finally and strand the scratch dir/config.
    cleanup();
  }
}

// Run only as a CLI; the `.test.mjs` sibling imports `classifyDrift`/`ROOT` without spawning.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
