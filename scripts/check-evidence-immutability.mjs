#!/usr/bin/env node
/**
 * check-evidence-immutability.mjs
 *
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK.
 *
 * ★ WHY THIS EXISTS. `docs/replatform/artifact-policy.md:54,67` makes every QA and handoff
 * record "write-once from its first commit" — a rerun or correction creates a NEW attempt
 * carrying `Supersedes`, and never edits a prior one. The deny that enforces this,
 * `checkEvidenceImmutability` in `check-distributed-execution-foundation.mjs`, has been on
 * disk and fully unit-tested since FND-005 and, until this file, HAD ZERO PRODUCTION
 * CALLERS. Nothing on any lane ever handed it a real base and candidate tree.
 *
 * The consequence was measured, not asserted. The ledger's rule has already been broken in
 * this repository's own history with CI green:
 *   `docs/replatform/epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md`
 *   was created by 6fc46988a and REWRITTEN IN PLACE by 4379a2c53 (+24/-4), inserting a
 *   "★ CORRECTION" paragraph while the record's own `Supersedes` field still read
 *   "— (E5 has no prior QA record; this is the first)".
 * That exact pair is replayed as the RED case in this guard's self-test, so the deny is
 * proven against real history rather than only against synthetic fixtures. Filed as
 * E0-F014 item 3; this file is its caller.
 *
 * ★ WHY REV-TO-REV, NOT REV-TO-WORKTREE. The ledger is the commit history, not the working
 * copy, and reading BOTH sides out of git blobs makes the comparison byte-exact on a
 * Windows checkout with `core.autocrlf=true` (where a worktree read would compare CRLF
 * against LF and fail on every record).
 *
 * ★ WHY BASE-TO-TIP IS NOT ENOUGH — AND WHY THE PR'S OWN COMMITS ARE WALKED. The policy
 * says a QA/handoff record is immutable "from its first commit", not "from the moment it
 * lands on the target branch". A single base-to-tip comparison can only see records that
 * ALREADY EXISTED at the base, so it enforces the rule exactly where a PR author cannot
 * break it, and not where they can: a PR that ADDS a record in one commit and then
 * REWRITES or DELETES it in a later commit of the same PR is absent from `baseTree`
 * entirely and the comparison returns CLEAN. That hole was reproduced in a throwaway
 * repository and returned `{ok: true}`. So this guard now also walks `base..candidate`,
 * pins each record's content AT THE COMMIT THAT INTRODUCED IT, and denies any later commit
 * in the same pull request that changes or removes it.
 *
 * ★ WHY THIS DOES NOT BLOCK A LEGITIMATE CORRECTION. Under `artifact-policy.md:54,58,67` a
 * rerun, correction or changed decision is expressed by ADDING A NEW attempt file whose
 * `Supersedes` field points BACKWARD at the prior path (`qa-result-template.md:9`,
 * `handoff-template.md:9`). The superseded record is never touched and gets no backlink, so
 * a supersede is a pure addition — and additions are never denied here. Append-only ticket
 * results live under `tickets/`, which `EVIDENCE_RECORD_RE` deliberately excludes, so
 * review-attempt appends are untouched too.
 *
 * ★ SCOPE, STATED RATHER THAN ASSUMED. This runs on `pull_request` events only (see
 * pr.yml), because `base.sha` is the only revision the guard can trust; `github.event.before`
 * on a push is all-zeros for a branch's first push. main is protected, so every evidence
 * record arrives through a pull request and is seen here. Within a PR, a record's
 * introducing commit is the first commit in `base..candidate` that contains it.
 *
 * ★ WHY AN EMPTY BASE IS A FAILURE — AND THE ONE SHAPE IT IS NOT. Measured before writing
 * this: handing the underlying deny a base revision that predates the evidence tree returns
 * ZERO ERRORS — a silent pass that looks identical to a clean run. A mistyped ref, a
 * shallow clone, or a moved directory would therefore disarm this guard without a word. An
 * empty base is refused — UNLESS the base provably predates the ledger itself. The
 * program→main pull request (#323) has base=main, and main legitimately contains no
 * `docs/replatform/` tree at all: on that shape the unconditional refusal fired as a false
 * FAIL from the moment this caller landed (#390), which is the mirror defect of a false
 * pass. The two cases are distinguishable by the ledger's own charter: a base that does
 * NOT contain `docs/replatform/artifact-policy.md` is a PRE-LEDGER base — immutability of
 * base records is vacuous (there are none), and every record is introduced by the PR's own
 * commits, so the within-PR walk below polices all of them against an explicitly empty
 * baseline. A base that DOES contain the policy file but yields zero records is still
 * refused: the ledger exists there, so an empty read means a disarmed clone or a moved
 * directory, exactly the silent-pass this arm was built to catch. The green output states
 * the pre-ledger shape out loud rather than passing it off as a normal run.
 *
 * Usage:
 *   node scripts/check-evidence-immutability.mjs --base <rev> [--candidate <rev>]
 *   EVIDENCE_IMMUTABILITY_BASE=<rev> node scripts/check-evidence-immutability.mjs
 *
 * Exit 0 = no evidence record — one already on the base, or one introduced by the
 * candidate's own commits — was modified, deleted or renamed after its first commit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkEvidenceImmutability } from "./check-distributed-execution-foundation.mjs";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The immutable-record set, kept deliberately identical to `collectEvidenceRecords`
 * inside the foundation checker: `qa/` and `handoffs/` markdown under an epic, README
 * excluded. Materialising a wider set than the deny reads would be theatre.
 */
