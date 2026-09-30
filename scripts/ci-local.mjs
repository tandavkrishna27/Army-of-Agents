#!/usr/bin/env node
// Run this repository's CI jobs LOCALLY, in the same form CI runs them.
//
// ★ WHY THIS EXISTS, AND WHY IT PARSES THE WORKFLOW RATHER THAN LISTING COMMANDS.
// A hand-maintained copy of CI's command list drifts, and a drifted local runner is worse than
// none: it reports green for a suite CI does not run, or red for one it does not have. So this
// reads `.github/workflows/pr.yml` and executes the steps it finds. If CI changes, this changes
// with it.
//
// ★ THE FALSE ALARM THIS REMOVES. A naive `for f in scripts/check-*.mjs; do node $f; done` reports
// `check-browser-suite-executed` and `check-embedded-secrets` as failing, every time, forever. They
// take an argument that only the `browser` job supplies; the `policy` job runs their SELF-TESTS
// (`node --test …test.mjs`) instead. Running the workflow's own steps makes that class of
// phantom failure unrepresentable.
//
// Usage:
//   node scripts/ci-local.mjs                 # the fast gate: policy, lint, brand-check, contract bytes
//   node scripts/ci-local.mjs --all           # adds verify (typecheck + 4 vitest shards) and migrations
//   node scripts/ci-local.mjs --jobs policy   # a named job, or a comma-separated list
//   node scripts/ci-local.mjs --list          # what this can and cannot run here, and why
//   node scripts/ci-local.mjs --all --keep-going
//
// Exit code is 0 only if every job it RAN passed. Jobs it skips are reported, never counted green.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github", "workflows", "pr.yml");

/**
 * Jobs this runner cannot honestly run on this machine, with the reason. A skip is REPORTED, never
 * silently treated as a pass -- a skipped required check that reads as success is the exact failure
 * this repository's CI redesign exists to prevent.
 */
const CANNOT_RUN_HERE = {
  e2e: "embedded-postgres cannot start on Windows CI runners (Issue #114); playwright config skips it",
  "e2e-pgvector": "needs the pgvector service container CI provides",
  browser: "needs `playwright install --with-deps chromium` and a browser sandbox",
  changes: "computes a git diff against the PR base; meaningless locally",
  "ci-required": "an aggregator over other jobs' results; nothing to execute",
};

/**
 * Jobs that need an environment CI provides and this machine may not. Unlike CANNOT_RUN_HERE
 * these are runnable WHEN the environment exists, so the check is dynamic -- and reporting
 * "FAIL" for a missing service would be a lie that trains people to ignore this runner.
 */
const NEEDS_ENV = [
  {
    // ★ PER-STEP, NOT PER-JOB — and that distinction cost a red CI run. Skipping the whole
    // `migrations` job for want of a DATABASE_URL also skipped its journal/snapshot CHAIN
    // assertion, which is inline python and needs no database. A broken `prevId` chain
    // therefore passed locally and failed on GitHub: exactly the round trip this exists to
    // remove. Gate the step that needs the environment; run everything else.
    match: /db:migrate|drizzle-kit (migrate|push)/,
    ok: () => Boolean(process.env.DATABASE_URL),
    why: "needs DATABASE_URL pointing at the postgres CI supplies as a service container",
  },
  {
    // DEP-013's terminating reader. It queries the verdict consumer's PUBLISHED tracking
    // issue over the GitHub API, so without a token it cannot see — and it REFUSES rather
    // than reporting health, which is correct in CI and a lie locally. Note the anchor: this
    // gates ONLY the live CLI. `node --test …check-verdict-consumer-freshness.test.mjs` needs
    // no token, spawns the CLI once per vector and asserts its real exit codes, and is the
    // half that actually catches a regression here — so it must keep running locally. That
    // per-step precision is the same lesson the DATABASE_URL rule above records.
    match: /^node scripts\/check-verdict-consumer-freshness\.mjs\s*$/,
    ok: () => Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
    why: "reads the verdict consumer's published issue over the GitHub API; needs GITHUB_TOKEN (CI supplies it). Locally: GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=MeteoriteLabs/AoA node scripts/ci-local.mjs",
  },
  {
    // The evidence-ledger immutability guard needs a BASE REVISION to compare against, and
    // in CI that is github.event.pull_request.base.sha, which exists only on a PR event.
    // Same per-step precision as the two rules above, and for the same reason: this gates
    // ONLY the live CLI. `node --test …check-evidence-immutability.test.mjs` needs no
    // environment at all — it replays the real historical breach (6fc46988a -> 4379a2c53),
    // its green controls, and the assertion that pr.yml still names the caller — so it
    // keeps running locally and is the half that actually catches a regression here.
    match: /^node scripts\/check-evidence-immutability\.mjs\s*$/,
    ok: () => Boolean(process.env.EVIDENCE_IMMUTABILITY_BASE),
    why: "compares evidence records against a base revision; CI supplies github.event.pull_request.base.sha. Locally: EVIDENCE_IMMUTABILITY_BASE=origin/docs/replatform-program node scripts/ci-local.mjs",
  },
];

