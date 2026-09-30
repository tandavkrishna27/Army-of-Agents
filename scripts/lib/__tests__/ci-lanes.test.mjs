// -----------------------------------------------------------------------------
// DEP-004 — pure ci-lanes validator suite (node --test, LOCAL: no PG/Docker).
//
//   node --test scripts/lib/__tests__/ci-lanes.test.mjs
//
// These cases are written FIRST (RED) and are deliberately NON-VACUOUS: the valid
// fixture passes (zero violations), and each defect fixture removes exactly one
// invariant and asserts the corresponding violation fires. The CLI
// (scripts/check-ci-lanes.mjs) parses the REAL pr.yml + d1-merge-train.yml into
// the same structure `evaluateCiLanes` consumes here.
//
// Invariants under test (mirrors the HARD RULES):
//   * every protocol/schema/provider path-class maps to a MANDATORY consumer that
//     is (a) emitted by `changes`, (b) gated on its class, (c) in ci-required.needs,
//     (d) folded into the ci-required verdict, and (e) class-gated in that verdict
//     (required only when its class changed — the `code`-gated docs-only pattern);
//   * NO trigger-level `paths:`/`paths-ignore:` exists on pr.yml;
//   * d1-merge-train.yml uploads the required evidence bundle on failure.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCiLanes,
  DEFAULT_REQUIRED_NEEDS,
  parseCiRequiredVerdict,
  uploadsEvidenceBundleOnFailure,
} from "../ci-lanes.mjs";

const REQUIRED_NEEDS = [
  { pathClass: "protocol", consumer: "distributed-contract" },
  { pathClass: "schema", consumer: "distributed-contract" },
  { pathClass: "provider", consumer: "distributed-contract" },
];