export const EVIDENCE_RECORD_RE =
  /^docs\/replatform\/epics\/[^/]+\/(?:qa|handoffs)\/(?!README\.md$)[^/]+\.md$/;

/** Pathspec that bounds the per-commit `ls-tree` walk. Purely a narrowing of the regex. */
export const EVIDENCE_ROOT = "docs/replatform/epics";

/**
 * The ledger's charter file. Its presence at a revision is what makes that revision a
 * LEDGER-BEARING one: a base holding this file but zero evidence records is a disarmed
 * read and stays refused; a base without it predates the ledger and an empty record set
 * there is the truth, not a symptom.
 */
export const LEDGER_POLICY_PATH = "docs/replatform/artifact-policy.md";

/**
 * ★ THE GRANDFATHER ALLOWLIST — ruled by the founder 2026-09-14 (explicit pinned pairs;
 * ratchet-from-now), enacted on PR #462. When the pre-ledger-base arm above unblinded the
 * within-PR walk on the program→main PR (#323), the walk found THREE genuine in-place
 * rewrites in the program branch's own history — all committed BEFORE this guard had a
 * production caller (#390, 2026-09-09), on CI that was green at the time. They cannot be
 * un-happened without rewriting published history, and exempting them by path or pattern
 * would exempt FUTURE breaches of the same records. So each historical event is pinned by
 * BOTH commit SHAs: the exact commit that introduced the record and the exact commit that
 * rewrote it. A SHA names one immutable historical event and nothing else — no new commit
 * can ever collide into an entry, so the allowlist can only ever match these three events.
 *
 * The ledger's own account of this ruling is
 * `docs/replatform/epics/E0-foundation/qa/2026-09-14-d0-pre-guard-rewrite-grandfather-a1.md`.
 * The self-test pins the list's LENGTH and verifies every entry against real history
 * (both SHAs must exist, the record must exist at `introducedBy`, and `rewrittenBy` must
 * genuinely change it) — growing or corrupting this list reds CI until deliberately
 * reviewed.
 *
 * A grandfathered rewrite is RE-PINNED, not forgotten: the record's expected content
 * becomes the rewritten blob from `rewrittenBy` onward, so any FOURTH rewrite of the same
 * record — or any later touch of these three — is still denied.
 */