/** The reason a single STEP cannot run here, or undefined if it can. */
function envSkipReason(cmd) {
  const rule = NEEDS_ENV.find((r) => r.match.test(cmd));
  return rule && !rule.ok() ? rule.why : undefined;
}

/**
 * The ONE deliberate deviation from CI, named so `--list` and the run summary can STATE it.
 * The source comment at the guard used to claim they did; they did not, because the guard
 * dropped install steps silently. A named reason is the half that makes the claim true.
 */
export const INSTALL_SKIP_REASON =
  "dependency install; this runner assumes a tree that already installs. `policy`'s "
  + "--lockfile-only variant is skipped for a second, stronger reason: CI runs it only when "
  + "a manifest file changed, and running it here can rewrite pnpm-lock.yaml.";

/**
 * `pnpm install` in either of the two forms this parser produces.
 *
 * ★★★ THE SECOND DEFECT, and the reason this is a named constant used on BOTH paths. Fixing
 * the dead 0x08 byte alone moved the surviving-install count 8 -> 7, not 8 -> 0. The guard
 * had only ever sat on the multi-line `run: |` path, while SEVEN of the eight installs are
 * inline `run: pnpm install --frozen-lockfile` steps that the runInline branch pushes and
 * `continue`s on, above the guard. So even a correctly-written regex could only ever have
 * skipped ONE job's install. A dead escape and a placement that covers one eighth of the
 * cases are two defects, and only the first is visible as a byte.
 */
export const IS_INSTALL_STEP = /^pnpm install\b/;

/** The default fast gate: everything cheap that catches most red CI. */
const FAST_JOBS = ["policy", "brand-check", "worker-protocol-contract-bytes", "lint"];

/**
 * Extract `run:` commands per job from the workflow, including multi-line `run: |` blocks.
 * Deliberately a small indent state machine rather than a YAML dependency: this repo has no yaml
 * package installed, and adding one to run CI locally would be its own supply-chain decision.
 */
