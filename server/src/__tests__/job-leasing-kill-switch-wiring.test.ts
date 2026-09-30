/**
 * REL-004 Lane C — the kill switch is actually CONSULTED, and stays consulted.
 *
 * This programme's worst defects are all one failure class: a check that nothing runs. Three
 * fail-closed admission verifiers, a frozen-protocol guard and 154 deleted test files all passed
 * CI while proving nothing. `evaluateKillSwitches` itself sat mutation-tested at 18/18 with ZERO
 * callers, which is why clause 3a was still open after Lanes A and B landed.
 *
 * The integration suite proves the switch works end to end today. This is the cheaper guard that
 * fails fast and names the file when someone unwires it — the same anti-orphan shape REL-004
 * Lane A used for the admission verifiers.
 *
 * NOTE the shape it pins. The reader is built INSIDE `createJobLeasingService` from the same
 * `appDb` the authority chain uses, and is deliberately not a service option: the JOB-003
 * contract guard `service:no-context-or-guard-injection` refuses an injected guard, and it is
 * right to — a reader a caller supplies is a reader a caller can substitute, and substituting one
 * that always reports "no policy" turns the stop button off for the whole fleet with no trace.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LEASING = readFileSync(
  fileURLToPath(new URL("../services/job-leasing.ts", import.meta.url)),
  "utf8",
);
const TARGETS = readFileSync(
  fileURLToPath(new URL("../services/execution-targets.ts", import.meta.url)),
  "utf8",
);
const JOB_CONTROL_REPO = readFileSync(
  fileURLToPath(new URL("../../../packages/db/src/repositories/tenant/job-control.ts", import.meta.url)),
  "utf8",
);
const KILL_SWITCHES = readFileSync(
  fileURLToPath(new URL("../services/execution-kill-switches.ts", import.meta.url)),
  "utf8",
);

/**
 * Strip comments before asserting a token is absent.
 *
 * Without this the separation check below fails on the module's own PROSE — the header
 * explains at length why a kill switch is not a revocation, and the word "revoking" appears
 * in that explanation. A guard that matches documentation instead of code is a guard that
 * punishes writing the documentation.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("REL-004 Lane C — the poll cannot be built without its kill switch", () => {
  it("constructs the reader internally, from the SAME pool the lease transaction runs on", () => {
    expect(LEASING).toContain("createKillSwitchPolicyReader({ appDb: input.appDb })");
  });

  it("exposes no injectable override — a caller must not be able to substitute the policy", () => {
    // If this ever fails, check `service:no-context-or-guard-injection` in the JOB-003 contract
    // before "fixing" it: the two guards are saying the same thing from opposite directions.
    expect(LEASING).not.toMatch(/killSwitches\??\s*:\s*KillSwitchPolicyReader/);
  });

  it("reads the policy on every poll, BEFORE the tenant transaction opens", () => {
    // Before, so the frozen authority chain gains no repository selection. Once, so a switch
    // thrown mid-restart cannot flip the verdict between retry attempts.
    const read = LEASING.indexOf("await killSwitches.read()");
    const tenant = LEASING.indexOf("runInTenant(input.appDb");
    expect(read).toBeGreaterThan(-1);
    expect(tenant).toBeGreaterThan(-1);
    expect(read).toBeLessThan(tenant);
    expect(LEASING.match(/await killSwitches\.read\(\)/g) ?? []).toHaveLength(1);
  });

  it("consults the verdict and answers drain — the read is not decorative", () => {
    // A read whose result is never branched on is the same defect as no read at all.
    expect(LEASING).toContain("evaluateKillSwitches({");
    expect(LEASING).toContain("if (killVerdict.killed) {");
    expect(LEASING).toContain('outcome: "drain"');
  });

  it("passes the target's own kind as the provider axis, not a class or a constant", () => {
    // `targetClass` is coarser than `kind` — managed_cloud covers both pooled_gvisor and e2b —
    // so killing one of them via the class would take the other down with it.
    expect(LEASING).toContain("provider: guardedAuthority.currentTarget.kind");
  });

  it("passes the template as UNKNOWN, never as DEFINITELY-NONE", () => {
    // `null` would claim the worker has no pinned template. The control plane cannot know that,
    // and the claim would silently no-op every template switch.
    expect(LEASING).toMatch(/template: undefined,/);
    expect(LEASING).not.toMatch(/template: null,/);
  });

  it("leaves ack and renew unguarded, so in-flight work finishes", () => {
    // Clause 3a stops NEW leases. A kill check on ack or renew would abandon a run that is
    // already executing inside its sandbox. Integration cases 8-9 prove the behaviour; this
    // pins the structure so the behaviour cannot regress silently between suites.
    const ackIndex = LEASING.indexOf("async ack(");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(LEASING.slice(ackIndex)).not.toContain("evaluateKillSwitches");
  });
});

describe("REL-004 Lane C/I7 — the switch and JOB-007 revocation stay separate, both ways", () => {
  // Design D1. Three questions, deliberately not merged: "may this DEVICE work" is JOB-007's
  // generation-fenced identity surgery; "may work be PLACED on this provider" and "may work RUN
  // FROM this template" are policy opinions. Merging them would mean killing one bad template
  // required revoking every target that used it — destroying enrollment state to express a
  // policy. The integration suite proves the forward direction against a live database; these
  // pin the structure in both directions so a later refactor cannot quietly conflate them.

  it("revocation does not read or write the kill-switch policy", () => {
    const code = codeOnly(TARGETS);
    expect(code).not.toContain("kill_switches");
    expect(code).not.toContain("killSwitches");
    expect(code).not.toContain("evaluateKillSwitches");
  });

  it("the kill switch has no revocation vocabulary in its CODE", () => {
    // Its prose is full of the word, and deliberately so — the header exists to explain the
    // separation. What must stay absent is any actual reference.
    for (const forbidden of ["revoke", "deviceGeneration", "device_generation", "executionTargets"]) {
      expect(codeOnly(KILL_SWITCHES), forbidden).not.toContain(forbidden);
    }
  });

  it("`target` is not a kill-switch dimension — it belongs to JOB-007", () => {
    expect(KILL_SWITCHES).toContain('KILL_SWITCH_DIMENSIONS = ["provider", "template"]');
  });
});

describe("REL-004 Lane C — the provider axis is present on BOTH authority branches", () => {
  // `guardedAuthority.currentTarget` comes from `lockWorkerLeaseAuthority` for organization- and
  // owner-scoped targets, and from `recheckPlatformTargetAuthority` for platform ones. If the
  // platform projection were ever narrowed to drop `kind`, the kill switch would read
  // `provider: undefined` there and refuse — so throwing ANY switch would drain every platform
  // worker, whatever the switch actually named. That failure is invisible until a switch exists,
  // which is the worst time to discover it.
  //
  // The integration suite exercises an organization-scoped target. Only this pins the platform
  // branch; a live platform kill-switch case is recorded as a residual in the result doc.
  it("selects the shared placement projection on both paths, and it carries `kind`", () => {
    expect(JOB_CONTROL_REPO).toMatch(/const placementTargetColumns = \{[\s\S]*?kind: executionTargets\.kind,/);
    for (const fn of ["lockWorkerLeaseAuthority", "recheckPlatformTargetAuthority"]) {
      const start = JOB_CONTROL_REPO.indexOf(`async ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      // Bounded window: the next `async ` method starts the following body.
      const rest = JOB_CONTROL_REPO.slice(start + 1);
      const end = rest.indexOf("\n    async ");
      const body = end === -1 ? rest : rest.slice(0, end);
      expect(body, `${fn} must select the shared placement projection`)
        .toContain("tx.select(placementTargetColumns)");
    }
  });
});