export const GRANDFATHERED_REWRITES = [
  {
    record: "docs/replatform/epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md",
    introducedBy: "6fc46988a4aa1de851e27e9454ecfd5bbe280e77",
    rewrittenBy: "4379a2c53447a861f0bd6398ecef8f70392e07b2",
    // The documented breach that motivated this guard (E0-F014 item 3, this file's header):
    // a "★ CORRECTION" paragraph was inserted in place (+24/-4) while the record's own
    // Supersedes field still read "— (E5 has no prior QA record; this is the first)".
    why: "E0-F014 item 3 founding breach — in-place '★ CORRECTION', Supersedes bypassed",
  },
  {
    record: "docs/replatform/epics/E2-tenant-kernel/qa/2026-08-10-d0-e2-tenant-kernel-21335854f-a5.md",
    introducedBy: "7843b86e25eb1ff9c520308aef7f123fec6997a7",
    rewrittenBy: "6b1af52a4db8a0fa41514db564e8cb622b02e1ba",
    // Found by this investigation (PR #462) the moment the pre-ledger arm unblinded the
    // within-PR walk on the #323 shape: the E2 epic-completion pass edited its own QA
    // record in place instead of appending a superseding attempt.
    why: "E2 completion pair, qa half — pre-guard in-place edit, found by PR #462",
  },
  {
    record: "docs/replatform/epics/E2-tenant-kernel/handoffs/2026-08-10-epic-completion-21335854f-a5.md",
    introducedBy: "7843b86e25eb1ff9c520308aef7f123fec6997a7",
    rewrittenBy: "6b1af52a4db8a0fa41514db564e8cb622b02e1ba",
    why: "E2 completion pair, handoff half — same pre-guard commit pair as the qa half",
  },
];

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    // Capture git's stderr instead of letting it reach the terminal, so an unresolvable
    // revision is reported once, by this guard, in this guard's words.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Write one revision's evidence records into a fresh temp tree, preserving the repo-
 * relative layout the deny walks. Blobs are copied as bytes: no transcoding, no line-
 * ending rewrite, so a difference reported is a real difference.
 *
 * @returns {{root: string, count: number}}
 */
export function materializeEvidenceTree(repoRoot, rev) {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-immutability-"));
  const names = git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", rev])
    .toString("utf8")
    .split("\0")
    .filter((n) => n.length > 0);
  let count = 0;
  for (const rel of names) {
    if (!EVIDENCE_RECORD_RE.test(rel)) continue;
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, git(repoRoot, ["cat-file", "blob", `${rev}:${rel}`]));
    count += 1;
  }
  return { root, count };
}

/**
 * One revision's evidence records as `path -> blob OID`. Object ids are compared instead
 * of bytes here because git already guarantees oid identity IS content identity, and one
 * `ls-tree` per commit is cheap enough to walk every commit in a pull request.
 *
 * @returns {Map<string, string>}
 */
export function listEvidenceOids(repoRoot, rev) {
  const out = git(repoRoot, ["ls-tree", "-r", "-z", rev, "--", EVIDENCE_ROOT]).toString("utf8");
  const oids = new Map();
  for (const entry of out.split("\0")) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const rel = entry.slice(tab + 1);
    if (!EVIDENCE_RECORD_RE.test(rel)) continue;
    // "<mode> SP <type> SP <oid>" — `-z` leaves the path unquoted, so a tab split is safe.
    oids.set(rel, entry.slice(0, tab).split(" ")[2]);
  }
  return oids;
}

/**
 * The candidate's own commits, oldest first: everything reachable from the candidate and
 * not from the base. Empty when the candidate IS the base or an ancestor of it, in which
 * case there are no within-PR introductions to police and the base-to-tip deny is the
 * whole check.
 *
 * @returns {string[]}
 */