/** A fully-valid, minimal parsed-workflow fixture. Deep-cloned per test. */
function validWorkflows() {
  return {
    "pr.yml": {
      triggers: {
        pull_request: {
          types: ["opened", "synchronize", "reopened", "ready_for_review"],
        },
        push: { branches: ["main"] },
      },
      changesOutputs: [
        "code",
        "protocol",
        "schema",
        "fixtures",
        "provider",
        "compose",
      ],
      jobs: {
        changes: { needs: [], if: "github.event_name != 'pull_request'" },
        policy: { needs: [], if: "" },
        "distributed-contract": {
          needs: ["changes"],
          if:
            "needs.changes.outputs.protocol == 'true' || " +
            "needs.changes.outputs.schema == 'true' || " +
            "needs.changes.outputs.fixtures == 'true' || " +
            "needs.changes.outputs.provider == 'true'",
        },
        "ci-required": { needs: ["changes", "policy", "distributed-contract"], if: "!cancelled()" },
      },
      ciRequired: {
        jobName: "ci-required",
        needs: ["changes", "policy", "distributed-contract"],
        verdictConsumes: ["changes", "policy", "distributed-contract"],
        verdictClassGates: ["code", "protocol", "schema", "fixtures", "provider"],
      },
    },
    "d1-merge-train.yml": {
      triggers: { merge_group: null, push: { branches: ["main"] } },
      uploadsEvidenceOnFailure: true,
    },
  };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

test("valid config passes with zero violations", () => {
  const { violations } = evaluateCiLanes({
    workflows: validWorkflows(),
    requiredNeeds: REQUIRED_NEEDS,
  });
  assert.deepEqual(violations, [], `expected no violations, got:\n${violations.join("\n")}`);
});

test("DEFAULT_REQUIRED_NEEDS covers protocol/schema/provider and also passes", () => {
  const classes = new Set(DEFAULT_REQUIRED_NEEDS.map((r) => r.pathClass));
  for (const c of ["protocol", "schema", "provider"]) {
    assert.ok(classes.has(c), `DEFAULT_REQUIRED_NEEDS is missing path-class "${c}"`);
  }
  const { violations } = evaluateCiLanes({ workflows: validWorkflows() });
  assert.deepEqual(violations, [], `expected no violations with default requiredNeeds, got:\n${violations.join("\n")}`);
});

test("NEGATIVE: a protocol path with no mandatory consumer in ci-required.needs FAILS", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].ciRequired.needs = wf["pr.yml"].ciRequired.needs.filter((n) => n !== "distributed-contract");
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(violations.length > 0, "expected a violation when the consumer is absent from ci-required.needs");
  assert.ok(
    violations.some((v) => /distributed-contract/.test(v) && /ci-required\.needs/.test(v)),
    `expected a 'not in ci-required.needs' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: changes job that does not emit the protocol output FAILS", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].changesOutputs = wf["pr.yml"].changesOutputs.filter((o) => o !== "protocol");
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /protocol/.test(v) && /changes/.test(v) && /emit/.test(v)),
    `expected a 'changes does not emit protocol' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: a trigger-level `paths:` on pr.yml FAILS", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].triggers.pull_request.paths = ["src/**"];
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /paths/.test(v) && /trigger/.test(v)),
    `expected a trigger-level paths violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: a trigger-level `paths-ignore:` under push on pr.yml FAILS", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].triggers.push["paths-ignore"] = ["docs/**"];
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /paths-ignore/.test(v) && /trigger/.test(v)),
    `expected a trigger-level paths-ignore violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: the consumer job not gated on its path-class FAILS", () => {
  const wf = clone(validWorkflows());
  // Drop the protocol clause from the consumer's if-gate.
  wf["pr.yml"].jobs["distributed-contract"].if =
    "needs.changes.outputs.schema == 'true' || needs.changes.outputs.provider == 'true'";
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /distributed-contract/.test(v) && /protocol/.test(v) && /gate/.test(v)),
    `expected a 'consumer not gated on protocol' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: consumer in ci-required.needs but not folded into the verdict FAILS", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].ciRequired.verdictConsumes = wf["pr.yml"].ciRequired.verdictConsumes.filter(
    (n) => n !== "distributed-contract",
  );
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /distributed-contract/.test(v) && /verdict/.test(v)),
    `expected a 'not folded into the verdict' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: verdict that does not class-gate the consumer FAILS (would make it unconditionally required)", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].ciRequired.verdictClassGates = ["code"]; // no protocol/schema/provider gate
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /verdict/.test(v) && /(protocol|schema|provider)/.test(v) && /gate/.test(v)),
    `expected a 'verdict does not class-gate the consumer' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: d1-merge-train.yml that does not upload evidence on failure FAILS", () => {
  const wf = clone(validWorkflows());
  wf["d1-merge-train.yml"].uploadsEvidenceOnFailure = false;
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /d1-merge-train/.test(v) && /evidence/.test(v)),
    `expected a merge-train evidence-upload violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: missing d1-merge-train.yml entirely FAILS", () => {
  const wf = clone(validWorkflows());
  delete wf["d1-merge-train.yml"];
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /d1-merge-train/.test(v)),
    `expected a missing-merge-train violation, got:\n${violations.join("\n")}`,
  );
});

test("FAIL-CLOSED: missing pr.yml FAILS", () => {
  const { violations } = evaluateCiLanes({ workflows: {}, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /pr\.yml/.test(v)),
    `expected a missing-pr.yml violation, got:\n${violations.join("\n")}`,
  );
});

test("FAIL-CLOSED: pr.yml with no ci-required aggregator FAILS", () => {
  const wf = clone(validWorkflows());
  delete wf["pr.yml"].jobs["ci-required"];
  wf["pr.yml"].ciRequired = undefined;
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /ci-required/.test(v)),
    `expected a missing-ci-required violation, got:\n${violations.join("\n")}`,
  );
});

test("FAIL-CLOSED: empty changesOutputs FAILS every path-class", () => {
  const wf = clone(validWorkflows());
  wf["pr.yml"].changesOutputs = [];
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(violations.length >= 3, `expected at least one violation per path-class, got:\n${violations.join("\n")}`);
});

// ---------------------------------------------------------------------------
// FIX 2 — the verdict-folding check must prove the verdict `run:` USES the
// captured result, not merely capture it in `env:`. `parseCiRequiredVerdict`
// scans the ci-required job body: env captures `R_DC` for distributed-contract,
// but the `run:` shell must actually TEST `$R_DC` for the job to count as folded.
// ---------------------------------------------------------------------------

/** A ci-required body whose env captures R_DC + the class vars, whose run: tests
 *  the class vars in the contract_changed computation but NEVER tests $R_DC. */
const VERDICT_BODY_ENV_CAPTURES_DC_BUT_RUN_NEVER_TESTS_IT = [
  "    needs: [changes, distributed-contract]",
  "    if: ${{ !cancelled() }}",
  "    steps:",
  "      - name: Evaluate required gate",
  "        env:",
  "          R_DC: ${{ needs['distributed-contract'].result }}",
  "          R_PROTOCOL: ${{ needs.changes.outputs.protocol }}",
  "          R_SCHEMA: ${{ needs.changes.outputs.schema }}",
  "          R_PROVIDER: ${{ needs.changes.outputs.provider }}",
  "        run: |",
  '          echo "dc=$R_DC protocol=$R_PROTOCOL"',
  "          contract_changed=false",
  '          for c in "$R_PROTOCOL" "$R_SCHEMA" "$R_PROVIDER"; do',
  '            [ "$c" = "true" ] && contract_changed=true',
  "          done",
  "          # DEFECT: R_DC is captured in env but never tested in a failure branch.",
  "          exit 0",
].join("\n");

test("NEGATIVE (FIX 2): env captures R_DC but the run: never tests it ⇒ verdict FAILS", () => {
  const { verdictConsumes, verdictClassGates } = parseCiRequiredVerdict(
    VERDICT_BODY_ENV_CAPTURES_DC_BUT_RUN_NEVER_TESTS_IT,
  );
  const wf = clone(validWorkflows());
  // Everything else stays valid; only the parsed verdict facts are substituted so
  // the sole defect under test is "R_DC captured but never tested".
  wf["pr.yml"].ciRequired.verdictConsumes = verdictConsumes;
  wf["pr.yml"].ciRequired.verdictClassGates = verdictClassGates;
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.ok(
    violations.some((v) => /distributed-contract/.test(v) && /verdict/.test(v)),
    `expected a 'distributed-contract not folded into the verdict' violation when R_DC is captured in env but never tested in run:, got:\n${violations.join("\n")}`,
  );
});

test("POSITIVE (FIX 2): a verdict that DOES test $R_DC in a failure branch folds it in", () => {
  const body = [
    "        env:",
    "          R_DC: ${{ needs['distributed-contract'].result }}",
    "          R_PROTOCOL: ${{ needs.changes.outputs.protocol }}",
    "          R_SCHEMA: ${{ needs.changes.outputs.schema }}",
    "          R_PROVIDER: ${{ needs.changes.outputs.provider }}",
    "        run: |",
    "          contract_changed=false",
    '          for c in "$R_PROTOCOL" "$R_SCHEMA" "$R_PROVIDER"; do',
    '            [ "$c" = "true" ] && contract_changed=true',
    "          done",
    '          if [ "$contract_changed" = "true" ]; then',
    '            [ "$R_DC" = "success" ] || { echo "::error::dc"; fail=1; }',
    "          fi",
  ].join("\n");
  const { verdictConsumes, verdictClassGates } = parseCiRequiredVerdict(body);
  assert.ok(verdictConsumes.includes("distributed-contract"), "R_DC tested ⇒ distributed-contract folded");
  for (const c of ["protocol", "schema", "provider"]) {
    assert.ok(verdictClassGates.includes(c), `class ${c} used in contract_changed ⇒ gated`);
  }
});

// ---------------------------------------------------------------------------
// FIX 3 — the merge-train evidence check must match the EVIDENCE bundle
// specifically, not any failure()/always()-guarded upload-artifact step.
// ---------------------------------------------------------------------------

test("NEGATIVE (FIX 3): a guarded NON-evidence upload + an UNGUARDED evidence upload ⇒ NOT satisfied", () => {
  const wfText = [
    "jobs:",
    "  d1-merge-train:",
    "    steps:",
    "      - name: Upload playwright report (on failure)",
    "        if: failure()",
    "        uses: actions/upload-artifact@v7",
    "        with:",
    "          name: playwright-report",
    "          path: tests/e2e/playwright-report/",
    "      - name: Upload evidence bundle (UNGUARDED — always runs)",
    "        uses: actions/upload-artifact@v7",
    "        with:",
    "          name: d1-merge-train-evidence-123",
    "          path: ${{ env.EVIDENCE_DIR }}/",
  ].join("\n");
  assert.equal(
    uploadsEvidenceBundleOnFailure(wfText),
    false,
    "a guarded NON-evidence upload must NOT satisfy the merge-train evidence-on-failure rule",
  );
});

test("POSITIVE (FIX 3): a failure()-guarded upload of the EVIDENCE bundle IS satisfied", () => {
  const byPath = [
    "      - name: Upload retained evidence bundle (on failure)",
    "        if: failure()",
    "        uses: actions/upload-artifact@v7",
    "        with:",
    "          name: d1-merge-train-evidence-${{ github.run_id }}",
    "          path: ${{ env.EVIDENCE_DIR }}/",
  ].join("\n");
  assert.equal(uploadsEvidenceBundleOnFailure(byPath), true, "guarded evidence upload (path under EVIDENCE_DIR) IS satisfied");

  // `name:` containing "evidence" also qualifies, even without the env path.
  const byName = [
    "      - name: Upload evidence",
    "        if: always()",
    "        uses: actions/upload-artifact@v7",
    "        with:",
    "          name: d1-evidence-bundle",
    "          path: some/dir/",
  ].join("\n");
  assert.equal(uploadsEvidenceBundleOnFailure(byName), true, "guarded evidence upload (name contains 'evidence') IS satisfied");
});

test("★ the policy job may NOT be gated on changes.outputs.code", () => {
  // The policy job carries the guards that reason over DOCUMENTS — the ticket graph, the
  // guard inventory, and finding ownership. Their trigger IS a docs change: adding an open
  // finding to findings.md is a docs-only diff. Code-gating this job means those guards
  // stop running for exactly the change that should trip them, while the job still reports
  // green because it was never asked. That is the same shape as the four blockers that
  // reached the top of this programme's critical path unscheduled — and the guard that
  // would have caught them lives in this job.
  const wf = validWorkflows();
  wf["pr.yml"].jobs.policy.if =
    "needs.changes.outputs.code == 'true' && github.event_name != 'pull_request'";
  const { violations } = evaluateCiLanes({ workflows: wf, requiredNeeds: REQUIRED_NEEDS });
  assert.equal(
    violations.some((v) => v.includes('"policy" job is gated on changes.outputs.code')),
    true,
    `expected a policy code-gating violation, got: ${JSON.stringify(violations)}`,
  );
});

test("a policy job with no code gate is accepted", () => {
  // The positive control: without it, the test above could pass because the fixture is
  // invalid for some unrelated reason.
  const { violations } = evaluateCiLanes({ workflows: validWorkflows(), requiredNeeds: REQUIRED_NEEDS });
  assert.equal(
    violations.some((v) => v.includes('"policy" job is gated')),
    false,
    `unexpected policy violation: ${JSON.stringify(violations)}`,
  );
});
