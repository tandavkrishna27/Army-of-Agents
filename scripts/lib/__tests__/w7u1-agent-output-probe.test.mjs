// scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs
//
// The no-key half of W7U1's probe pack. Every decision the keyed lane makes with the
// founder's ONE authorised run is decided here, without a key, in the required `policy`
// job — so the keyed run is not the first exercise of the code that reads it.
//
// ★ THE REAL SCRIPT LITERALS, NOT COPIES. The A2 anchor cases below run against the
// script `buildSandboxInvocation` ACTUALLY emits, imported from the production module.
// A pasted copy would be a test of the copy — the precise mistake
// `keyed-cli-008-unit-d-invocation.test.ts` was written to stop making. This file is
// `.mjs` and the module is `.ts`, so the four literals are reproduced HERE ONLY as
// inputs whose fidelity is itself asserted: `production script literals still match`
// reads `task-run-sandbox-invocation.ts` off disk and refuses if either anchor has
// moved. That is the same guarantee by a different route, and it fails LOUDLY.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BARE_BASE_TEMPLATE_ALIAS,
  CLI_BEARING_TEMPLATE_ALIAS,
  MIN_REDACTABLE_SECRET_LENGTH,
  PERMISSION_POSTURES,
  CLASSIFIER_STDOUT_LIMIT,
  PROBE_RECORD_SCHEMA,
  PermissionPostureAnchorError,
  ProbeRecordError,
  REDACTION_MARKER,
  buildProbeRecord,
  classifyProbeAArm,
  EXONERATION_RESIDUAL,
  countOccurrences,
  detectModelContactEvidence,
  detectStartupEvidence,
  evaluateDurableRecord,
  evaluateTemplateCliPreflight,
  isListingUsable,
  packDisposition,
  redactSecrets,
  resolveTemplate,
  TEMPLATE_CLI_BINARIES,
  TEMPLATE_CLI_PROBE_SCRIPT,
  verdictProbeA,
  verdictProbeB,
  verdictProbeC,
  withPermissionPosture,
} from "../w7u1-agent-output-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const INVOCATION_MODULE = path.join(
  REPO_ROOT,
  "server",
  "src",
  "services",
  "task-run-sandbox-invocation.ts",
);
const PROBE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "keyed-e2b-w7u1-output-probe.yml");
const E2B_DOCKERFILE = path.join(REPO_ROOT, "e2b", "e2b.Dockerfile");

// The four shapes, exactly as `buildSandboxInvocation` emits them (guard prefix elided;
// the anchors live in the tail). Their fidelity is asserted by the first test.
const CLAUDE_WITH_BUNDLE =
  'exec "$0" --print - --output-format stream-json --verbose --append-system-prompt-file "$2" < "$1"';
const CLAUDE_NO_BUNDLE = 'exec "$0" --print - --output-format stream-json --verbose < "$1"';
const CODEX_WITH_BUNDLE = '{ cat "$2"; echo; cat "$1"; } | "$0" exec --json -';
const CODEX_NO_BUNDLE = 'exec "$0" exec --json - < "$1"';

// ─────────────────────────────────────────────────────────────────────────────
// The premise, and the anchors A2 rewrites
// ─────────────────────────────────────────────────────────────────────────────

