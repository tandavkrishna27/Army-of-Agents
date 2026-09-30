// -----------------------------------------------------------------------------
// workflow-verdict — DEP-013's pure core: A CHECK'S VERDICT NEEDS A NAMED CONSUMER.
//
// The defect this closes is NOT that a lane went red. `d1-merge-train` failed on three
// consecutive integration-branch merges (2026-08-29 / 08-30 / 08-31), uploaded a complete
// evidence bundle every single time exactly as DEP-004 specified, and **all three expired
// unread**. Production was specified, built and honoured. CONSUMPTION WAS NEVER SPECIFIED
// AT ALL. Five days of that is indistinguishable, from every dashboard this programme
// consults, from five days of green.
//
// This module holds every decision that can be made without touching the network, so each
// one is a pure function with a killable mutant. The network lives in the two CLIs
// (`scripts/reconcile-workflow-verdicts.mjs`, `scripts/check-verdict-consumer-freshness.mjs`).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR DECISIONS, and why each is shaped the way it is
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. REPORTABLE IS SUCCESS-ONLY, NEVER AN ENUMERATION OF BAD CONCLUSIONS (§5.1).
//    An earlier draft of the design listed `failure` / `cancelled` / `timed_out`. Measured
//    across this repository's last 300 runs on 2026-09-04, the conclusions produced are
//    exactly `success` (209), `cancelled` (60) and `failure` (31) — THREE VALUES. The draft
//    had enumerated precisely the set the repo had happened to show its author, and
//    `cancelled` was in it only because `cross-platform-weekly`'s three blank weeks taught
//    it. GitHub also terminates runs as `neutral`, `skipped`, `stale`, `startup_failure`
//    and `action_required`; every one of those would have read as "not reportable", i.e.
//    silently green. Inverting to success-only removes the author's experience from the
//    predicate entirely, which is the only way an enumeration built from encounter can be
//    fixed.
//
// 2. TWO STALENESS MODES, because wall-clock is wrong for a path-filtered lane (§5.2).
//    `d1-merge-train.yml` declares an 18-entry `paths:` filter. "No run in N hours" there
//    usually means no push touched a configured path, and reporting that would create an
//    incident whose ONLY repair is forcing a matching push — the mirror image of a gate
//    nobody can pass. `coverage` asks the right question instead ("is the newest matching
//    commit covered by a run?") and is CORRECTLY SILENT on a quiet path. `cadence` asks
//    wall-clock against the workflow's own cron, which is the only thing that can see a
//    schedule that stopped firing. Neither substitutes for the other.
//
// 3. THE UNIT IS A `(workflow, branch)` STREAM, NEVER A WORKFLOW (§5.4). `d1-merge-train`
//    declares `branches: [main, docs/replatform-program]`. Reading "the latest run of this
//    workflow" repo-wide lets a green on one branch mask a red on the other — and the
//    masked branch would be `docs/replatform-program`, which is where the incident that
//    motivated this ticket actually happened. A consumer that could not have reported the
//    incident that motivated it is not a consumer.
//
// 4. THE HEARTBEAT IS CHAINED TO THE PUBLISH, NEVER TO THE RUN (§5.3). A reconciler that
//    starts and then dies — bad token, rate limit, throwing evaluator, API outage — still
//    records a RECENT COMPLETED RUN. `completed` is not a synonym for `succeeded`, and
//    `succeeded` is not a synonym for `consumed`. A reader that asserts "the reconciler
//    completed recently" stays green while nothing whatsoever was read: a heartbeat that
//    beats when it is dead. So the heartbeat is the PUBLISHED ARTIFACT — a marker the
//    reconciler writes as its LAST action — and `evaluateConsumerFreshness` reads that and
//    nothing else.
//
// The `paths:` filter and the cron are read from THE WORKFLOW FILE ITSELF and never
// re-declared in the manifest, so a path added to a lane cannot drift from what the
// consumer tests. The manifest declares only what a machine cannot infer: which streams are
// watched, in which mode, with what tolerance, and — for every stream that is NOT watched —
// what would have to change for it to be.
// -----------------------------------------------------------------------------

import { parseYaml } from "./yaml-lite.mjs";

/** The ONLY non-reportable completed conclusion. See decision 1 above. */
export const SUCCESS_CONCLUSION = "success";