export function parseJobs(text) {
  const lines = text.split(/\r?\n/);
  const jobs = new Map();
  let job = null;
  let inRun = false;
  let runIndent = 0;

  for (const line of lines) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch && !/^\s*#/.test(line)) {
      job = jobMatch[1];
      if (!jobs.has(job)) jobs.set(job, []);
      inRun = false;
      continue;
    }
    if (!job) continue;

    const runInline = /^(\s+)run:\s*(.+?)\s*$/.exec(line);
    if (runInline && runInline[2] !== "|") {
      // Both paths consult IS_INSTALL_STEP. See its comment: the guard used to exist only on
      // the block path below, which is why seven of eight installs ran regardless of the byte.
      jobs.get(job).push(
        IS_INSTALL_STEP.test(runInline[2])
          ? { deliberateSkip: runInline[2], why: INSTALL_SKIP_REASON }
          : runInline[2],
      );
      inRun = false;
      continue;
    }
    const runBlock = /^(\s+)run:\s*\|\s*$/.exec(line);
    if (runBlock) {
      inRun = true;
      runIndent = runBlock[1].length;
      continue;
    }
    if (inRun) {
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= runIndent) {
        inRun = false;
        continue;
      }
      const cmd = line.trim();
      // ★★★ A HEREDOC IS ONE STEP THIS PARSER CANNOT REPRESENT, AND DROPPING IT SILENTLY IS
      // THE FAILURE THIS FILE IS SUPPOSED TO PREVENT. `migrations` verifies the drizzle
      // journal/snapshot chain with `python <<'PYEOF' … PYEOF`; keeping only the first line
      // would run `python` with no script, read EOF, and exit 0 — a VACUOUS PASS. Proven by
      // mutation: with the first-line-only behaviour, breaking 0271's `prevId` exactly as CI
      // found it still reported `PASS migrations`.
      //
      // Until this executes whole `run:` blocks through a shell, such a step is recorded as
      // UNREPRESENTABLE and surfaced, never counted green.
      if (/<<\s*['"]?\w+['"]?/.test(cmd)) {
        jobs.get(job).push({ unrepresentable: cmd });
        continue;
      }
      // Shell scaffolding inside a block is executed as part of the block, not as a step; keep only
      // the invocations this runner can meaningfully attribute a pass/fail to.
      // Environment setup, not a check. `pnpm install` is skipped here for EVERY job -- and the
      // skip is recorded as a step, never silently dropped, so `--list` and the run summary
      // state the deviation instead of a comment merely claiming they do.
      //
      // ★★★ W19: THIS GUARD WAS DEAD FROM THE DAY IT WAS WRITTEN. It intended `/^pnpm install\b/`
      // but carried a literal 0x08 backspace byte where the two characters backslash-b belonged --
      // a shell heredoc ate the backslash while the file was being written. The pattern therefore
      // demanded a real control character after "install" and matched NOTHING. Eight install steps
      // ran, one of them (`policy`'s --lockfile-only) lockfile-MUTATING and in the DEFAULT fast
      // gate. A literal backspace renders invisibly in every terminal, editor and diff view, which
      // is why it survived review; `cat -A` shows it as ^H. Pinned by
      // scripts/lib/__tests__/ci-local-install-guard.test.mjs, which asserts the surviving-install
      // count is 0 AND that this line carries no control byte. scripts/check-invisible-control-chars.mjs
      // generalizes the byte half to the whole tree.
      //
      // ★ WHY `policy`'s LOCKFILE-ONLY INSTALL IS SKIPPED TOO, DELIBERATELY -- not by accident of
      // the same pattern. It is not a cost decision. In CI that command sits behind TWO conditions
      // this parser cannot see: a step-level `if: github.event_name == 'pull_request'`, and a shell
      // `if` that runs it only when a manifest file changed. The parser keeps lines starting with
      // node/pnpm/npx and drops the `changed=`/`if`/`fi` scaffolding around them, so running it
      // locally does not reproduce CI -- it runs a command CI would usually NOT run, whose side
      // effect (rewriting pnpm-lock.yaml) the `Block manual lockfile edits` step then fails the PR
      // for. Skipping it is the faithful behaviour, and running it would be the unfaithful one.
      if (IS_INSTALL_STEP.test(cmd)) {
        jobs.get(job).push({ deliberateSkip: cmd, why: INSTALL_SKIP_REASON });
        continue;
      }
      if (/^(node|pnpm|npx) /.test(cmd)) jobs.get(job).push(cmd);
    }
  }
  return jobs;
}

function run(cmd) {
  const started = Date.now();
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: ROOT });
  return { code: result.status ?? 1, ms: Date.now() - started };
}