/**
 * Whether a revision carries the ledger charter file. Only called after the revision has
 * already been materialised successfully, so a throw here means the PATH is absent at that
 * revision, not that the revision is unreadable.
 *
 * @returns {boolean}
 */
export function revHasLedgerPolicy(repoRoot, rev) {
  try {
    git(repoRoot, ["cat-file", "-e", `${rev}:${LEDGER_POLICY_PATH}`]);
    return true;
  } catch {
    return false;
  }
}

export function listCandidateCommits(repoRoot, base, candidate) {
  return git(repoRoot, ["rev-list", "--reverse", "--topo-order", `${base}..${candidate}`])
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * THE WITHIN-PR PASS. A record is immutable from the commit that introduces it, so:
 *
 *   - every record present at the base is pinned to its base content;
 *   - every record first seen in one of the candidate's commits is pinned to the content
 *     that introducing commit gave it;
 *   - any LATER commit in the same pull request that carries a different blob for a pinned
 *     record is a modification, and a record introduced within the PR that is gone at the
 *     tip was deleted or renamed after its first commit.
 *
 * Records that already existed at the base and are missing or different AT THE TIP belong
 * to the base-to-tip deny (`checkEvidenceImmutability`), whose wording and one-error-per-
 * record accounting are unchanged; they are excluded here so one breach is never counted
 * twice. Additions are never denied — that is how a legitimate `Supersedes` attempt lands.
 *
 * @returns {{errors: string[], grandfatheredHits: Array<{record: string, introducedBy: string, rewrittenBy: string}>}}
 */
export function checkIntroducedRecordImmutability({
  repoRoot,
  base,
  candidate,
  commits,
  grandfathered = GRANDFATHERED_REWRITES,
}) {
  const baseOids = listEvidenceOids(repoRoot, base);
  const candOids = listEvidenceOids(repoRoot, candidate);
  const snapshots = commits.map((sha) => ({ sha, oids: listEvidenceOids(repoRoot, sha) }));

  /** @type {Map<string, {oid: string, since: string | null, index: number}>} */
  const pinned = new Map();
  for (const [rel, oid] of baseOids) pinned.set(rel, { oid, since: null, index: -1 });
  snapshots.forEach((snap, index) => {
    for (const [rel, oid] of snap.oids) {
      if (pinned.has(rel)) continue;
      pinned.set(rel, { oid, since: snap.sha, index });
    }
  });

  const ownedByBaseDeny = new Set();
  for (const [rel, oid] of baseOids) {
    if (!candOids.has(rel) || candOids.get(rel) !== oid) ownedByBaseDeny.add(rel);
  }

  const introducedBy = (intro) =>
    intro.since === null ? `already present at the base ${base}` : `introduced by ${intro.since}`;

  /** @type {Array<{record: string, introducedBy: string, rewrittenBy: string}>} */
  const grandfatheredHits = [];
  /** @type {Map<string, string>} — one error per record; the first breach wins. */
  const errors = new Map();
  snapshots.forEach((snap, index) => {
    for (const [rel, intro] of pinned) {
      if (index <= intro.index || ownedByBaseDeny.has(rel) || errors.has(rel)) continue;
      const oid = snap.oids.get(rel);
      if (oid === undefined || oid === intro.oid) continue;
      // A grandfathered pair matches by RECORD + BOTH exact SHAs, nothing looser. On a
      // match the record is re-pinned to the rewritten blob, so anything that touches it
      // AGAIN — including a later commit repeating the same edit — is still denied.
      if (
        grandfathered.some(
          (g) => g.record === rel && g.introducedBy === intro.since && g.rewrittenBy === snap.sha,
        )
      ) {
        grandfatheredHits.push({ record: rel, introducedBy: intro.since, rewrittenBy: snap.sha });
        pinned.set(rel, { oid, since: snap.sha, index });
        continue;
      }
      errors.set(
        rel,
        `evidence immutability: record ${rel} was ${introducedBy(intro)} and modified again ` +
          `by ${snap.sha} in the same pull request — a QA/handoff record is write-once from ` +
          "its FIRST commit, not from the moment it reaches the target branch",
      );
    }
  });
  for (const [rel, intro] of pinned) {
    if (intro.since === null || ownedByBaseDeny.has(rel) || errors.has(rel)) continue;
    if (candOids.has(rel)) continue;
    errors.set(
      rel,
      `evidence immutability: record ${rel} was ${introducedBy(intro)} and then deleted or ` +
        "renamed later in the same pull request — a record is write-once from its FIRST " +
        "commit; a correction is a NEW attempt file carrying `Supersedes`",
    );
  }
  return { errors: [...errors.values()], grandfatheredHits };
}

/**
 * @param {{repoRoot?: string, base: string, candidate?: string, grandfathered?: Array<{record: string, introducedBy: string, rewrittenBy: string}>}} input
 * @returns {Promise<{ok: boolean, errors: string[], baseCount: number, candidateCount: number, commitCount: number, preLedgerBase?: boolean, grandfatheredHits?: Array<{record: string, introducedBy: string, rewrittenBy: string}>}>}
 */
export async function runEvidenceImmutability(input) {
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const base = typeof input.base === "string" ? input.base.trim() : "";
  const candidate =
    typeof input.candidate === "string" && input.candidate.trim().length > 0
      ? input.candidate.trim()
      : "HEAD";
  if (base.length === 0) {
    return {
      ok: false,
      errors: [
        "evidence immutability: no base revision supplied — pass --base <rev> or set " +
          "EVIDENCE_IMMUTABILITY_BASE. Refusing to run: a guard with no base compares " +
          "nothing and passes.",
      ],
      baseCount: 0,
      candidateCount: 0,
      commitCount: 0,
    };
  }

  let baseTree;
  let candTree;
  try {
    for (const [label, rev] of [
      ["base", base],
      ["candidate", candidate],
    ]) {
      try {
        const tree = materializeEvidenceTree(repoRoot, rev);
        if (label === "base") baseTree = tree;
        else candTree = tree;
      } catch (cause) {
        // A stack trace here would bury the one thing the reader needs. The common causes
        // are a shallow clone and an unexpanded CI expression reaching the shell.
        return {
          ok: false,
          errors: [
            `evidence immutability: cannot read the ${label} revision ${JSON.stringify(rev)} — ` +
              `${String(cause?.stderr ?? cause?.message ?? cause).trim()}. ` +
              "Check the revision exists in this clone (a shallow fetch will not have it).",
          ],
          baseCount: baseTree?.count ?? 0,
          candidateCount: 0,
          commitCount: 0,
        };
      }
    }
    let preLedgerBase = false;
    if (baseTree.count === 0) {
      if (revHasLedgerPolicy(repoRoot, base)) {
        return {
          ok: false,
          errors: [
            `evidence immutability: base revision ${base} holds ZERO evidence records ` +
              `while ${LEDGER_POLICY_PATH} exists there — the ledger is present at that ` +
              "revision, so an empty read is not a clean run, it is a disarmed one: the " +
              "deny returns no errors for an empty base. Check the revision, the clone " +
              "depth, and that docs/replatform/epics/*/{qa,handoffs}/ still exists.",
          ],
          baseCount: 0,
          candidateCount: candTree.count,
          commitCount: 0,
          preLedgerBase: false,
        };
      }
      // The base predates the ledger entirely (no charter file) — the program→main PR
      // shape. Base-record immutability is vacuous; every record is introduced within the
      // PR and the within-PR walk below pins each one from its first commit.
      preLedgerBase = true;
    }
    const { errors } = await checkEvidenceImmutability(baseTree.root, candTree.root);
    const commits = listCandidateCommits(repoRoot, base, candidate);
    const { errors: introErrors, grandfatheredHits } = checkIntroducedRecordImmutability({
      repoRoot,
      base,
      candidate,
      commits,
      ...(input.grandfathered !== undefined ? { grandfathered: input.grandfathered } : {}),
    });
    const allErrors = [...errors, ...introErrors];
    return {
      ok: allErrors.length === 0,
      errors: allErrors,
      baseCount: baseTree.count,
      candidateCount: candTree.count,
      commitCount: commits.length,
      preLedgerBase,
      grandfatheredHits,
    };
  } finally {
    for (const tree of [baseTree, candTree]) {
      if (tree?.root) rmSync(tree.root, { recursive: true, force: true });
    }
  }
}

export function parseArgs(argv, env = {}) {
  let base = typeof env.EVIDENCE_IMMUTABILITY_BASE === "string" ? env.EVIDENCE_IMMUTABILITY_BASE : "";
  let candidate =
    typeof env.EVIDENCE_IMMUTABILITY_CANDIDATE === "string"
      ? env.EVIDENCE_IMMUTABILITY_CANDIDATE
      : "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") base = argv[i + 1] ?? "";
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg === "--candidate") candidate = argv[i + 1] ?? "";
    else if (arg.startsWith("--candidate=")) candidate = arg.slice("--candidate=".length);
  }
  return { base, candidate };
}

