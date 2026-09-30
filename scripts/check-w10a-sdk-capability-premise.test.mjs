/**
 * Self-test for `check-w10a-sdk-capability-premise.mjs` (finding `E8-F007`).
 *
 * ★ IT DRIVES A FIXTURE REPOSITORY, NOT THIS ONE. A guard whose only evidence is "it is
 * green on the tree it was written against" has never been observed red, and this
 * programme's named worst failure class is a check that nothing runs. Every fixture below
 * is a state this guard is supposed to have an opinion about, including the two states where
 * the correct opinion is SILENCE:
 *
 *   - an honest sentence about the capability being UNMEASURED is GREEN (the guard must not
 *     ban discussing the topic — it bans asserting the refuted claim);
 *   - a quotation carrying a correction marker is GREEN (the record has to be able to quote
 *     what it is correcting);
 *   - and when the SDK surface is GONE, the ban is SUSPENDED rather than enforced, because
 *     the claim may have become true again. A ban that outlives its premise is the same
 *     defect in a new place.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  evaluateSdkCapabilityPremise,
  scanTextForStaleClaims,
} from "./lib/w10a-sdk-capability-premise.mjs";
import { readLockfileVersions, runPremiseCheck } from "./check-w10a-sdk-capability-premise.mjs";

// The phrase every fixture below quotes. Assembled at runtime so this constant does not
// itself read as an assertion in the tree scan — and marked anyway: E8-F007.
const CLAIM = ["Managed-E2B egress is", "not fully lockable."].join(" ");

const MANIFEST = {
  package: "e2b",
  measuredVersion: "2.30.5",
  resolveFrom: ["app/package.json"],
  correctionMarkers: ["E8-F007"],
  contextWindowLines: 6,
  surfaceMarkers: [
    { file: "dist/index.d.ts", needle: "network?: SandboxNetworkOpts;", why: "create carries it" },
    { file: "dist/index.js", needle: "network: buildNetworkBody(", why: "and sends it" },
  ],
  stalePatterns: [
    {
      id: "not-fully-lockable",
      pattern: "not\\s+(?:fully\\s+)?lockable",
      minOccurrences: 1,
      why: "the sentence family that actually occurred",
    },
  ],
};

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A minimal tracked repository: git, a lockfile, the manifest, and an installed SDK. */
function makeFixture({ docText, manifest = MANIFEST, lockVersion = "2.30.5", installSdk = true, track = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "w10a-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });

  write(root, "pnpm-lock.yaml", `packages:\n\n  duplexer2@0.1.4:\n\n  e2b@${lockVersion}:\n    resolution: {}\n`);
  write(root, "scripts/w10a-sdk-capability-premise.json", JSON.stringify(manifest, null, 2));
  write(root, "app/package.json", JSON.stringify({ name: "app", dependencies: { e2b: "^2.30.5" } }));
  if (docText !== undefined) write(root, "docs/note.md", docText);

  if (installSdk) {
    const sdk = "app/node_modules/e2b";
    write(root, `${sdk}/package.json`, JSON.stringify({ name: "e2b", version: "2.30.5", main: "dist/index.js" }));
    write(root, `${sdk}/dist/index.d.ts`, "type SandboxOpts = {\n  network?: SandboxNetworkOpts;\n};\n");
    write(root, `${sdk}/dist/index.js`, "const body = {\n  network: buildNetworkBody(opts?.network),\n};\n");
  }

  if (track) {
    execFileSync("git", ["add", "-A", "--force"], { cwd: root });
  }
  return root;
}

const problemKinds = (result) => result.problems.map((p) => p.kind).sort();

// ─────────────────────────────────────────────────────────────────────────────────────────
// The pure scanner.
// ─────────────────────────────────────────────────────────────────────────────────────────

test("a quotation with a correction marker on the same line is marked", () => {
  // E8-F007 — the fixture text below is a quotation, which is exactly the legal case.
  const hits = scanTextForStaleClaims(`x\n${CLAIM} (REFUTED — E8-F007)\ny`, {
    patterns: MANIFEST.stalePatterns,
    markers: ["E8-F007"],
    contextWindowLines: 6,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].marked, true);
});

test("the marker counts within the window and not outside it", () => {
  const patterns = MANIFEST.stalePatterns;
  const opts = { patterns, markers: ["E8-F007"], contextWindowLines: 2 };
  // E8-F007 — both fixtures quote the claim; the difference is only the distance.
  const near = scanTextForStaleClaims(`E8-F007\na\n${CLAIM}`, opts);
  const far = scanTextForStaleClaims(`E8-F007\na\nb\nc\n${CLAIM}`, opts);
  assert.equal(near[0].marked, true);
  assert.equal(far[0].marked, false);
});

test("★ POSITIVE CONTROL — an honest sentence about the capability being UNMEASURED is not a hit", () => {
  const honest =
    "The installed e2b SDK exposes SandboxOpts.network, updateNetwork and a getInfo() " +
    "read-back. Whether the operator's E2B tier honours a network body is UNMEASURED, and " +
    "nothing here claims egress is locked.";
  const hits = scanTextForStaleClaims(honest, {
    patterns: MANIFEST.stalePatterns,
    markers: ["E8-F007"],
  });
  assert.deepEqual(hits, [], "the guard must not ban discussing the topic honestly");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The evaluator.
// ─────────────────────────────────────────────────────────────────────────────────────────

const baseInput = {
  declaration: MANIFEST,
  lockfileVersions: ["2.30.5"],
  sdkSurface: { version: "2.30.5", resolvedFrom: { "app/package.json": "…" }, missingMarkers: [] },
  occurrences: [{ file: "docs/note.md", patternId: "not-fully-lockable", line: 1, marked: true }],
};

test("the clean state passes, and reports the capability as held", () => {
  const r = evaluateSdkCapabilityPremise(baseInput);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.capabilityHeld, true);
});

test("★ MUTATION — an unmarked occurrence fails while the capability is held", () => {
  const r = evaluateSdkCapabilityPremise({
    ...baseInput,
    occurrences: [{ file: "docs/note.md", patternId: "not-fully-lockable", line: 1, marked: false }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(problemKinds(r), ["stale_claim_unmarked"]);
});

test("★★★ the ban is CONDITIONAL — when the SDK surface is gone the same unmarked occurrence is NOT banned", () => {
  const r = evaluateSdkCapabilityPremise({
    ...baseInput,
    sdkSurface: {
      version: "2.30.5",
      resolvedFrom: { "app/package.json": "…" },
      missingMarkers: [{ file: "dist/index.d.ts", needle: "network?: SandboxNetworkOpts;" }],
    },
    occurrences: [{ file: "docs/note.md", patternId: "not-fully-lockable", line: 1, marked: false }],
  });
  assert.equal(r.capabilityHeld, false);
  // It still FAILS — the declaration is stale and must be re-derived — but NOT with the ban.
  assert.deepEqual(problemKinds(r), ["sdk_surface_missing"]);
  assert.equal(r.unmarkedCount, 0);
});

test("a lockfile bump fails, because the surface declaration is true only OF A VERSION", () => {
  const r = evaluateSdkCapabilityPremise({ ...baseInput, lockfileVersions: ["2.31.0"] });
  assert.equal(r.ok, false);
  assert.deepEqual(problemKinds(r), ["lockfile_version_mismatch"]);
});

test("two resolved versions are refused rather than arbitrated", () => {
  const r = evaluateSdkCapabilityPremise({ ...baseInput, lockfileVersions: ["2.30.5", "2.31.0"] });
  assert.deepEqual(problemKinds(r), ["lockfile_version_ambiguous"]);
});

test("★ a ban pattern that matches nothing FAILS — a check that nothing runs is not a check", () => {
  const r = evaluateSdkCapabilityPremise({ ...baseInput, occurrences: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(problemKinds(r), ["pattern_matches_nothing"]);
});

test("--require-sdk turns an unmeasurable surface into a failure; without it, into a NOTE", () => {
  const withFlag = evaluateSdkCapabilityPremise({ ...baseInput, sdkSurface: null, requireSdk: true });
  assert.deepEqual(problemKinds(withFlag), ["sdk_not_resolvable"]);

  const withoutFlag = evaluateSdkCapabilityPremise({ ...baseInput, sdkSurface: null });
  assert.equal(withoutFlag.ok, true);
  assert.equal(withoutFlag.sdkMeasured, false);
  assert.match(withoutFlag.notes.join(" "), /NOT MEASURED/);
  // …and the ban still ran in that lane, on the strength of the lockfile pin.
  const banned = evaluateSdkCapabilityPremise({
    ...baseInput,
    sdkSurface: null,
    occurrences: [{ file: "docs/note.md", patternId: "not-fully-lockable", line: 1, marked: false }],
  });
  assert.deepEqual(problemKinds(banned), ["stale_claim_unmarked"]);
});

test("an empty pattern list is a malformed declaration, not a vacuous pass", () => {
  const r = evaluateSdkCapabilityPremise({
    ...baseInput,
    declaration: { ...MANIFEST, stalePatterns: [] },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(problemKinds(r), ["malformed_declaration"]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The CLI, end to end on a fixture repository.
// ─────────────────────────────────────────────────────────────────────────────────────────

test("end to end: a MARKED quotation in a tracked file passes with the SDK required", () => {
  // E8-F007 — the fixture doc quotes the claim and cites the finding on the same line.
  const root = makeFixture({ docText: `intro\n${CLAIM} (REFUTED — E8-F007)\nend\n` });
  const { result, occurrences, sdkSurface } = runPremiseCheck(root, { requireSdk: true });
  assert.equal(sdkSurface.missingMarkers.length, 0);
  assert.equal(occurrences.length, 1);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test("★ end to end MUTATION: the same quotation with the marker removed FAILS", () => {
  // E8-F007 — identical fixture, one difference: no marker.
  const root = makeFixture({ docText: `intro\n${CLAIM}\nend\n` });
  const { result } = runPremiseCheck(root, { requireSdk: true });
  assert.equal(result.ok, false);
  assert.deepEqual(problemKinds(result), ["stale_claim_unmarked"]);
  assert.match(result.problems[0].detail, /docs\/note\.md:2/);
});

test("★★★ end to end: the MANIFEST is not scanned, so a ban cannot be its own evidence", () => {
  // MEASURED DEFECT, not a hypothetical. The manifest stores each ban as a regex source string
  // and quotes the sentence it bans in that pattern's `why`. While the manifest was scanned,
  // mutating the pattern to a token that appears nowhere in the record left the guard GREEN
  // with "1 quotation … all marked" — the mutated pattern matched its own declaration, so the
  // pattern_matches_nothing clause could never fire. Both halves are pinned here (E8-F007).
  const selfMatching = {
    ...MANIFEST,
    stalePatterns: [
      {
        id: "self-referential",
        // Appears ONLY inside the manifest — nowhere else in the fixture repository.
        pattern: "qqq-only-in-the-manifest-qqq",
        minOccurrences: 1,
        why: "a pattern whose only occurrence would be its own declaration",
      },
    ],
  };
  const root = makeFixture({ docText: "nothing relevant here\n", manifest: selfMatching });
  const { result, occurrences } = runPremiseCheck(root, { requireSdk: true });
  assert.deepEqual(occurrences, [], "the manifest must not count as an occurrence of its own ban");
  assert.deepEqual(problemKinds(result), ["pattern_matches_nothing"]);
});

test("end to end: an UNTRACKED file is not the record and is not scanned", () => {
  // E8-F007 — the claim is present, unmarked, and untracked. Scope, proven rather than assumed.
  const root = makeFixture({ docText: `intro\n${CLAIM}\nend\n`, track: false });
  execFileSync("git", ["add", "--force", "pnpm-lock.yaml", "scripts", "app/package.json"], { cwd: root });
  const { result, occurrences } = runPremiseCheck(root, { requireSdk: true });
  assert.deepEqual(occurrences, []);
  // Nothing to scan means the ban pattern matched nothing, which is itself a failure.
  assert.deepEqual(problemKinds(result), ["pattern_matches_nothing"]);
});

test("end to end: --require-sdk fails when the dependency is not installed", () => {
  // E8-F007 — a marked quotation, so only the SDK half can be the cause.
  const root = makeFixture({ docText: `${CLAIM} (E8-F007)\n`, installSdk: false });
  assert.deepEqual(problemKinds(runPremiseCheck(root, { requireSdk: true }).result), [
    "sdk_not_resolvable",
  ]);
  assert.equal(runPremiseCheck(root, { requireSdk: false }).result.ok, true);
});

test("readLockfileVersions reads the resolved version, not the declared range", () => {
  const root = makeFixture({ docText: `${CLAIM} (E8-F007)\n` });
  fs.appendFileSync(
    path.join(root, "pnpm-lock.yaml"),
    "importers:\n  server:\n    dependencies:\n      e2b:\n        specifier: ^2.30.5\n        version: 2.30.5\n",
  );
  assert.deepEqual(readLockfileVersions(root, "e2b"), ["2.30.5"]);
  assert.deepEqual(readLockfileVersions(root, "no-such-package"), []);
});