/** Every completed conclusion GitHub can produce. Used by the tests to exercise the FULL
 * vocabulary — including the five this repository has never once produced, which are
 * exactly the ones no future reader would think to add to an enumeration. It is NOT used
 * by the predicate: a predicate that consults a list is the defect. */
export const ALL_COMPLETED_CONCLUSIONS = Object.freeze([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "action_required",
]);

export const WATCH_MODES = Object.freeze(["coverage", "cadence", "not-watched"]);

// ─────────────────────────────────────────────────────────────────────────────
// Run classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SUCCESS-ONLY. A completed run is reportable unless its conclusion is exactly `success`.
 *
 * A `null`/absent conclusion on a completed run is REPORTABLE, deliberately: the one thing
 * this function may never do is decide that something it does not recognise is fine.
 *
 * @param {{status?: string, conclusion?: string|null}} run
 */
export function isReportableRun(run) {
  if (!run || typeof run !== "object") return false;
  if (run.status !== "completed") return false;
  return run.conclusion !== SUCCESS_CONCLUSION;
}

/** Newest-first array in, newest COMPLETED run out (or null). */
export function newestCompletedRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((r) => r && r.status === "completed") ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Actions `paths:` filter matching
// ─────────────────────────────────────────────────────────────────────────────

/** Translate one GitHub filter pattern into a RegExp.
 *  `**` crosses `/`; `*` and `?` do not. Everything else is literal. */
function patternToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Does `file` match a GitHub Actions `paths:` list? Negations (`!pattern`) are honoured in
 * order — LAST MATCH WINS — which is GitHub's own rule.
 *
 * An EMPTY/absent list means "no filter", i.e. every file matches. That is GitHub's
 * semantics for a `push:` trigger with no `paths:`, and getting it wrong in the other
 * direction would make an unfiltered lane silently unwatchable.
 */
export function matchesPathFilter(file, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  let matched = false;
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    if (patternToRegExp(body).test(file)) matched = !negated;
  }
  return matched;
}

/** True when ANY file in the commit matches the lane's `paths:` filter. */
export function commitMatchesPaths(commit, patterns) {
  const files = Array.isArray(commit?.files) ? commit.files : [];
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return files.some((f) => matchesPathFilter(f, patterns));
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-file description (the declaration is read, never re-declared)
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the `on:` sub-block text (col-0 `on:` until the next col-0 key).
 *  Same technique as `scripts/check-ci-lanes.mjs`, which parses the same files. */
export function extractOnBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s+\S/.test(l));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

/** `yaml-lite` flattens `schedule: - cron: "…"` (a sequence of mappings, outside its
 *  supported subset) to the STRING `cron: "…"`. Both shapes are accepted here so the
 *  parser's representation cannot silently drop a schedule. */