async function main() {
  const { base, candidate } = parseArgs(process.argv.slice(2), process.env);
  const result = await runEvidenceImmutability({ base, candidate });
  if (!result.ok) {
    console.error("Evidence-ledger immutability FAILED:");
    for (const err of result.errors) console.error(`  - ${err}`);
    console.error(
      "\nQA and handoff records are write-once (docs/replatform/artifact-policy.md:54,67).\n" +
        "A correction is a NEW attempt file carrying `Supersedes`, never an edit to a prior one.",
    );
    process.exitCode = 1;
    return;
  }
  // Grandfathered matches are DISCLOSED on green output, never silently absorbed: the
  // reader of a passing run must be able to see that pinned historical events were in
  // range and were the reason no error was raised for them.
  const hits = result.grandfatheredHits ?? [];
  const grandfatherNote =
    hits.length === 0
      ? ""
      : ` NOTE: ${hits.length} founder-pinned grandfathered rewrite(s) were in range and ` +
        "re-pinned rather than denied (ruling 2026-09-14; see GRANDFATHERED_REWRITES and " +
        "docs/replatform/epics/E0-foundation/qa/2026-09-14-d0-pre-guard-rewrite-grandfather-a1.md): " +
        hits.map((h) => `${h.record} (${h.introducedBy.slice(0, 9)}→${h.rewrittenBy.slice(0, 9)})`).join("; ") +
        ".";
  if (result.preLedgerBase) {
    // Said out loud, not passed off as a normal run: the base predates the ledger, so the
    // check ran against an EXPLICITLY EMPTY baseline and the within-PR walk carried the
    // whole enforcement.
    console.log(
      `Evidence-ledger immutability OK (PRE-LEDGER BASE): base revision ${base} contains ` +
        `neither ${LEDGER_POLICY_PATH} nor any evidence record — the ledger does not exist ` +
        "there, so base-record immutability is vacuous and was checked against an " +
        `explicitly empty baseline. All ${result.candidateCount} candidate record(s) were ` +
        `introduced by this PR's own ${result.commitCount} commit(s); each was pinned at ` +
        "its introducing commit and none was rewritten or removed by a later one." +
        grandfatherNote,
    );
    return;
  }
  console.log(
    `Evidence-ledger immutability OK: ${result.baseCount} base records ` +
      `(${base}) all present and byte-identical in the candidate ` +
      `(${candidate || "HEAD"}, ${result.candidateCount} records); ` +
      `${result.commitCount} candidate commit(s) walked, and no record introduced by one of ` +
      "them was rewritten or removed by a later one." + grandfatherNote,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