// ★ PREMISE REFUTED — 2026-09-11. W7U1's chartering question ("does the distributed
// emitter carry a permission posture?") has been ANSWERED by the source: the founder
// authorized the posture change on 2026-09-11 and `buildSandboxInvocation` now emits
// `--dangerously-skip-permissions` (claude) and `--skip-git-repo-check
// --dangerously-bypass-approvals-and-sandbox` (codex) on both branches each (E7-F021
// resolved, E7-F027 narrowed). This test was formerly "the premise holds: NONE …
// carries a posture"; it is inverted to a POSITIVE assertion over the same four literals
// so the record shows the answer, not a probe of an answered question. The live
// red-when-removed guard for the posture now lives in
// server/src/__tests__/task-run-batch-workload.test.ts (exact-script assertions +
// posture cases, proven to red when the flags are removed). The W7U1 output-probe
// apparatus is now premised on a refuted question and is tracked for retirement in
// docs/replatform/epics/E7-coding-e2b/findings.md (E7-F035).
test("W7U1's premise is now REFUTED: the production emitter carries a permission posture (posture shipped 2026-09-11)", () => {
  const source = readFileSync(INVOCATION_MODULE, "utf8");
  // The switch body is where the four literals live; the file's prose header discusses
  // the legacy adapters, so scope the search to the emitter.
  const start = source.indexOf('case "claude_local":');
  const end = source.indexOf("return {", start);
  assert.ok(start > 0 && end > start, "could not locate the adapter switch in the production module");
  const emitter = source.slice(start, end);

  // Assert over the actual emitted SCRIPT tails, not raw `.includes` over the whole
  // slice — the emitter's own comments name these flags, so a substring/count over the
  // slice would conflate prose with code. The two claude branches and the two codex
  // branches each carry the posture.
  const claudeTails = [
    'exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose --append-system-prompt-file "$2" < "$1"',
    'exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose < "$1"',
  ];
  const codexTails = [
    '{ cat "$2"; echo; cat "$1"; } | "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -',
    'exec "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox - < "$1"',
  ];
  for (const tail of claudeTails) {
    assert.ok(
      emitter.includes(tail),
      `the refutation is that the posture is PRESENT: claude branch no longer emits ${JSON.stringify(tail)}`,
    );
    assert.ok(tail.includes("--dangerously-skip-permissions"));
  }
  for (const tail of codexTails) {
    assert.ok(
      emitter.includes(tail),
      `the refutation is that the posture is PRESENT: codex branch no longer emits ${JSON.stringify(tail)}`,
    );
    assert.ok(tail.includes("--skip-git-repo-check"));
    assert.ok(tail.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
});

// ★ RETIRED — 2026-09-11. This test asserted the four BARE production literals (no
// posture) still matched the inputs the A2 differential feeds `withPermissionPosture`.
// The A2 differential was A1 = production-bare vs A2 = production + posture; with the
// posture now SHIPPED into production (founder-authorized 2026-09-11 — see the refutation
// test above and server/src/services/task-run-sandbox-invocation.ts), the production
// literals carry the posture and no longer match these bare inputs BY DESIGN. Worse, the
// A2 transform is self-contradictory against a postured production: `withPermissionPosture`
// asserts it THROWS on already-postured input ("A2 REFUSES … an already-postured script
// must refuse", below), so A2 could not run against the shipped literals even if the
// shapes were re-derived. This is a genuine obsolescence of the A2 differential, not a
// stale-constant swap. It is retired VISIBLY (skipped, not deleted) rather than inverted,
// because the whole W7U1 output-probe apparatus premised on the absent-posture question is
// now scheduled for retirement/rework — tracked in
// docs/replatform/epics/E7-coding-e2b/findings.md (E7-F035). The BARE fixtures
// (CLAUDE_WITH_BUNDLE …) are retained ONLY as inputs to the A2-transform unit tests below,
// which document the transform's historical contract against local fixtures (not the
// production module) and remain live.
test.skip("[RETIRED 2026-09-11] production script literals still match the shapes this file feeds the A2 transform — A2 differential obsoleted by shipped posture (E7-F035)", () => {
  const source = readFileSync(INVOCATION_MODULE, "utf8");
  for (const [name, literal] of [
    ["claude with bundle", CLAUDE_WITH_BUNDLE],
    ["claude no bundle", CLAUDE_NO_BUNDLE],
    ["codex with bundle", CODEX_WITH_BUNDLE],
    ["codex no bundle", CODEX_NO_BUNDLE],
  ]) {
    assert.ok(
      source.includes(literal),
      `${name}: the production module no longer emits ${JSON.stringify(literal)}. The A2 transform's inputs are ` +
        "stale; re-derive them from task-run-sandbox-invocation.ts before running the keyed lane.",
    );
  }
});

test("A2 inserts claude's posture exactly once, in the legacy adapter's position", () => {
  const out = withPermissionPosture(CLAUDE_WITH_BUNDLE, "claude_local");
  assert.equal(countOccurrences(out, "--dangerously-skip-permissions"), 1);
  assert.ok(out.includes("--verbose --dangerously-skip-permissions --append-system-prompt-file"));
  // Nothing else moved: the stdin redirect and the bundle flag survive.
  assert.ok(out.endsWith('--append-system-prompt-file "$2" < "$1"'));
  assert.notEqual(out, CLAUDE_WITH_BUNDLE);

  const bare = withPermissionPosture(CLAUDE_NO_BUNDLE, "claude_local");
  assert.ok(bare.includes('--verbose --dangerously-skip-permissions < "$1"'));
});

test("A2 inserts codex's posture between `exec --json` and the `-` positional, both shapes", () => {
  const piped = withPermissionPosture(CODEX_WITH_BUNDLE, "codex_local");
  assert.ok(piped.endsWith('| "$0" exec --json --dangerously-bypass-approvals-and-sandbox -'));
  const redirected = withPermissionPosture(CODEX_NO_BUNDLE, "codex_local");
  assert.ok(redirected.includes('exec --json --dangerously-bypass-approvals-and-sandbox - < "$1"'));
});

// ★★★ THE ANTI-VACUITY GUARD. If the anchor ever stops matching, a permissive transform
// would return the script unchanged and A2 would become A1 — the differential comparing
// a thing with itself while the log still said "posture applied". Every way of failing
// to apply the flag must THROW.
test("A2 REFUSES rather than silently returning an unchanged script", () => {
  assert.throws(
    () => withPermissionPosture('exec "$0" --print - --output-format json < "$1"', "claude_local"),
    PermissionPostureAnchorError,
    "a moved claude anchor must refuse, not no-op",
  );
  assert.throws(
    () => withPermissionPosture('exec "$0" exec --jsonl - < "$1"', "codex_local"),
    PermissionPostureAnchorError,
    "a moved codex anchor must refuse, not no-op",
  );
  assert.throws(
    () => withPermissionPosture(CLAUDE_WITH_BUNDLE, "gemini_local"),
    PermissionPostureAnchorError,
    "an adapter with no defined posture must refuse",
  );
  // Two anchors: we cannot say where the flag would land.
  assert.throws(
    () => withPermissionPosture(`${CODEX_NO_BUNDLE} ; ${CODEX_NO_BUNDLE}`, "codex_local"),
    PermissionPostureAnchorError,
    "an ambiguous anchor must refuse",
  );
  // And the premise-collapse case: the flag is already there.
  assert.throws(
    () => withPermissionPosture(withPermissionPosture(CLAUDE_NO_BUNDLE, "claude_local"), "claude_local"),
    PermissionPostureAnchorError,
    "an already-postured script must refuse — the premise has collapsed and that is the finding",
  );
});

test("every declared posture's replacement genuinely contains its flag", () => {
  for (const [adapter, posture] of Object.entries(PERMISSION_POSTURES)) {
    assert.ok(
      posture.replacement.includes(posture.flag),
      `${adapter}: the replacement does not contain the flag it claims to add`,
    );
    assert.ok(
      posture.replacement.includes(posture.anchor.replace(/ -$/, "")) || posture.replacement !== posture.anchor,
      `${adapter}: the replacement is identical to the anchor`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

test("redactSecrets removes every occurrence of a real-length secret", () => {
  const key = "sk-ant-EXAMPLEEXAMPLEEXAMPLE";
  const text = `error: bad key ${key}\nretry with ${key}`;
  const out = redactSecrets(text, [key, undefined, 42]);
  assert.ok(!out.includes(key), "the secret survived redaction");
  assert.equal(countOccurrences(out, REDACTION_MARKER), 2);
});

test("redactSecrets ignores values too short to be a credential", () => {
  const short = "a".repeat(MIN_REDACTABLE_SECRET_LENGTH - 1);
  const out = redactSecrets(`${short} is ordinary prose`, [short]);
  assert.ok(out.startsWith(short), "a short value must not eat the log");
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm classification — "no file" / "hung" / "exited 127" are three answers
// ─────────────────────────────────────────────────────────────────────────────

const NONCE = "AOA-W7U1-NONCE-0001";
const arm = (over) => ({
  label: "A1",
  nonce: NONCE,
  targetPreExisted: false,
  execution: { channel: "returned", exitCode: 0 },
  // `errorKind: "not-found"` is the DEFAULT because that is what an ordinary absent file
  // looks like coming out of `readBack`: the transport raised `E2bTransportNotFoundError`
  // and the read was sound. A `faulted` kind is the exceptional case, and the tests below
  // pin that it can never produce a negative.
  file: { found: false, content: null, errorKind: "not-found", detail: "" },
  ...over,
});

test("an arm whose file carries the nonce WROTE", () => {
  const c = classifyProbeAArm(arm({ file: { found: true, content: `hello ${NONCE}\n` } }));
  assert.equal(c.state, "wrote");
});

test("an arm whose file exists WITHOUT the nonce is indeterminate, not a success", () => {
  const c = classifyProbeAArm(arm({ file: { found: true, content: "something else entirely" } }));
  assert.equal(c.state, "indeterminate");
  assert.equal(c.cause, "file-present-without-the-nonce");
});

test("a pre-existing target path makes the arm indeterminate before anything else is read", () => {
  const c = classifyProbeAArm(arm({ targetPreExisted: true, file: { found: true, content: NONCE } }));
  assert.equal(c.state, "indeterminate");
  assert.equal(c.cause, "target-path-already-existed");
});

test("exit 127 is indeterminate (the experiment did not happen), NOT a negative result", () => {
  const c = classifyProbeAArm(arm({ execution: { channel: "returned", exitCode: 127 } }));
  assert.equal(c.state, "indeterminate");
  assert.equal(c.cause, "binary-not-runnable");
});

test("a sandbox FAULT is indeterminate, not a negative — a throw must not become a capability answer", () => {
  const c = classifyProbeAArm(arm({ execution: { channel: "threw", exitCode: null, detail: "SandboxError: 502" } }));
  assert.equal(c.state, "indeterminate");
  assert.equal(c.cause, "arm-faulted");
});

test("a stall and a non-zero exit THAT PRODUCED OUTPUT are BOTH negatives, and they are distinguishable", () => {
  const stalled = classifyProbeAArm(arm({ execution: { channel: "timedOut", exitCode: null } }));
  // ★ `exited` now has to have SAID something. A non-zero exit with empty stdout is the
  // refusal shape and is `indeterminate` — see the E7-F028 block below. A CLI that streamed
  // its head event and then exited 1 did reach the work and is still a genuine negative.
  const exited = classifyProbeAArm(
    arm({
      adapterType: "codex_local",
      execution: {
        channel: "returned",
        exitCode: 1,
        stdout: '{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.started"}\n',
      },
    }),
  );
  assert.equal(stalled.state, "did-not-write");
  assert.equal(exited.state, "did-not-write");
  assert.equal(stalled.cause, "stalled");
  assert.equal(exited.cause, "exited-1");
  assert.notEqual(stalled.cause, exited.cause, "a hang and an exit must not collapse into one answer");
});

// ─────────────────────────────────────────────────────────────────────────────
// E7-F028 — A REFUSAL IS NOT A RESULT
//
// ★★★ THE DEFECT THIS PINS, MEASURED. Run 34087197668's codex A1 ran the exact production
// `:204` literal, exited 1, and wrote NOTHING to stdout — its stderr said
// "Not inside a trusted directory and --skip-git-repo-check was not specified." The
// classifier's catch-all mapped that to `did-not-write`, `verdictProbeA` read two such arms
// and announced `a1-did-not-write-and-the-posture-is-not-the-cause`, and the LANE STAYED
// GREEN: a fourth-state situation folded into `no`, which is a RESULT, so nothing asked
// anyone to look. Meanwhile A2 — with the posture — got PAST that refusal
// (`{"type":"thread.started"}`), i.e. the posture REMOVED A1's actual blocker, the exact
// opposite of "exonerated".
// ─────────────────────────────────────────────────────────────────────────────

test("a non-zero exit with EMPTY stdout is INDETERMINATE — a refusal must never book as a result", () => {
  const c = classifyProbeAArm(
    arm({ adapterType: "codex_local", execution: { channel: "returned", exitCode: 1, stdout: "" } }),
  );
  assert.equal(c.state, "indeterminate", "a CLI that produced no bytes before exiting non-zero measured nothing");
  assert.equal(c.cause, "cli-refused-at-startup");
  assert.equal(c.ran, false);
});

test("the codex A1 arm of run 34087197668, replayed, is indeterminate rather than a negative", () => {
  const c = classifyProbeAArm({
    label: "A1",
    nonce: NONCE,
    adapterType: "codex_local",
    targetPreExisted: false,
    // Verbatim from the run's own step log: `exit=1 … stdout="" stderr="Not inside a
    // trusted directory and --skip-git-repo-check was not specified.\n"`.
    execution: {
      channel: "returned",
      exitCode: 1,
      stdout: "",
      stderr: "Not inside a trusted directory and --skip-git-repo-check was not specified.\n",
    },
    file: { found: false, content: null, errorKind: "not-found", detail: "" },
  });
  assert.equal(c.state, "indeterminate");
  assert.equal(c.cause, "cli-refused-at-startup");
});

test("exit 0 with empty stdout is STILL a negative — the new branch keys off the NON-ZERO exit", () => {
  // POSITIVE CONTROL for the branch above: it must not swallow the ordinary silent-exit
  // negative, which is the shape claude A1 produced in the same run.
  const c = classifyProbeAArm(arm({ adapterType: "claude_local", execution: { channel: "returned", exitCode: 0, stdout: "" } }));
  assert.equal(c.state, "did-not-write");
  assert.equal(c.cause, "exited-0");
});

test("the startup head event is detected per CLI, from the shapes the ADAPTERS parse", () => {
  // claude — `parse.ts:19`: type "system" AND subtype "init", on ONE line.
  const claude = detectStartupEvidence(
    '{"type":"system","subtype":"init","cwd":"/home/user","session_id":"de6ba132"}\n{"type":"assistant"}\n',
    "claude_local",
  );
  assert.equal(claude.ran, true);
  // codex — `parse.ts:64`/`:136`: type "thread.started".
  const codex = detectStartupEvidence('{"type":"thread.started","thread_id":"01a07a5b"}\n', "codex_local");
  assert.equal(codex.ran, true);
  // ★ A `system` EVENT THAT IS NOT `init` IS NOT A START. Matching `"type":"system"` alone
  // would call the CLI started on an event that says nothing of the kind.
  assert.equal(detectStartupEvidence('{"type":"system","subtype":"compact_boundary"}\n', "claude_local").ran, false);
  // ★ AND THE PAIR MUST BE ON ONE LINE — two unrelated events must not combine.
  assert.equal(detectStartupEvidence('{"type":"system"}\n{"subtype":"init"}\n', "claude_local").ran, false);
  // Cross-CLI: codex's head event is not claude's, and vice versa.
  assert.equal(detectStartupEvidence('{"type":"thread.started"}', "claude_local").ran, false);
  assert.equal(detectStartupEvidence('{"type":"system","subtype":"init"}', "codex_local").ran, false);
  // Empty, and an adapter nobody declared: both FAIL CLOSED.
  assert.equal(detectStartupEvidence("", "codex_local").ran, false);
  assert.equal(detectStartupEvidence('{"type":"thread.started"}', "gemini_local").ran, false);
});

test("the declared startup shapes are the ones the shipped adapters actually parse", () => {
  // ★ READ OFF DISK, not asserted from memory: if an adapter's head event is renamed, this
  // pack's "demonstrably ran" evidence would silently stop matching and every exoneration
  // would turn inconclusive with no explanation. Fail loudly instead.
  const claudeParse = readFileSync(
    path.join(REPO_ROOT, "packages", "adapters", "claude-local", "src", "server", "parse.ts"),
    "utf8",
  );
  assert.match(claudeParse, /type === "system" && asString\(event\.subtype, ""\) === "init"/);
  const codexParse = readFileSync(
    path.join(REPO_ROOT, "packages", "adapters", "codex-local", "src", "server", "parse.ts"),
    "utf8",
  );
  assert.match(codexParse, /type === "thread\.started"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The READ channel — an apparatus fault must never become a capability answer
//
// ★★★ THE DEFECT THIS PINS. `readBack` used to catch EVERY error and answer
// `found:false`, so a transport read fault was byte-identical to "the agent wrote
// nothing". A reviewer reproduced it: a read fault printed as
// `NO — a1-did-not-write-and-the-posture-is-the-cause`, disposition `measured`.
//
// ★★ THE EXEC-SIDE CONTROLS DO NOT COVER IT. A0's success is temporally PRIOR to A1's
// readback, not concurrent with it, so a fault that first appears during A1's read is
// outside A0's scope. The read needed its own channel, and this is where it is proven.
// ─────────────────────────────────────────────────────────────────────────────

test("a FAULTED read is indeterminate — a broken read must never become 'the agent did not write'", () => {
  const c = classifyProbeAArm(
    arm({ file: { found: false, content: null, errorKind: "faulted", detail: "Error: ECONNRESET" } }),
  );
  assert.equal(
    c.state,
    "indeterminate",
    "a read that FAILED establishes nothing about the file; reporting it as a negative is an apparatus " +
      "failure printed as a capability answer",
  );
  assert.equal(c.cause, "read-faulted");
  assert.ok(c.detail.includes("ECONNRESET"), "the fault's own detail must survive into the verdict");
});

test("a faulted read on A1 makes PROBE A inconclusive, and the pack RED", () => {
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: classifyProbeAArm(arm({ file: { found: false, content: null, errorKind: "faulted", detail: "socket hang up" } })),
    a2: wrote("A2"),
    a3: didNot("A3", "exited-0"),
  });
  assert.equal(v.state, "inconclusive");
  assert.equal(
    v.reason,
    "a1-read-faulted",
    "the faulted read must reach the operator as its OWN reason, not as a posture conviction",
  );
  const d = packDisposition([v]);
  assert.equal(d.exitCode, 1);
  assert.equal(d.disposition, "inconclusive");
});

// ★ THE POSITIVE CONTROL FOR THE ABOVE. If BOTH this and the two tests above go red under
// the same edit, the fix has made every negative inconclusive — which destroys the whole
// point of a pack chartered to be able to answer NO.
test("a genuine NOT-FOUND read still yields a clean NO, and the pack stays MEASURED", () => {
  const a1 = classifyProbeAArm(arm({ execution: { channel: "timedOut", exitCode: null } }));
  assert.equal(a1.state, "did-not-write");
  const v = verdictProbeA({ a0: wrote("A0"), a1, a2: wrote("A2"), a3: didNot("A3", "exited-0") });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "a1-did-not-write-and-the-posture-is-the-cause");
  const d = packDisposition([v]);
  assert.equal(d.exitCode, 0);
  assert.equal(d.disposition, "measured");
});

test("probe B refuses the NO when a candidate's read FAULTED — an unread path is not an absent path", () => {
  const v = verdictProbeB({
    listingOk: true,
    entries: [".bashrc"],
    candidates: [
      { path: "/home/user/.aoa-run-output.jsonl", exists: false, bytes: 0, errorKind: "not-found", detail: "" },
      { path: "/home/user/output.txt", exists: false, bytes: 0, errorKind: "faulted", detail: "Error: 502" },
    ],
  });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "candidate-read-faulted");
  assert.ok(v.detail.includes("/home/user/output.txt"));
});

// ★ THE POSITIVE CONTROL FOR THE ABOVE, again in the same run.
test("probe B's NO survives when every candidate was genuinely NOT FOUND", () => {
  const v = verdictProbeB({
    listingOk: true,
    entries: [".bashrc"],
    candidates: [
      { path: "/home/user/.aoa-run-output.jsonl", exists: false, bytes: 0, errorKind: "not-found", detail: "" },
    ],
  });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "template-prefills-nothing");
});

// ★★ AND THE YES IS DELIBERATELY NOT GATED. An OBSERVED prefill is a positive that an
// unread neighbour cannot unmake, and `inconclusive` means "run me again" — a confirmed
// prefill is not made truer by a second run. It is the NO, which asserts something about
// paths we did not see, that an unread path invalidates.
test("probe B still says YES when a path was READ and found to exist, even beside a faulted read", () => {
  const v = verdictProbeB({
    listingOk: true,
    entries: [".aoa-run-output.jsonl"],
    candidates: [
      { path: "/home/user/.aoa-run-output.jsonl", exists: true, bytes: 12, errorKind: null, detail: "" },
      { path: "/home/user/output.txt", exists: false, bytes: 0, errorKind: "faulted", detail: "Error: 502" },
    ],
  });
  assert.equal(v.state, "yes");
  assert.equal(v.reason, "template-prefills-a-candidate-output-path");
});

test("ONLY a `returned` listing is evidence — a listing that TIMED OUT is not an empty directory", () => {
  assert.equal(isListingUsable("returned"), true);
  for (const channel of ["timedOut", "threw", "not-run", "binary-missing"]) {
    assert.equal(isListingUsable(channel), false, `a ${channel} listing must not count as a look at the directory`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe A's verdict — the controls gate the measurement
// ─────────────────────────────────────────────────────────────────────────────

// ★ `ran` AND `reachedModel` ARE BOTH PART OF AN ARM, AND THEY ARE SET INDEPENDENTLY. The
// defaults encode the fail-closed rule: an arm that WROTE obviously ran and obviously
// reached a model, and an arm that produced nothing is NOT SHOWN to have done either unless
// a case says so explicitly. Anything reading these fixtures as "ran unless stated" would
// re-open E7-F028 in the test suite itself.
//
// ★★ THE THIRD ARGUMENT IS THE ONE THAT MATTERS NOW. `didNot("A2", "exited-1", true)` is an
// arm that STARTED; `didNot("A2", "exited-1", true, true)` is an arm that started AND
// reached a model. The gap between those two fixtures is exactly the v4 defect: codex A2 in
// run 34087197668 was the first, and the pack read it as the second.
const ranDetail = (ran) => (ran ? "the CLI's head event was present on this arm's stdout" : "no head event was seen");
const modelDetail = (reached) =>
  reached
    ? "an `assistant` event carrying a non-empty message.content was present on this arm's stdout (model-authored-content)"
    : "no model-contact event was seen on this arm's stdout";
const armFixture = (state, cause, label, ran, reachedModel) => ({
  label,
  state,
  cause,
  detail: "",
  ran,
  runEvidenceDetail: ranDetail(ran),
  reachedModel,
  modelEvidenceKind: reachedModel ? "model-authored-content" : "none",
  modelEvidenceDetail: modelDetail(reachedModel),
});
const wrote = (label, ran = true, reachedModel = true) => armFixture("wrote", "nonce-present", label, ran, reachedModel);
const didNot = (label, cause, ran = false, reachedModel = false) =>
  armFixture("did-not-write", cause, label, ran, reachedModel);
const indet = (label, cause, ran = false, reachedModel = false) =>
  armFixture("indeterminate", cause, label, ran, reachedModel);

test("a failed HARNESS control makes probe A inconclusive whatever A1 did", () => {
  const v = verdictProbeA({ a0: didNot("A0", "exited-1"), a1: didNot("A1", "stalled"), a2: wrote("A2"), a3: didNot("A3", "exited-0") });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "harness-control-failed");
});

test("a violated NEGATIVE control makes probe A inconclusive even when A1 wrote", () => {
  const v = verdictProbeA({ a0: wrote("A0"), a1: wrote("A1"), a2: wrote("A2"), a3: wrote("A3") });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "negative-control-violated");
});

test("A1 writing under the production argv is a YES", () => {
  const v = verdictProbeA({ a0: wrote("A0"), a1: wrote("A1"), a2: wrote("A2"), a3: didNot("A3", "exited-0", true) });
  assert.equal(v.state, "yes");
  // ★ NAMED POSITIVE CONTROL: a genuine write still answers YES, and the lane stays green.
  assert.equal(packDisposition([v]).disposition, "measured");
});

test("A1 silent + A2 writing is a NO that CONVICTS the missing permission posture", () => {
  const v = verdictProbeA({ a0: wrote("A0"), a1: didNot("A1", "stalled"), a2: wrote("A2"), a3: didNot("A3", "exited-0") });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "a1-did-not-write-and-the-posture-is-the-cause");
});

test("A1 and A2 both silent is a NO that EXONERATES the posture — ONLY when A2 REACHED A MODEL", () => {
  const v = verdictProbeA({
    a0: wrote("A0"),
    // Both arms started; A2 — the arm carrying the posture — also received model output and
    // still wrote nothing. That is an agent that got as far as the question and answered it
    // in the negative: a genuine negative, and a real exoneration.
    a1: didNot("A1", "exited-1", true, true),
    a2: didNot("A2", "exited-1", true, true),
    a3: didNot("A3", "exited-0", true, true),
  });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "a1-did-not-write-and-the-posture-is-not-the-cause");
  // ★ NAMED POSITIVE CONTROL. A genuine did-not-write must still produce a CLEAN NO and a
  // `measured` disposition. If a repair to the classifier or the verdict reds this, the
  // pack has been made unable to answer, which destroys its purpose.
  assert.equal(packDisposition([v]).disposition, "measured");
  // ★★ AND THE RESIDUAL RIDES THE VERDICT. The reviewer's instruction on the third repair
  // of this predicate was explicit: the limit must not live only in a PR body. `detail` is
  // what `buildProbeRecord` copies into the durable record and what the job summary prints,
  // so asserting it here is asserting that the reader six months from now sees the bound.
  assert.ok(
    v.detail.includes(EXONERATION_RESIDUAL),
    "the exoneration must carry its own residual into the durable record",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE EXONERATION PREDICATE — three wrong versions, and the bound on the fourth
//
// ★★★ This is the only verdict in the pack that asserts a NEGATIVE about a CAUSE, and the
// predicate guarding it has now been wrong three times, each fix NECESSARY AND INSUFFICIENT:
//
//   v1  any non-zero exit ⇒ did-not-write        (could not tell a refusal from a result)
//   v2  "at least one arm demonstrably ran"      (WRONG ARM — only A2 carries the posture)
//   v3  `a2.ran === true`                        (still head-event-only)
//   v4  `ran` comes from the HEAD EVENT ALONE, so an arm that STARTS and shows no
//       model-contact evidence satisfies it. Measured shape: codex A2 in run 34087197668
//       emitted `thread.started` + `turn.started`, then FOUR `Reconnecting… N/5` 401 lines
//       (2/5, 3/5, 4/5, 5/5). ★ THE RECORD, NOT THE AGENT: the run preserved EXACTLY 900 chars of
//       A2's stdout, ending mid-token at `{"type":"i`, so "it reached nothing" is NOT
//       established — only that no model-contact evidence was present in what was kept.
//
// The two tests below are the ANTI-REGRESSION MUTATIONS for v3 and v2 respectively. Each
// was OBSERVED RED against the reverted predicate before being committed; neither is a
// restatement of the passing case above.
// ─────────────────────────────────────────────────────────────────────────────

test("MUTATION (i) — two arms that STARTED with no model-contact evidence may NOT exonerate the posture", () => {
  // ★★★ THE v4 CASE, BUILT FROM RUN 34087197668's PRESERVED CODEX STDOUT, through the REAL
  // classifier. Both arms emit `thread.started` (so `ran` is TRUE for both) and then only
  // 401 reconnect errors. Under the head-event-only predicate this pair EXONERATES the
  // posture and the lane goes green with a false cause in the durable record.
  //
  // ★ THIS FIXTURE IS THE PRESERVED PREFIX, NOT THE ARM'S WHOLE STDOUT, and the distinction
  // is the point of the assertion below. The run kept EXACTLY 900 characters of A2's stdout and
  // they end MID-TOKEN at `{"type":"i`; A3's parallel line shows that position reads
  // `{"type":"item.completed","item":{"id":"item_0`. So the fixture proves what v4 does
  // with a stdout carrying no model-contact evidence — it does NOT establish that codex A2
  // reached nothing, and nothing below asserts that it did.
  const dyingStdout =
    '{"type":"thread.started","thread_id":"01a07a5b-b6b9-7fe2-9729-999757da1442"}\n{"type":"turn.started"}\n' +
    '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}\n' +
    '{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized)"}\n';
  const codexArm = (label) =>
    classifyProbeAArm({
      label,
      nonce: NONCE,
      adapterType: "codex_local",
      targetPreExisted: false,
      execution: { channel: "returned", exitCode: 1, stdout: dyingStdout },
      file: { found: false, content: null, errorKind: "not-found", detail: "" },
    });
  const a1 = codexArm("A1");
  const a2 = codexArm("A2");
  // The mutation's own premise, pinned: BOTH arms satisfy the OLD predicate.
  assert.equal(a1.ran, true, "the head-event-only predicate is satisfied by A1 — that is the point");
  assert.equal(a2.ran, true, "and by A2 — so v3 would have exonerated");
  assert.equal(a2.reachedModel, false, "and NEITHER shows model-contact evidence on this stdout");

  const v = verdictProbeA({ a0: wrote("A0"), a1, a2, a3: codexArm("A3") });
  assert.equal(v.state, "inconclusive", "an arm that started with no model-contact evidence leaves the posture UNTESTED");
  assert.equal(v.reason, "posture-exoneration-unsupported-a2-did-not-reach-a-model");
  assert.notEqual(v.reason, "a1-did-not-write-and-the-posture-is-not-the-cause");
  assert.equal(packDisposition([v]).disposition, "inconclusive", "and it must RED the lane, not pass as a result");
});

test("MUTATION (ii) — A1 reaching a model does NOT license an exoneration when A2 did not", () => {
  // ★★★ THE v2 CASE. Only A2 carries the permission posture, so A1's progress says nothing
  // about whether a posture-only fix would have helped. A predicate reading "at least one
  // arm" is satisfied here and exonerates on the WRONG ARM's evidence.
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: didNot("A1", "exited-1", true, true),
    a2: didNot("A2", "exited-1", true, false),
    a3: didNot("A3", "exited-0", true, true),
  });
  assert.equal(v.state, "inconclusive", "the posture rides A2; A1's evidence cannot stand in for it");
  assert.equal(v.reason, "posture-exoneration-unsupported-a2-did-not-reach-a-model");
  assert.equal(packDisposition([v]).disposition, "inconclusive");
});

test("neither arm shown to have started is still INCONCLUSIVE — the older failure has not been traded away", () => {
  // The v1/v2 case must NOT regress while v4 is being fixed: two stalls, no stdout at all.
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: didNot("A1", "stalled", false, false),
    a2: didNot("A2", "stalled", false, false),
    a3: didNot("A3", "stalled", false, false),
  });
  assert.equal(v.state, "inconclusive", "an unrun pair may not exonerate the variable it never tested");
  assert.equal(v.reason, "posture-exoneration-unsupported-a2-did-not-reach-a-model");
  assert.ok(
    v.detail.includes("no model-contact"),
    "the verdict must say WHICH evidence was missing, not merely that something was",
  );
  assert.equal(packDisposition([v]).disposition, "inconclusive");
});

test("the model-contact evidence is detected per CLI, from the shapes the ADAPTERS actually parse", () => {
  // claude — `parse.ts:25-37` reads `event.message.content`'s blocks off an `assistant` event.
  const claudeMsg = detectModelContactEvidence(
    '{"type":"system","subtype":"init","session_id":"de6ba132"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n',
    "claude_local",
  );
  assert.equal(claudeMsg.reached, true);
  assert.equal(claudeMsg.evidenceKind, "model-authored-content");
  // claude — `parse.ts:40-64`: a non-error `result` carrying billed output tokens.
  assert.equal(
    detectModelContactEvidence('{"type":"result","usage":{"output_tokens":12}}', "claude_local").evidenceKind,
    "billed-usage",
  );
  // ★★★ AND THE 401 `result` DOES NOT COUNT. `claude-local/src/server/parse.ts:127-128`
  // records the real shape of a revoked-token run: `subtype` is misleadingly "success" and
  // `is_error` is true. Accepting `result` unconditionally would re-open the whole defect
  // one event later.
  assert.equal(
    detectModelContactEvidence(
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"usage":{"output_tokens":3}}',
      "claude_local",
    ).reached,
    false,
    "an errored result event is not evidence that a model was reached",
  );
  // ...nor is a `result` with no billed output.
  assert.equal(
    detectModelContactEvidence('{"type":"result","usage":{"output_tokens":0}}', "claude_local").reached,
    false,
  );
  // ...nor an `assistant` event with an empty content array.
  assert.equal(
    detectModelContactEvidence('{"type":"assistant","message":{"content":[]}}', "claude_local").reached,
    false,
  );

  // codex — `parse.ts:189-201` (agent_message / reasoning items) and `:229-235` (turn.completed usage).
  assert.equal(
    detectModelContactEvidence(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}',
      "codex_local",
    ).evidenceKind,
    "model-authored-content",
  );
  assert.equal(
    detectModelContactEvidence(
      '{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking"}}',
      "codex_local",
    ).reached,
    true,
  );
  assert.equal(
    detectModelContactEvidence('{"type":"turn.completed","usage":{"output_tokens":41}}', "codex_local").evidenceKind,
    "billed-usage",
  );
  // ★★★ THE HEAD EVENTS ARE NOT MODEL CONTACT. These two lines ARE the v4 defect, and an
  // `item.completed` whose item is neither a message nor reasoning is not either.
  //
  // ★ THE THIRD CASE IS A CONSTRUCTED SHAPE, NOT A MEASURED ONE, AND SAYING SO IS THE POINT
  // OF THIS UNIT. Run 34087197668's codex A3 DID emit an `item.completed` after FOUR failed
  // reconnects (2/5 through 5/5), but the pack's log capture truncated at `{"id":"item_0`
  // and the durable record carried no stdout, so THE ITEM'S TYPE IS UNKNOWN — and by the
  // same truncation, so is whether A2 emitted one at all. The `"type":"error"` below is
  // therefore a shape this predicate must reject, not a shape that was observed — and that
  // asymmetry is why the predicate whitelists two item types instead of blacklisting one.
  assert.equal(detectModelContactEvidence('{"type":"thread.started","thread_id":"x"}', "codex_local").reached, false);
  assert.equal(detectModelContactEvidence('{"type":"turn.started"}', "codex_local").reached, false);
  assert.equal(
    detectModelContactEvidence('{"type":"item.completed","item":{"id":"item_0","type":"error"}}', "codex_local").reached,
    false,
  );
  assert.equal(
    detectModelContactEvidence('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"  "}}', "codex_local")
      .reached,
    false,
    "an empty agent_message is not model output",
  );
  assert.equal(
    detectModelContactEvidence('{"type":"turn.completed","usage":{"output_tokens":0}}', "codex_local").reached,
    false,
  );

  // Cross-CLI, empty, unparseable, and an adapter nobody declared: all FAIL CLOSED.
  assert.equal(
    detectModelContactEvidence('{"type":"item.completed","item":{"type":"agent_message","text":"x"}}', "claude_local")
      .reached,
    false,
  );
  assert.equal(detectModelContactEvidence("", "codex_local").reached, false);
  assert.equal(detectModelContactEvidence("not json at all\n{oops", "codex_local").reached, false);
  assert.equal(
    detectModelContactEvidence('{"type":"assistant","message":{"content":[{"type":"text"}]}}', "gemini_local").reached,
    false,
  );
});

test("the declared model-contact shapes are the ones the shipped adapters actually parse", () => {
  // ★ READ OFF DISK, exactly like the startup-shape guard above it. If an adapter renames
  // these events, this pack's "reached a model" evidence would silently stop matching and
  // EVERY exoneration would turn inconclusive with no explanation. Fail loudly instead.
  const claudeParse = readFileSync(
    path.join(REPO_ROOT, "packages", "adapters", "claude-local", "src", "server", "parse.ts"),
    "utf8",
  );
  const codexParse = readFileSync(
    path.join(REPO_ROOT, "packages", "adapters", "codex-local", "src", "server", "parse.ts"),
    "utf8",
  );
  assert.ok(claudeParse.includes('if (type === "assistant")'), "claude's assistant event is no longer parsed as such");
  assert.ok(claudeParse.includes("cache_read_input_tokens"), "claude's result usage block has moved");
  assert.ok(claudeParse.includes("api_error_status"), "the errored-result shape the is_error guard exists for has moved");
  assert.ok(codexParse.includes('type === "item.completed"'), "codex's item.completed event has moved");
  assert.ok(codexParse.includes('"agent_message"'), "codex's agent_message item type has moved");
  assert.ok(codexParse.includes('type === "turn.completed"'), "codex's turn.completed event has moved");
});

test("the RESIDUAL survives into the DURABLE RECORD, not just the verdict object", () => {
  // ★★★ THE CLAIM "it is in the durable record" IS PROVEN, NOT INFERRED. The verdict object
  // carrying the text is not the same fact as the uploaded artefact carrying it —
  // `buildProbeRecord` could drop `detail` and every other assertion here would still pass.
  // This drives the real exoneration verdict through the real record builder and reads the
  // residual back out of the serialized JSON.
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: didNot("A1", "exited-1", true, true),
    a2: didNot("A2", "exited-1", true, true),
    a3: didNot("A3", "exited-0", true, true),
  });
  assert.equal(v.reason, "a1-did-not-write-and-the-posture-is-not-the-cause");
  const rec = buildProbeRecord({
    verdicts: [v],
    template: CLI_BEARING_TEMPLATE_ALIAS,
    templateSource: "default-cli-bearing",
    templateNote: "n",
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    runNonce: "W7U1-X",
    generatedAt: "2026-09-06T00:00:00.000Z",
  });
  assert.ok(
    JSON.parse(JSON.stringify(rec)).probes[0].detail.includes(EXONERATION_RESIDUAL),
    "the record that outlives the log must carry the bound on the claim it records",
  );
});

test("the STDOUT THE CLASSIFIER READ survives into the durable record — a verdict must be auditable against its own artefact", () => {
  // ★★★ THIS IS THE ANTI-REGRESSION FOR A MEASURED DEFECT, not a shape test.
  // In run 34087197668 the keyed pack handed the classifier `safe(exec.stdout, 8000)` and
  // preserved `safe(exec.stdout, 900)` in a CONSOLE LINE, while the durable record carried
  // no stdout at all. The whole of that run's job log contains ZERO instances of
  // `assistant`, `output_tokens`, `agent_message` or `turn.completed` — none of the four
  // shapes the model-contact predicate looks for — INCLUDING for the claude arms that
  // demonstrably reached a model. So no verdict from that run can be re-derived from what it
  // shipped, and that is precisely how six sentences came to assert more about codex A2 than
  // the 900 preserved characters could support.
  //
  // MUTATION: drop `armEvidence` from `buildProbeRecord`'s return, or slice it shorter than
  // `CLASSIFIER_STDOUT_LIMIT` at the call site, and this test reds.
  // ★★★ THE FIXTURE IS DELIBERATELY LONGER THAN THE 900-CHARACTER CONSOLE LINE, AND THE
  // MODEL-CONTACT EVIDENCE SITS BEYOND IT. That is the exact geometry of the defect: the
  // console kept 900 characters, the classifier read 8000, and a `turn.completed` past
  // character 900 was therefore invisible to anyone auditing the verdict afterwards. A
  // record preserving only what the console preserved would drop the last line here, so a
  // record slice shorter than `CLASSIFIER_STDOUT_LIMIT` reds this test.
  const filler = '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}\n'.repeat(12);
  const stdout =
    '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n' +
    filler +
    '{"type":"turn.completed","usage":{"output_tokens":41}}\n';
  assert.ok(stdout.length > 900, "the fixture must exceed the console line's limit or this test cannot bite");
  assert.ok(stdout.length < CLASSIFIER_STDOUT_LIMIT, "and must fit inside what the classifier reads");
  const rec = JSON.parse(
    JSON.stringify(
      buildProbeRecord({
        verdicts: [],
        template: CLI_BEARING_TEMPLATE_ALIAS,
        armEvidence: [
          {
            probe: "A/codex_local",
            label: "A2",
            adapterType: "codex_local",
            posture: true,
            channel: "returned",
            exitCode: 1,
            stdoutTruncated: false,
            stdout,
          },
        ],
      }),
    ),
  );
  assert.equal(rec.armEvidence.length, 1, "the record must carry the evidence the verdict was computed from");
  const a = rec.armEvidence[0];
  assert.equal(a.label, "A2");
  assert.equal(a.adapterType, "codex_local");
  assert.equal(a.posture, true);
  assert.equal(a.exitCode, 1);
  // ★ THE BYTES THEMSELVES, not a summary of them. A record that says "no model output was
  // found" without the stdout it searched is the unauditable state this test exists to stop.
  assert.equal(a.stdout, stdout);
  // ★ AND THE EVIDENCE PAST CHARACTER 900 IS STILL THERE. Without these two lines a
  // 900-character record slice survives every other assertion in this test — measured: that
  // mutation passed until they were added.
  assert.ok(a.stdout.includes('"type":"turn.completed"'), "the record dropped model-contact evidence the classifier read");
  assert.ok(a.stdout.length > 900, "the record must preserve more than the console line did");
  // ★ AND THE BOUND TRAVELS WITH THEM: "nothing in the whole stdout" and "nothing in the
  // prefix the classifier could see" are different claims, and only `stdoutTruncated`
  // separates them.
  assert.equal(a.stdoutLimit, CLASSIFIER_STDOUT_LIMIT);
  assert.equal(a.stdoutTruncated, false);
  // The schema version moved with the field, so a v1 reader cannot silently mistake a record
  // with no evidence for a record whose arms produced none.
  assert.equal(rec.schema, "aoa.w7u1.output-probe-record/2");
});

test("a record built with NO armEvidence still writes the field, empty — absent is not the same as unrecorded", () => {
  const rec = buildProbeRecord({ verdicts: [], template: CLI_BEARING_TEMPLATE_ALIAS });
  assert.ok(Array.isArray(rec.armEvidence), "the field must always exist so a reader can tell empty from missing");
  assert.equal(rec.armEvidence.length, 0);
});

test("the RESIDUAL is stated in the runbook's verdict row, not only in the code", () => {
  // ★★★ [[checks-that-nothing-runs]], applied to a LIMIT rather than to a check. The
  // reviewer's instruction on this repair was that the residual must not live only in a PR
  // body — a bound stated where nobody reads it is not stated. The code emits
  // EXONERATION_RESIDUAL into the verdict; this pins that the OPERATOR-FACING document
  // carries the same four bounds, so the two cannot drift apart silently.
  const runbook = readFileSync(
    path.join(REPO_ROOT, "docs", "replatform", "epics", "E7-coding-e2b", "tickets", "W7U1-output-probe-runbook.md"),
    "utf8",
  );
  for (const phrase of [
    "does NOT establish that the model was given the intended prompt",
    "It says nothing about A1",
    "first 8000 characters",
    "billed-usage",
  ]) {
    assert.ok(runbook.includes(phrase), `the runbook no longer states the residual bound: "${phrase}"`);
  }
});

test("the CONVICTION branch is NOT gated on startup evidence — a write IS the evidence", () => {
  // POSITIVE CONTROL: A2 wrote, so A2 self-evidently ran, and the differential holds even
  // if A1 never emitted a head event at all. A gate here would red the run that actually
  // answered the pack's question (claude, run 34087197668).
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: didNot("A1", "exited-0", false),
    a2: wrote("A2", true),
    a3: didNot("A3", "exited-0", true),
  });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "a1-did-not-write-and-the-posture-is-the-cause");
  assert.equal(packDisposition([v]).disposition, "measured");
});