function normaliseCrons(schedule) {
  if (!Array.isArray(schedule)) return [];
  const out = [];
  for (const entry of schedule) {
    if (entry && typeof entry === "object" && typeof entry.cron === "string") {
      out.push(entry.cron.trim());
      continue;
    }
    if (typeof entry === "string") {
      const m = /^cron:\s*(.+)$/.exec(entry.trim());
      if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return out;
}

/**
 * Read a workflow file's own declaration.
 * @returns {{triggers: object, pushBranches: string[], pushPaths: string[], crons: string[],
 *            hasPush: boolean, hasSchedule: boolean}}
 */
export function describeWorkflow(text) {
  const onText = extractOnBlock(text);
  if (onText == null) throw new Error("no top-level `on:` trigger block found");
  const doc = parseYaml(onText);
  const triggers = doc && typeof doc === "object" && doc.on && typeof doc.on === "object" ? doc.on : {};
  const push = triggers.push && typeof triggers.push === "object" ? triggers.push : null;
  return {
    triggers,
    hasPush: Object.prototype.hasOwnProperty.call(triggers, "push"),
    hasSchedule: Object.prototype.hasOwnProperty.call(triggers, "schedule"),
    pushBranches: Array.isArray(push?.branches) ? push.branches.map(String) : [],
    pushPaths: Array.isArray(push?.paths) ? push.paths.map(String) : [],
    crons: normaliseCrons(triggers.schedule),
  };
}

/**
 * The shortest interval a cron list can fire at, in hours. Fail-closed: an expression this
 * cannot read THROWS rather than defaulting, because a silently-wrong interval is a
 * cadence check that never reports.
 *
 * Deliberately narrow — it reads the shapes this repository authors (`0 6 * * 0`,
 * `0 8 * * *`, `0 *\/6 * * *`) and refuses the rest.
 */
export function cronIntervalHours(crons) {
  const list = Array.isArray(crons) ? crons : [crons];
  const intervals = list.map((expr) => {
    const fields = String(expr).trim().split(/\s+/);
    if (fields.length !== 5) throw new Error(`unreadable cron expression: ${JSON.stringify(expr)}`);
    const [minute, hour, dom, month, dow] = fields;
    const simple = (f) => /^(\*|\d+)$/.test(f);
    const stepOf = (f) => {
      const m = /^\*\/(\d+)$/.exec(f);
      return m ? Number(m[1]) : null;
    };
    for (const f of [minute, hour, dom, month, dow]) {
      if (!simple(f) && stepOf(f) === null) {
        throw new Error(`unreadable cron field ${JSON.stringify(f)} in ${JSON.stringify(expr)}`);
      }
    }
    if (month !== "*") throw new Error(`unsupported monthly cron: ${JSON.stringify(expr)}`);
    if (dow !== "*" && dom !== "*") throw new Error(`ambiguous DOM+DOW cron: ${JSON.stringify(expr)}`);
    if (dow !== "*") return 24 * 7;
    if (dom !== "*") throw new Error(`unsupported day-of-month cron: ${JSON.stringify(expr)}`);
    const hourStep = stepOf(hour);
    if (hourStep !== null) return hourStep;
    if (hour === "*") {
      const minuteStep = stepOf(minute);
      if (minuteStep !== null) return minuteStep / 60;
      return 1;
    }
    return 24;
  });
  if (intervals.length === 0) throw new Error("no cron expressions to read");
  return Math.min(...intervals);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-stream evaluation
// ─────────────────────────────────────────────────────────────────────────────

function hoursBetween(laterIso, earlierIso) {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 3_600_000;
}

function finding(stream, code, detail, extra = {}) {
  return { stream: streamKey(stream), workflow: stream.workflow, branch: stream.branch ?? null, code, detail, ...extra };
}

export function streamKey(stream) {
  return `${stream.workflow}@${stream.branch ?? "*"}`;
}

/**
 * CADENCE — for `schedule`-triggered streams. Wall-clock against the workflow's OWN cron
 * times the stream's declared tolerance.
 *
 * @param {{stream: object, runs: object[], intervalHours: number, now: string}} input
 * @returns {object|null} a finding, or null when the stream is healthy
 */
export function evaluateCadenceStream({ stream, runs, intervalHours, now }) {
  const latest = newestCompletedRun(runs);
  if (!latest) {
    return finding(stream, "no_completed_run", "the schedule has never produced a completed run");
  }
  if (isReportableRun(latest)) {
    return finding(
      stream,
      "not_success",
      `latest completed run concluded \`${latest.conclusion ?? "null"}\``,
      { runUrl: latest.url ?? null, sha: latest.headSha ?? null, conclusion: latest.conclusion ?? null },
    );
  }
  const tolerance = Number(stream.toleranceMultiplier);
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return finding(stream, "manifest_tolerance_unreadable", "cadence stream declares no usable toleranceMultiplier");
  }
  const budget = intervalHours * tolerance;
  const age = hoursBetween(now, latest.completedAt);
  if (age > budget) {
    return finding(
      stream,
      "cadence_stale",
      `last success is ${age.toFixed(1)}h old; the cron interval is ${intervalHours}h and the declared tolerance is ×${tolerance} (${budget}h)`,
      { runUrl: latest.url ?? null, ageHours: age },
    );
  }
  return null;
}

/**
 * COVERAGE — for `push`-triggered streams. Is the NEWEST commit on this branch that matches
 * the workflow's own `paths:` filter covered by a successful run?
 *
 * ★ THE SILENT HALF IS THE POINT. A branch with no matching commit reports NOTHING. Under a
 * wall-clock rule, `b9ab89e36` (2026-09-03) — which produced no `d1-merge-train` run because
 * none of its files match the lane's 18-entry filter — would be a reported incident whose
 * only possible repair is forcing a push that touches `docker/**`. That is an incident
 * nobody can honestly close.
 *
 * @param {{stream: object, commits: object[]|null, runs: object[], paths: string[]}} input
 */
export function evaluateCoverageStream({ stream, commits, runs, paths, workflowPresentOnBranch = true }) {
  // ★★★ A WORKFLOW THAT IS NOT ON THE BRANCH CANNOT RUN THERE — and reporting that would be
  // an incident nobody can close, which is the exact failure §5.2 rejects wall-clock staleness
  // for. FOUND BY THE LIVE DRY-RUN, not by reasoning: the first real sweep reported
  // `d1-merge-train.yml@main uncovered_commit 185deeaba`. That is true as stated — 185deeaba
  // touches `.dockerignore` and `docker/research/**`, both in the lane's filter, and the lane
  // has ZERO runs on main — but the CAUSE is that `d1-merge-train.yml` exists only on
  // `docs/replatform-program`. The only repair for that finding would be landing the workflow
  // on main, which is a programme decision and not a CI incident. The declaration stays
  // (§5.4: designed for now rather than discovered then); it simply owes nothing until the
  // file is there, and it starts owing automatically on the day it is, with nobody to remember.
  if (workflowPresentOnBranch === false) return null;
  if (commits == null) return null; // the branch does not exist — nothing is owed
  const targetIndex = commits.findIndex((c) => commitMatchesPaths(c, paths));
  if (targetIndex === -1) return null; // quiet path, correctly silent
  const target = commits[targetIndex];

  // ★★ A RUN AT A DESCENDANT COVERS IT — found by REAL DATA, not by reasoning. `50380b6f7`
  // (2026-08-25) produced a green `d1-merge-train` run while touching only
  // `docs/replatform/GO-BOOK.md` and a result doc, neither of which matches the lane's 18-entry
  // filter. GitHub matches `paths:` against EVERY commit in a push and then starts ONE run at
  // the push TIP, so a matching commit's run is very often recorded against a later sha. A rule
  // of "the matching commit must have a run of its own" would have reported that green,
  // fully-covered merge as an uncovered commit — a false incident, on the exact lane this ticket
  // is about, in the exact window it is about. `commits` is newest-first, so every index ≤
  // targetIndex is the target or a descendant of it.
  const covering = new Set(commits.slice(0, targetIndex + 1).map((c) => c.sha));
  const forSha = (Array.isArray(runs) ? runs : []).filter((r) => r && covering.has(r.headSha));
  if (forSha.length === 0) {
    return finding(
      stream,
      "uncovered_commit",
      `\`${String(target.sha).slice(0, 9)}\` matches the lane's paths: filter but produced no run`,
      { sha: target.sha },
    );
  }
  const latest = newestCompletedRun(forSha);
  if (!latest) return null; // a run exists and is still going — not yet a verdict
  if (isReportableRun(latest)) {
    return finding(
      stream,
      "not_success",
      `\`${String(latest.headSha ?? target.sha).slice(0, 9)}\` concluded \`${latest.conclusion ?? "null"}\``,
      { runUrl: latest.url ?? null, sha: latest.headSha ?? target.sha, conclusion: latest.conclusion ?? null },
    );
  }
  return null;
}

/**
 * Sweep every watched stream.
 *
 * `data` is keyed by `streamKey(stream)` and supplies what only the network knows:
 * `{ runs, commits }`. `workflows` is keyed by workflow filename and supplies the file's own
 * `describeWorkflow` output.
 *
 * ★ ANTI-VACUITY. Zero watched streams THROWS. A sweep that examines nothing and reports
 * nothing is indistinguishable from a healthy one, which is this ticket's entire subject.
 */
export function evaluateStreams({ manifest, workflows, data, now }) {
  const streams = manifestStreams(manifest);
  const watched = streams.filter((s) => s.watch !== "not-watched");
  if (watched.length === 0) {
    throw new Error("workflow-verdict: zero WATCHED streams — a sweep that examines nothing reports nothing");
  }
  const findings = [];
  for (const stream of watched) {
    const key = streamKey(stream);
    const info = workflows[stream.workflow];
    if (!info) {
      findings.push(finding(stream, "workflow_file_missing", `${stream.workflow} is declared but absent from .github/workflows/`));
      continue;
    }
    const bucket = data[key] ?? {};
    if (stream.watch === "cadence") {
      let intervalHours;
      try {
        intervalHours = cronIntervalHours(info.crons);
      } catch (err) {
        findings.push(finding(stream, "cron_unreadable", err instanceof Error ? err.message : String(err)));
        continue;
      }
      const f = evaluateCadenceStream({ stream, runs: bucket.runs ?? [], intervalHours, now });
      if (f) findings.push(f);
      continue;
    }
    const f = evaluateCoverageStream({
      stream,
      commits: bucket.commits ?? null,
      runs: bucket.runs ?? [],
      paths: info.pushPaths,
      workflowPresentOnBranch: bucket.workflowPresentOnBranch ?? true,
    });
    if (f) findings.push(f);
  }
  return findings;
}

/** Manifest `streams` object → array of stream records carrying their own key fields. */
export function manifestStreams(manifest) {
  const streams = manifest?.streams;
  if (!streams || typeof streams !== "object" || Array.isArray(streams)) return [];
  return Object.entries(streams).map(([key, value]) => ({ key, ...value }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest completeness (§5 clause 3) — the CHEAP direction, verified
// ─────────────────────────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Every workflow file carries at least one entry, and every branch a `push`-triggered
 * workflow declares gets its own — watched, or explicitly not-watched with a reason that
 * says WHAT WOULD HAVE TO CHANGE. A reason is not an excuse.
 *
 * @param {{workflowFiles: string[], workflowInfo: Record<string, object>, manifest: object}} input
 * @returns {{violations: {code: string, detail: string}[]}}
 */
export function evaluateManifestCompleteness({ workflowFiles, workflowInfo, manifest }) {
  const violations = [];
  const push = (code, detail) => violations.push({ code, detail });

  if (!Array.isArray(workflowFiles) || workflowFiles.length === 0) {
    push("no_workflows_discovered", "zero workflow files found — the checker would pass vacuously");
  }

  const consumer = manifest?.consumer;
  if (!consumer || typeof consumer !== "object") {
    push("consumer_missing", "manifest declares no `consumer` block");
  } else {
    if (!isNonEmptyString(consumer.issueTitle)) push("consumer_missing", "consumer.issueTitle is required");
    if (!isNonEmptyString(consumer.issueLabel)) push("consumer_missing", "consumer.issueLabel is required");
    if (!isNonEmptyString(consumer.reconcilerWorkflow)) push("consumer_missing", "consumer.reconcilerWorkflow is required");
    if (!(Number.isFinite(consumer.toleratedSilenceHours) && consumer.toleratedSilenceHours > 0)) {
      push("consumer_missing", "consumer.toleratedSilenceHours must be a positive number");
    }
    if (!isNonEmptyString(consumer.toleratedSilenceReason)) {
      push("consumer_missing", "consumer.toleratedSilenceReason must say why that number — a bound is a committed number, not a habit");
    }
  }

  const streams = manifestStreams(manifest);
  if (streams.length === 0) {
    push("no_manifest_entries", "the manifest declares zero streams — it would pass vacuously");
  }
  if (!streams.some((s) => s.watch !== "not-watched")) {
    push("no_watched_streams", "every stream is not-watched — the consumer would consume nothing");
  }

  const seen = new Set();
  for (const s of streams) {
    if (seen.has(s.key)) push("duplicate_stream", `${s.key} is declared twice`);
    seen.add(s.key);

    if (!isNonEmptyString(s.workflow)) {
      push("stream_shape", `${s.key}: no \`workflow\``);
      continue;
    }
    if (s.key !== streamKey(s)) {
      push("stream_key_mismatch", `${s.key}: key must be \`<workflow>@<branch|*>\` (computed \`${streamKey(s)}\`)`);
    }
    if (!WATCH_MODES.includes(s.watch)) {
      push("stream_shape", `${s.key}: \`watch\` must be one of ${WATCH_MODES.join(" | ")}`);
      continue;
    }
    const info = workflowInfo[s.workflow];
    if (!info) {
      push("stream_workflow_missing", `${s.key}: names a workflow with no file in .github/workflows/`);
      continue;
    }
    if (s.watch === "not-watched") {
      if (!isNonEmptyString(s.reason)) push("reason_missing", `${s.key}: not-watched needs a reason`);
      if (!isNonEmptyString(s.wouldTakeToWatch)) {
        push("reason_missing", `${s.key}: not-watched must say what would have to change — a reason is not an excuse`);
      }
      continue;
    }
    if (s.watch === "coverage") {
      if (!info.hasPush) push("mode_mismatch", `${s.key}: coverage mode needs a \`push\` trigger`);
      if (!isNonEmptyString(s.branch)) push("stream_shape", `${s.key}: coverage mode needs a \`branch\``);
    }
    if (s.watch === "cadence") {
      if (!info.hasSchedule) push("mode_mismatch", `${s.key}: cadence mode needs a \`schedule\` trigger`);
      if (!(Number.isFinite(s.toleranceMultiplier) && s.toleranceMultiplier > 0)) {
        push("stream_shape", `${s.key}: cadence mode needs a positive \`toleranceMultiplier\``);
      }
      try {
        cronIntervalHours(info.crons);
      } catch (err) {
        push("cron_unreadable", `${s.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const byWorkflow = new Map();
  for (const s of streams) {
    if (!byWorkflow.has(s.workflow)) byWorkflow.set(s.workflow, []);
    byWorkflow.get(s.workflow).push(s);
  }
  for (const file of workflowFiles) {
    const entries = byWorkflow.get(file) ?? [];
    if (entries.length === 0) {
      push("workflow_undeclared", `${file}: no manifest entry — a workflow nothing declares is a verdict nobody reads`);
      continue;
    }
    const info = workflowInfo[file];
    if (!info) continue;
    for (const branch of info.pushBranches) {
      if (!entries.some((e) => e.branch === branch)) {
        push(
          "branch_undeclared",
          `${file}: declares \`push\` on \`${branch}\` with no entry for it — a green on one branch would mask a red on the other`,
        );
      }
    }
  }
  return { violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// The published artifact: the issue body and its machine-readable marker
// ─────────────────────────────────────────────────────────────────────────────

export const MARKER_BEGIN = "<!-- verdict-consumer:v1";
export const MARKER_END = "-->";

/** Parse the `last-reconciled` marker out of a published issue body.
 *  @returns {{ok: true, marker: object} | {ok: false, code: string, detail: string}} */
export function parseMarker(body) {
  const text = String(body ?? "");
  const begin = text.indexOf(MARKER_BEGIN);
  if (begin === -1) return { ok: false, code: "marker_absent", detail: "the issue carries no verdict-consumer marker" };
  const end = text.indexOf(MARKER_END, begin + MARKER_BEGIN.length);
  if (end === -1) return { ok: false, code: "marker_unterminated", detail: "the marker comment is not closed" };
  const json = text.slice(begin + MARKER_BEGIN.length, end).trim();
  let marker;
  try {
    marker = JSON.parse(json);
  } catch (err) {
    return { ok: false, code: "marker_unparseable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!marker || typeof marker !== "object") {
    return { ok: false, code: "marker_unparseable", detail: "the marker is not a JSON object" };
  }
  if (!isNonEmptyString(marker.lastReconciledAt) || Number.isNaN(Date.parse(marker.lastReconciledAt))) {
    return { ok: false, code: "marker_no_timestamp", detail: "the marker carries no readable `lastReconciledAt`" };
  }
  return { ok: true, marker };
}

/**
 * Render the consumed artifact. The marker is written LAST and carries the timestamp, the
 * publishing run's URL and the finding count, so "nothing to report" is distinguishable from
 * "did not run" — a reporter that goes quiet when healthy is indistinguishable from a dead
 * one (§5.3).
 */
export function renderIssueBody({ findings, marker, streamsWatched }) {
  const list = Array.isArray(findings) ? findings : [];
  const lines = [];
  lines.push("<!-- Managed by scripts/reconcile-workflow-verdicts.mjs (DEP-013). Edits are overwritten. -->");
  lines.push("");
  lines.push("# Workflow verdict reconciliation");
  lines.push("");
  lines.push(
    "This issue is the CONSUMER for CI verdicts that no required check reads. It is rewritten on " +
      "every reconciliation, including when everything is green — a reporter that goes quiet when " +
      "healthy is indistinguishable from a dead one.",
  );
  lines.push("");
  lines.push(`**Reconciled:** ${marker.lastReconciledAt} · **Streams watched:** ${streamsWatched} · **Findings:** ${list.length}`);
  lines.push("");
  if (list.length === 0) {
    lines.push("## No findings");
    lines.push("");
    lines.push("Every watched stream's latest verdict is `success`, and every cadence stream is within its declared tolerance.");
  } else {
    lines.push("## Findings");
    lines.push("");
    lines.push("| stream | code | detail | run |");
    lines.push("|---|---|---|---|");
    for (const f of list) {
      const run = f.runUrl ? `[run](${f.runUrl})` : "—";
      lines.push(`| \`${f.stream}\` | \`${f.code}\` | ${f.detail} | ${run} |`);
    }
    lines.push("");
    lines.push(
      "A finding here is NOT a claim that the lane must be fixed before anything merges. DEP-013 " +
        "makes these visible within a bounded time; fixing each lane is that lane's own work.",
    );
  }
  lines.push("");
  lines.push(`${MARKER_BEGIN}`);
  lines.push(JSON.stringify(marker));
  lines.push(MARKER_END);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The terminating reader (§5.3) — measured on the PUBLISH, never on the run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is the consumer alive?
 *
 * ★★★ THE HEARTBEAT IS THE PUBLISHED ARTIFACT. The obvious acceptance — "`policy` fails when
 * the reconciler has not COMPLETED recently" — is wrong and reproduces this design's own bug:
 * a reconciler that starts and dies still records a recent completed run.
 *
 * ★ THE BOOTSTRAP TOLERANCE IS SELF-TERMINATING, AND IS NOT A DIAL. The issue cannot exist
 * before the reconciler has ever run, and a blocking reader wired ahead of its own artifact
 * is a gate nobody can pass — a shape this programme has already had to delete once. So the
 * absence of the issue is tolerated on EXACTLY ONE condition: the reconciler has never
 * produced a completed run. `reconcilerCompletedRuns` is consulted ONLY to REFUSE that
 * excuse — it can turn a pass into a fail and never a fail into a pass — so it is not the
 * heartbeat, and the moment the consumer runs once, the tolerance is gone for good with no
 * human flip required. A reconciler that RAN, COMPLETED and published nothing fails here,
 * which is the control that would have caught this design's first draft.
 *
 * @param {{issue: {body?: string}|null, reconcilerCompletedRuns: number, now: string,
 *          toleratedSilenceHours: number}} input
 * @returns {{ok: boolean, code: string, detail: string, ageHours?: number}}
 */
export function evaluateConsumerFreshness({ issue, reconcilerCompletedRuns, now, toleratedSilenceHours }) {
  if (!(Number.isFinite(toleratedSilenceHours) && toleratedSilenceHours > 0)) {
    return { ok: false, code: "tolerance_unreadable", detail: "consumer.toleratedSilenceHours is not a positive number" };
  }
  const ranCount = Number.isFinite(reconcilerCompletedRuns) ? reconcilerCompletedRuns : 0;
  if (!issue) {
    if (ranCount > 0) {
      return {
        ok: false,
        code: "ran_but_never_published",
        detail:
          `the reconciler has ${ranCount} completed run(s) and NO published issue exists. A run record is ` +
          "adjacent to consumption; the published artifact is chained to it. Nothing was read.",
      };
    }
    return {
      ok: true,
      code: "not_bootstrapped",
      detail:
        "the reconciler has never produced a completed run, so no issue can exist yet. This tolerance " +
        "is self-terminating: the first completed reconciler run removes it permanently.",
    };
  }
  const parsed = parseMarker(issue.body);
  if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail };
  const ageHours = hoursBetween(now, parsed.marker.lastReconciledAt);
  if (!Number.isFinite(ageHours)) {
    return { ok: false, code: "marker_no_timestamp", detail: "the marker timestamp could not be compared to now" };
  }
  if (ageHours > toleratedSilenceHours) {
    return {
      ok: false,
      code: "stale",
      detail: `the consumer last published ${ageHours.toFixed(1)}h ago; the tolerated silence is ${toleratedSilenceHours}h`,
      ageHours,
    };
  }
  return { ok: true, code: "fresh", detail: `last published ${ageHours.toFixed(1)}h ago`, ageHours };
}