function main() {
  if (!existsSync(WORKFLOW)) {
    console.error(`no workflow at ${WORKFLOW}`);
    process.exit(2);
  }
  const jobs = parseJobs(readFileSync(WORKFLOW, "utf8"));
  const argv = process.argv.slice(2);
  const keepGoing = argv.includes("--keep-going");

  if (argv.includes("--list")) {
    console.log("jobs in pr.yml:\n");
    for (const [name, steps] of jobs) {
      const why = CANNOT_RUN_HERE[name];
      const gated = steps.filter((c) => typeof c === "string" && envSkipReason(c)).length;
      const unrep = steps.filter((c) => typeof c === "object" && c.unrepresentable).length;
      const deviation = steps.filter((c) => typeof c === "object" && c.deliberateSkip).length;
      const mark = why ? "SKIP" : steps.length ? " RUN" : "  --";
      console.log(`  ${mark}  ${name.padEnd(32)} ${steps.length} step(s)${why ? `  — ${why}` : gated || unrep || deviation ? `  (${gated} gated on env, ${unrep} unrepresentable, ${deviation} deliberate deviation)` : ""}`);
    }
    console.log("\nfast gate:", FAST_JOBS.join(", "));
    console.log("\ndeliberate deviation from CI:", INSTALL_SKIP_REASON);
    return;
  }

  const explicit = argv.find((a) => a.startsWith("--jobs="))?.slice(7)
    ?? (argv.includes("--jobs") ? argv[argv.indexOf("--jobs") + 1] : undefined);

  let selected;
  if (explicit) selected = explicit.split(",").map((s) => s.trim()).filter(Boolean);
  else if (argv.includes("--all")) {
    selected = [...jobs.keys()].filter((j) => !CANNOT_RUN_HERE[j] && jobs.get(j).length > 0);
  } else selected = FAST_JOBS;

  const results = [];
  const skipped = [];
  let failed = false;

  for (const name of selected) {
    if (CANNOT_RUN_HERE[name]) {
      skipped.push({ name, why: CANNOT_RUN_HERE[name] });
      continue;
    }
    const steps = jobs.get(name);
    if (!steps || steps.length === 0) {
      skipped.push({ name, why: "no runnable steps found in pr.yml" });
      continue;
    }
    console.log(`\n━━━ ${name} (${steps.length} steps) ━━━`);
    let jobFailed = false;
    let jobMs = 0;
    for (const step of steps) {
      if (typeof step === "object" && step.deliberateSkip) {
        console.log(`\n  - ${step.deliberateSkip}`);
        console.log(`    SKIP — ${step.why}`);
        skipped.push({
          name: `${name}:step`,
          why: `${step.deliberateSkip} — ${step.why}`,
        });
        continue;
      }
      if (typeof step === "object" && step.unrepresentable) {
        console.log(`
  ? ${step.unrepresentable}`);
        console.log("    UNREPRESENTABLE — multi-line run: block; this runner cannot execute it");
        skipped.push({
          name: `${name}:step`,
          why: `${step.unrepresentable} — multi-line run: block, NOT checked here`,
        });
        continue;
      }
      const envWhy = envSkipReason(step);
      if (envWhy) {
        console.log(`
  - ${step}`);
        console.log(`    SKIP — ${envWhy}`);
        skipped.push({ name: `${name}:step`, why: `${step} — ${envWhy}` });
        continue;
      }
      console.log(`\n  $ ${step}`);
      const { code, ms } = run(step);
      jobMs += ms;
      if (code !== 0) {
        jobFailed = true;
        console.log(`  ✗ exit ${code}`);
        if (!keepGoing) break;
      }
    }
    results.push({ name, ok: !jobFailed, ms: jobMs });
    if (jobFailed) {
      failed = true;
      if (!keepGoing) break;
    }
  }

  console.log("\n━━━ summary ━━━");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(32)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  for (const s of skipped) console.log(`  SKIP  ${s.name.padEnd(32)} ${s.why}`);
  if (skipped.length) {
    console.log("\n  ★ Skipped jobs are NOT green. Linux CI remains the authority for them.");
  }
  process.exit(failed ? 1 : 0);
}

// Run only when invoked as a script. The export above exists so
// scripts/lib/__tests__/ci-local-install-guard.test.mjs can call the REAL parser: a pin that
// re-implements the parser it pins cannot catch a regression in the parser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