test("the codex half of run 34087197668, replayed END TO END, no longer exonerates the posture", () => {
  // Arms classified by the REAL classifier from the run's REAL captured stdout, then fed to
  // the REAL verdict function. A1 exited 1 saying nothing (the trusted-directory refusal);
  // A2 got past it and failed on 401.
  const codexArm = (label, stdout, exitCode) =>
    classifyProbeAArm({
      label,
      nonce: NONCE,
      adapterType: "codex_local",
      targetPreExisted: false,
      execution: { channel: "returned", exitCode, stdout },
      file: { found: false, content: null, errorKind: "not-found", detail: "" },
    });
  const a2Stdout =
    '{"type":"thread.started","thread_id":"01a07a5b-b6b9-7fe2-9729-999757da1442"}\n{"type":"turn.started"}\n' +
    '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}\n';
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: codexArm("A1", "", 1),
    a2: codexArm("A2", a2Stdout, 1),
    a3: codexArm("A3", a2Stdout, 1),
  });
  assert.equal(v.state, "inconclusive");
  // A1 is now `indeterminate / cli-refused-at-startup`, so the verdict stops at the A1 gate
  // — earlier and more honestly than the exoneration branch would have.
  assert.equal(v.reason, "a1-cli-refused-at-startup");
  assert.notEqual(v.reason, "a1-did-not-write-and-the-posture-is-not-the-cause");
  assert.equal(packDisposition([v]).disposition, "inconclusive");
});

test("A1 silent + A2 unreadable is still a NO, but the cause is explicitly unattributed", () => {
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: didNot("A1", "stalled"),
    a2: indet("A2", "binary-not-runnable"),
    a3: didNot("A3", "exited-0"),
  });
  assert.equal(v.state, "no");
  assert.equal(v.reason, "a1-did-not-write-cause-unattributed");
});

test("an unreadable A1 is inconclusive, never a NO", () => {
  const v = verdictProbeA({
    a0: wrote("A0"),
    a1: indet("A1", "binary-not-runnable"),
    a2: wrote("A2"),
    a3: didNot("A3", "exited-0"),
  });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "a1-binary-not-runnable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Probes B and C
// ─────────────────────────────────────────────────────────────────────────────

test("probe B says YES when the template pre-fills a candidate output path", () => {
  const v = verdictProbeB({
    listingOk: true,
    entries: [".aoa-run-output.jsonl"],
    candidates: [{ path: "/home/user/.aoa-run-output.jsonl", exists: true, bytes: 12 }],
  });
  assert.equal(v.state, "yes");
  assert.ok(v.detail.includes("/home/user/.aoa-run-output.jsonl"));
});

test("probe B says NO — and still reports the listing — when nothing is pre-filled", () => {
  const v = verdictProbeB({
    listingOk: true,
    entries: [".bashrc", "aoa-workspace"],
    candidates: [{ path: "/home/user/.aoa-run-output.jsonl", exists: false, bytes: 0 }],
  });
  assert.equal(v.state, "no");
  assert.ok(v.detail.includes(".bashrc"), "the enumeration must survive into the negative result");
});

test("probe B refuses a verdict when the enumeration itself failed", () => {
  assert.equal(verdictProbeB({ listingOk: false, detail: "connect failed" }).state, "inconclusive");
});

test("probe C says YES only when BOTH markers arrive and the command exits 0", () => {
  const base = { ran: true, exitCode: 0, stdoutMarker: "OUT", stderrMarker: "ERR" };
  assert.equal(verdictProbeC({ ...base, stdout: "OUT\n", stderr: "ERR\n" }).state, "yes");
  assert.equal(verdictProbeC({ ...base, stdout: "", stderr: "ERR\n" }).state, "no");
  assert.equal(verdictProbeC({ ...base, stdout: "OUT\n", stderr: "" }).state, "no");
  assert.equal(verdictProbeC({ ...base, exitCode: 1, stdout: "OUT\n", stderr: "ERR\n" }).state, "no");
  assert.equal(verdictProbeC({ ran: false, detail: "threw" }).state, "inconclusive");
});

// ─────────────────────────────────────────────────────────────────────────────
// The lane's disposition — a NO stays green
// ─────────────────────────────────────────────────────────────────────────────

test("a pack in which every probe answered NO is a MEASURED run and exits 0", () => {
  const d = packDisposition([
    { probe: "A", state: "no", reason: "r", detail: "" },
    { probe: "B", state: "no", reason: "r", detail: "" },
    { probe: "C", state: "yes", reason: "r", detail: "" },
  ]);
  assert.equal(d.exitCode, 0);
  assert.equal(d.disposition, "measured");
});

test("ONE inconclusive probe reds the lane", () => {
  const d = packDisposition([
    { probe: "A", state: "yes", reason: "r", detail: "" },
    { probe: "B", state: "inconclusive", reason: "enumeration-failed", detail: "" },
  ]);
  assert.equal(d.exitCode, 1);
  assert.ok(d.detail.includes("B (enumeration-failed)"));
});

test("a pack with NO verdicts at all is inconclusive, never a silent pass", () => {
  assert.equal(packDisposition([]).exitCode, 1);
  assert.equal(packDisposition(undefined).exitCode, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// WHICH IMAGE ANSWERS — an omitted template must not select one with no agent
//
// ★★★ THE DEFECT THIS PINS. Every keyed lane in this repo pipes `inputs.e2b_template`
// straight into `E2B_TEMPLATE`, and E7-F022 measured the consequence: an omitted input
// "silently defaults to the bare `base` template", which `e2b/e2b.Dockerfile:1-7` and the
// last recorded push trigger both say carries NO agent CLIs ("coreutils only"). For the
// sibling lanes, whose subject is the invocation SHAPE, that costs nothing. For THIS pack
// it would spend the founder's single authorised, token-spending run on an image that
// cannot host the thing being measured.
// ─────────────────────────────────────────────────────────────────────────────

test("an OMITTED template resolves to the CLI-bearing alias, NEVER to bare `base`", () => {
  for (const raw of [undefined, null, "", "   ", 42]) {
    const r = resolveTemplate(raw);
    assert.equal(
      r.templateId,
      CLI_BEARING_TEMPLATE_ALIAS,
      `an omitted template (${JSON.stringify(raw)}) must resolve to the image that carries the agent CLIs`,
    );
    assert.notEqual(
      r.templateId,
      BARE_BASE_TEMPLATE_ALIAS,
      "resolving an omitted input to bare `base` runs the decisive probe against an image with no agent (E7-F022)",
    );
    assert.equal(r.source, "default-cli-bearing");
    assert.ok(r.note.includes(CLI_BEARING_TEMPLATE_ALIAS), "the resolution must SAY what it chose and why");
  }
});

// ★ THE POSITIVE CONTROL. If this goes red under the same edit, the fix has stopped the
// operator selecting a template at all — which is a worse lane than the one being fixed.
test("an EXPLICITLY supplied template is honoured unchanged", () => {
  const r = resolveTemplate("  my-private-template  ");
  assert.equal(r.templateId, "my-private-template", "an explicit alias must survive verbatim (trimmed only)");
  assert.equal(r.source, "explicit");
  // Including bare `base`, if an operator deliberately wants the no-CLI measurement:
  // explicit is explicit, and only OMISSION is corrected.
  const bare = resolveTemplate(BARE_BASE_TEMPLATE_ALIAS);
  assert.equal(bare.templateId, BARE_BASE_TEMPLATE_ALIAS);
  assert.equal(bare.source, "explicit");
  assert.ok(bare.note.includes("NO agent CLIs"), "an explicit bare-base choice must still be flagged in the report");
});

test("the CLI-bearing alias is the one e2b/e2b.Dockerfile actually asserts the CLIs into", () => {
  // Not a naming convention: the alias is only worth defaulting to because the image's
  // final layer FAILS THE BUILD unless both binaries resolve.
  const dockerfile = readFileSync(E2B_DOCKERFILE, "utf8");
  assert.ok(
    dockerfile.includes("command -v claude") && dockerfile.includes("command -v codex"),
    "e2b/e2b.Dockerfile no longer asserts both CLIs — re-derive which template carries them before defaulting to one",
  );
  assert.ok(
    dockerfile.includes(CLI_BEARING_TEMPLATE_ALIAS),
    `e2b/e2b.Dockerfile no longer names "${CLI_BEARING_TEMPLATE_ALIAS}" — the default may be pointing at nothing`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE T — E7-F022: A TEMPLATE NAME IS NOT A TEMPLATE FILESYSTEM
//
// ★★★ E7-F022 measured that `E2B_TEMPLATE` "silently defaults to the bare `base`
// template" on every keyed lane, that bare base has no agent CLIs, and that therefore
// "a keyed run against bare `base` can be reported green while the CLIs were never
// present". `resolveTemplate` fixes the NAME on this lane; nothing checked the IMAGE.
// E7-F022's own owner paragraph names the missing piece: "a boot-time or lane-time
// assertion that the registered template contains what the Dockerfile promises".
// ─────────────────────────────────────────────────────────────────────────────

const preflightStdout = (haveClaude, haveCodex) =>
  `${haveClaude ? "W7U1_HAVE:claude" : "W7U1_MISSING:claude"}\n${haveCodex ? "W7U1_HAVE:codex" : "W7U1_MISSING:codex"}\n`;

test("a template carrying BOTH CLIs satisfies the precondition", () => {
  const v = evaluateTemplateCliPreflight({
    channel: "returned",
    exitCode: 0,
    stdout: preflightStdout(true, true),
    template: CLI_BEARING_TEMPLATE_ALIAS,
  });
  assert.equal(v.state, "yes");
  assert.equal(v.reason, "template-carries-the-agent-clis");
  assert.equal(packDisposition([v]).disposition, "measured", "a satisfied precondition must not red the lane");
});

test("a template MISSING a CLI reds the lane, and its detail does NOT claim probe A was skipped", () => {
  const v = evaluateTemplateCliPreflight({
    channel: "returned",
    exitCode: 0,
    stdout: preflightStdout(false, false),
    template: BARE_BASE_TEMPLATE_ALIAS,
  });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "template-does-not-carry-the-agent-clis");
  assert.match(v.detail, /claude \+ codex/);
  assert.match(v.detail, new RegExp(BARE_BASE_TEMPLATE_ALIAS));
  // ★★★ THE ASSERTION IS INVERTED FROM WHAT IT USED TO BE, AND THAT IS THE FIX.
  // It used to REQUIRE `/NO model tokens were spent/` — a sentence that became FALSE when
  // the preflight gate was softened to a caveat. `probeAPreflightCaveat` interpolates THIS
  // detail into probe A's own answer, so the durable record was carrying "Probe A was NOT
  // run" appended to probe A's result. A detail that reaches another probe's answer may not
  // claim a skip.
  assert.doesNotMatch(v.detail, /NO model tokens were spent/);
  assert.doesNotMatch(v.detail, /Probe A was NOT run/);
  assert.match(v.detail, /RUNS ANYWAY/);
  assert.equal(packDisposition([v]).disposition, "inconclusive");
});

test("ONE missing CLI is enough — a half-equipped image is not the image the question is about", () => {
  const v = evaluateTemplateCliPreflight({
    channel: "returned",
    exitCode: 0,
    stdout: preflightStdout(true, false),
    template: "aoa-base-stale",
  });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "template-does-not-carry-the-agent-clis");
  assert.match(v.detail, /codex/);
});

test("SILENCE IS NOT PRESENCE — a check that said nothing about a binary refuses, it does not pass", () => {
  // ★★★ [[checks-that-nothing-runs]], head on. If the shell died, the capture truncated or
  // the script was replaced with one that only reports failures, "no MISSING line" would
  // read as "both present" and the precondition would certify an image nobody looked at.
  const v = evaluateTemplateCliPreflight({ channel: "returned", exitCode: 0, stdout: "", template: "aoa-base" });
  assert.equal(v.state, "inconclusive");
  assert.equal(v.reason, "template-preflight-unreadable");
  assert.notEqual(v.reason, "template-carries-the-agent-clis");
});

test("a preflight that never reached a terminal establishes nothing", () => {
  for (const channel of ["timedOut", "threw", "not-run", "binary-missing"]) {
    const v = evaluateTemplateCliPreflight({ channel, stdout: preflightStdout(true, true), template: "aoa-base" });
    assert.equal(v.state, "inconclusive", `channel=${channel} must not certify the image`);
    assert.equal(v.reason, "template-preflight-did-not-run");
  }
});

test("the preflight SCRIPT prints a positive marker per binary, and names both of them", () => {
  // The script and the reader are a pair; a script that stopped emitting HAVE lines would
  // turn every green run into `template-preflight-unreadable` rather than a silent pass,
  // but pinning it here makes the pairing explicit rather than incidental.
  for (const bin of TEMPLATE_CLI_BINARIES) {
    assert.ok(TEMPLATE_CLI_PROBE_SCRIPT.includes(bin), `the preflight script no longer probes ${bin}`);
  }
  assert.ok(TEMPLATE_CLI_PROBE_SCRIPT.includes("W7U1_HAVE:"), "the script must emit an explicit PRESENT marker");
  assert.ok(TEMPLATE_CLI_PROBE_SCRIPT.includes("W7U1_MISSING:"), "the script must emit an explicit ABSENT marker");
});

test("the binaries the preflight demands are exactly the ones e2b/e2b.Dockerfile asserts", () => {
  // ★★★ IT IS A SET EQUALITY, IN BOTH DIRECTIONS, AND IT DID NOT USED TO BE. This test
  // previously looped over TEMPLATE_CLI_BINARIES and checked each appeared in the file —
  // which cannot catch the OTHER drift: the Dockerfile adding a third CLI the lane-time
  // preflight never demands, so the image asserts more than the precondition checks and
  // the title's word "exactly" is false. One-directional containment titled as equality is
  // this programme's [[checks-that-nothing-runs]] class in its quietest form.
  //
  // ★★ COMMENT LINES ARE EXCLUDED, AND THAT IS LOAD-BEARING. `e2b/e2b.Dockerfile:53` is a
  // COMMENT that itself contains "`command -v claude` / `command -v codex`". Scanning the
  // whole file would let the comment satisfy the assertion after someone deleted the RUN
  // layer at :54 — a check passing on the prose that describes the thing it is checking.
  const dockerfile = readFileSync(E2B_DOCKERFILE, "utf8");
  const executable = dockerfile
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  const asserted = [...executable.matchAll(/command -v ([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  assert.ok(
    asserted.length > 0,
    "e2b/e2b.Dockerfile has no `command -v` assertion on any NON-COMMENT line — either the build guard was deleted " +
      "or this scan has stopped matching. A ban/scan that matches nothing is a check that nothing runs.",
  );
  assert.deepEqual(
    [...new Set(asserted)].sort(),
    [...TEMPLATE_CLI_BINARIES].sort(),
    "the lane-time precondition and the image's own build guard have drifted apart: the Dockerfile asserts " +
      `${JSON.stringify([...new Set(asserted)].sort())} and the preflight demands ` +
      `${JSON.stringify([...TEMPLATE_CLI_BINARIES].sort())}. Reconcile them — a binary asserted at build time and ` +
      "not demanded at lane time is an unchecked promise, and the reverse is a precondition nobody guarantees.",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DURABLE RECORD — a verdict that lives only in a job log is a lost measurement
//
// ★★★ THE DEFECT THIS PINS. E7-F025 measured that the sibling keyed lane already fired
// TWICE (`.github/keyed-e2b-trigger` re-fires #3 and #4) and that no document in the repo
// records either outcome, so the honest state of that measurement is "fired and
// unrecorded". This pack must not lose the founder's one authorised run the same way.
// ─────────────────────────────────────────────────────────────────────────────

const RECORD_VERDICTS = [
  { probe: "B", state: "no", reason: "template-prefills-nothing", detail: "listing: .bashrc" },
  { probe: "C", state: "yes", reason: "both-streams-delivered", detail: "" },
  { probe: "A/claude_local", state: "inconclusive", reason: "no-model-provider-key", detail: "ANTHROPIC_API_KEY unset" },
];

test("the record carries the disposition, EVERY probe's state AND reason, the template and the sha", () => {
  const rec = buildProbeRecord({
    verdicts: RECORD_VERDICTS,
    template: CLI_BEARING_TEMPLATE_ALIAS,
    templateSource: "default-cli-bearing",
    templateNote: "n",
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    runNonce: "W7U1-X",
    generatedAt: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(rec.schema, PROBE_RECORD_SCHEMA);
  assert.equal(rec.template.resolved, CLI_BEARING_TEMPLATE_ALIAS);
  assert.equal(rec.template.source, "default-cli-bearing");
  assert.equal(rec.template.carriesAgentClis, true);
  assert.equal(rec.commitSha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(rec.disposition.disposition, "inconclusive");
  assert.equal(rec.disposition.exitCode, 1);
  assert.deepEqual(
    rec.probes.map((p) => `${p.probe}=${p.state}/${p.reason}`),
    [
      "B=no/template-prefills-nothing",
      "C=yes/both-streams-delivered",
      "A/claude_local=inconclusive/no-model-provider-key",
    ],
    "a record that drops a probe's REASON says what happened but not what to do next",
  );
});

test("a record with NO resolved template is REFUSED — it could not be interpreted later", () => {
  assert.throws(
    () => buildProbeRecord({ verdicts: RECORD_VERDICTS, template: "  ", commitSha: "abc" }),
    ProbeRecordError,
    "a record that does not say which image answered is unreadable a month later (E7-F022)",
  );
});

test("a record is buildable for a run that produced NO verdicts at all — the inconclusive run still records", () => {
  const rec = buildProbeRecord({ verdicts: [], template: CLI_BEARING_TEMPLATE_ALIAS });
  assert.equal(rec.disposition.disposition, "inconclusive");
  assert.equal(rec.probes.length, 0);
  assert.equal(rec.commitSha, "unknown", "an unknown sha is recorded as unknown, not omitted");
});

// ─────────────────────────────────────────────────────────────────────────────
// AND THE LANE ITSELF MUST ACTUALLY RETRIEVE IT — asserted against the REAL YAML
//
// ★★★ WITHOUT THIS, EVERY TEST ABOVE IS VACUOUS. `buildProbeRecord` can be perfect and the
// record still reach nobody, because whether it is uploaded — and whether it is uploaded on
// a RED run — is decided in YAML that no test reads. Same shape as `ci-lanes.mjs`'s
// `uploadsEvidenceBundleOnFailure`, which already does this for `d1-merge-train.yml`'s
// evidence bundle.
// ─────────────────────────────────────────────────────────────────────────────

test("the W7U1 keyed lane uploads its record, on a RED run as well as a green one", () => {
  const { violations } = evaluateDurableRecord(readFileSync(PROBE_WORKFLOW, "utf8"));
  assert.deepEqual(
    violations.map((v) => v.code),
    [],
    `keyed-e2b-w7u1-output-probe.yml does not durably record its verdict:\n${violations
      .map((v) => `  - ${v.code}: ${v.detail}`)
      .join("\n")}`,
  );
});

// ★ THE CHECKER'S OWN NEGATIVE CONTROLS. A guard that cannot go red is not a guard — this
// programme's [[checks-that-nothing-runs]] class. Each fixture removes exactly one property
// and the corresponding code must appear.
test("evaluateDurableRecord goes RED when the guard, the upload, the fallback or the default is removed", () => {
  const real = readFileSync(PROBE_WORKFLOW, "utf8");

  // 1. The upload step loses its `if: always()` — the inconclusive run's artefact is dropped.
  const unguarded = real.replace(/(uses: actions\/upload-artifact@[0-9a-f]+ # v[0-9.]+\r?\n\s*)if: always\(\)\r?\n/, "$1");
  assert.notEqual(unguarded, real, "the fixture edit did not apply — re-derive it from the workflow");
  assert.ok(
    evaluateDurableRecord(unguarded).violations.some((v) => v.code === "record-upload-unguarded"),
    "a success-gated upload must be caught: the red run is the one whose detail someone needs",
  );

  // 2. No upload step at all.
  assert.ok(
    evaluateDurableRecord(real.replace(/uses: actions\/upload-artifact[^\n]*/g, "uses: actions/checkout@v9")).violations.some(
      (v) => v.code === "record-upload-missing",
    ),
  );

  // 3. No always()-guarded writer, so a pack that dies early uploads nothing.
  assert.ok(
    evaluateDurableRecord(real.replace(/W7U1_RECORD_PATH/g, "SOME_OTHER_PATH")).violations.some(
      (v) => v.code === "record-fallback-missing",
    ),
  );

  // 4. The shell fallback's default drifts away from the pure core's.
  assert.ok(
    evaluateDurableRecord(real.replace(/W7U1_DEFAULT_TEMPLATE: aoa-base/, "W7U1_DEFAULT_TEMPLATE: base")).violations.some(
      (v) => v.code === "default-template-mismatch",
    ),
    "the record and the run must not be able to name different images",
  );

  // 5. The shell fallback's SCHEMA drifts away from `buildProbeRecord`'s.
  //
  // ★★★ THIS DRIFT ACTUALLY HAPPENED. Bumping `PROBE_RECORD_SCHEMA` to `/2` for
  // `armEvidence` left this workflow's heredoc emitting `/1`, and nothing said so — one lane
  // shipping two record shapes under two version numbers, which is worse than no version at
  // all because a reader would trust the number.
  assert.ok(
    evaluateDurableRecord(real.replace(/output-probe-record\/2/, "output-probe-record/1")).violations.some(
      (v) => v.code === "fallback-schema-mismatch",
    ),
    "one lane must not ship two record shapes under two version numbers",
  );
  // POSITIVE CONTROL: the real workflow agrees with the pure core today.
  assert.ok(
    !evaluateDurableRecord(real).violations.some((v) => v.code.startsWith("fallback-schema-")),
    "the checked-in workflow's fallback schema must match PROBE_RECORD_SCHEMA",
  );
});
