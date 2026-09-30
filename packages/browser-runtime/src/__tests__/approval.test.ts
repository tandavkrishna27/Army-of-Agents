// BRW-004 slice (c) — the in-guest approval seam (unit-shaped; no browser needed).
//
// ★★ EVERY FAIL-CLOSED CLAUSE HERE HAS A POSITIVE CONTROL IN THE SAME DESCRIBE BLOCK, and
// that is not ceremony. "Denial/timeout fails closed" is the exact shape that ships as a dead
// lever: a guard that cannot fire looks identical to one that always passes, because in both
// cases the action does not happen and the test is green. The only way to tell them apart is
// to show the SAME action going through when the decision is favourable.
//
// The driver is injected, so "the navigation never happened" is an observed absence from a
// call log rather than an inference from a return value.
import { describe, expect, it } from "vitest";
import {
  awaitApprovalDecision,
  buildApprovalIntent,
  classifyBrowserPermissionDecision,
  inertRefusingResolver,
  navigationTarget,
  type ApprovalResolver,
  type BrowserPermissionDecision,
} from "../approval.js";
import {
  runBrowserSession,
  type BrowserDriver,
  type SessionConfig,
  type SessionDeps,
} from "../run-session.js";

const BASE: SessionConfig = {
  downloadRoot: "/job/downloads",
  steps: [{ action: "navigate", url: "https://site.test/page" }],
  launch: { headless: true, chromiumSandbox: true, args: [] },
};

function recordingDriver(downloads: string[] = []) {
  const calls: string[] = [];
  const driver: BrowserDriver = {
    async launch() {
      calls.push("launch");
      return {
        async navigate(url: string) {
          calls.push(`navigate(${url})`);
        },
        async collectDownloads() {
          calls.push("collectDownloads");
          return downloads.map((name) => ({
            suggestedFilename: () => name,
            async saveAs(target: string) {
              calls.push(`saveAs(${target})`);
            },
          }));
        },
        async close() {
          calls.push("close");
        },
      };
    },
  };
  return { driver, calls };
}

const ports = () => {
  let call = 0;
  return async () => (call++, [] as number[]);
};
const resolvePath = (root: string, name: string) => ({ ok: true as const, path: `${root}/${name}` });

/** Deps with an injected resolver and an immediate timer, so no test waits on a real clock. */
function deps(driver: BrowserDriver, requestApproval?: ApprovalResolver, delayMs?: number): SessionDeps {
  return {
    driver,
    measurePorts: ports(),
    resolvePath,
    env: {},
    requestApproval,
    // Resolves on the next microtask by default, so a resolver that never settles loses the
    // race deterministically. `delayMs` is honoured only to prove the deadline is used at all.
    delay: async () => {
      if (delayMs !== undefined) await new Promise((r) => setTimeout(r, delayMs));
    },
  };
}

const grant = (d: BrowserPermissionDecision): ApprovalResolver => async () => d;
/** A resolver that NEVER settles, so only the deadline can decide. */
const never: ApprovalResolver = () => new Promise<BrowserPermissionDecision>(() => {});

describe("BRW-004 D5 — a browser prompt accepts allow_once and nothing else", () => {
  it("allow_once proceeds", () => {
    expect(classifyBrowserPermissionDecision("allow_once")).toEqual({ ok: true, decision: "allow_once" });
  });

  // ★ THE WIDENING'S CLOSURE. Terrain §3b: browser prompts are un-auto-approvable today only
  // because `extractScope` leaves networkTarget null. Slice (c) populates it, so allow_always
  // becomes reachable — and a standing grant to navigate a domain is a different product
  // decision. These two cases are what stop it arriving as a side effect.
  it.each(["allow_run", "allow_always"] as const)("%s is refused as a standing grant", (d) => {
    const out = classifyBrowserPermissionDecision(d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("standing_grant_refused");
  });

  it.each([
    ["deny", "denied"],
    ["expired", "timed_out"],
    ["cancelled", "cancelled"],
  ] as const)("%s refuses with reason %s", (decision, reason) => {
    const out = classifyBrowserPermissionDecision(decision);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(reason);
  });

  // A seventh permission decision added by a future protocol version must not silently pass.
  it("an unrecognised decision fails closed", () => {
    const out = classifyBrowserPermissionDecision("allow_forever_probably_fine");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unrecognised_decision");
  });

  it("the resolver slice (c) ships refuses, because no delivery hop exists (JOB-015)", async () => {
    await expect(inertRefusingResolver(buildApprovalIntent({ action: "navigate", title: "t", riskClass: "r" }))).resolves.toBe("deny");
  });
});

describe("BRW-004 — awaitApprovalDecision blocks, and every refusal path is observable", () => {
  const intent = buildApprovalIntent({
    action: "navigate",
    title: "Navigate",
    networkTarget: "https://site.test",
    riskClass: "network_egress",
  });

  it("times out when no decision arrives", async () => {
    const out = await awaitApprovalDecision({ resolver: never, intent, timeoutMs: 5, delay: async () => {} });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("timed_out");
  });

  // ★ POSITIVE CONTROL for the timeout: the SAME call with a decision that beats the deadline
  // proceeds. Without this, "timed out" and "the resolver is never consulted" are the same test.
  it("POSITIVE CONTROL — a decision that beats the deadline proceeds through the same call", async () => {
    const out = await awaitApprovalDecision({
      resolver: grant("allow_once"),
      intent,
      timeoutMs: 5,
      // The deadline is made to lose deterministically rather than by racing a real timer.
      delay: () => new Promise<void>(() => {}),
    });
    expect(out).toEqual({ ok: true, decision: "allow_once" });
  });

  it("a resolver that throws is a refusal, not a pass", async () => {
    const out = await awaitApprovalDecision({
      resolver: async () => {
        throw new Error("channel down");
      },
      intent,
      timeoutMs: 5,
      delay: () => new Promise<void>(() => {}),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("resolver_failed");
    expect(out.detail).toContain("channel down");
  });

  it("a resolver returning the literal string \"timed_out\" cannot impersonate the deadline", async () => {
    // The sentinel is an object, so identity — not spelling — decides. A string sentinel would
    // let a compromised resolver produce a refusal reason it did not earn.
    const out = await awaitApprovalDecision({
      resolver: async () => "timed_out" as unknown as BrowserPermissionDecision,
      intent,
      timeoutMs: 5,
      delay: () => new Promise<void>(() => {}),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unrecognised_decision");
  });
});

describe("BRW-004 — the navigation gate runs BEFORE the driver is asked to navigate", () => {
  it("refuses the navigation and never calls the driver", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession({ ...BASE, requireApproval: true }, deps(driver, grant("deny")));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("approval_refused");
    expect(result.detail).toContain("denied");
    // The whole point: the action did not happen, observed rather than inferred.
    expect(calls).not.toContain("navigate(https://site.test/page)");
    // ...and the browser was still closed, so a refusal does not leak a live context.
    expect(calls).toContain("close");
  });

  // ★ POSITIVE CONTROL — the same action, the same config, a favourable decision, and the
  // navigation DOES reach the driver. This is the test that distinguishes a live gate from a
  // browser that never navigated for some unrelated reason.
  it("POSITIVE CONTROL — an allow_once decision lets the same navigation through", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession({ ...BASE, requireApproval: true }, deps(driver, grant("allow_once")));
    expect(result.ok).toBe(true);
    expect(calls).toContain("navigate(https://site.test/page)");
  });

  it("a standing grant does NOT let the navigation through (D5, end to end)", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession({ ...BASE, requireApproval: true }, deps(driver, grant("allow_always")));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("standing_grant_refused");
    expect(calls).not.toContain("navigate(https://site.test/page)");
  });

  // ★★ THE MISCONFIGURATION CLAUSE. Demanding the gate and forgetting the resolver must refuse.
  // The tempting alternative — "no resolver, so carry on" — makes the entire approval story a
  // dead lever the first time a composition root drops a dependency, and it looks identical to
  // a working gate: green tests, no approvals, no error.
  it("requireApproval with NO resolver injected fails closed", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession({ ...BASE, requireApproval: true }, deps(driver, undefined));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("approval_refused");
    expect(result.detail).toContain("no resolver was injected");
    expect(calls).not.toContain("navigate(https://site.test/page)");
  });

  // ★ POSITIVE CONTROL for the default: with the gate OFF, the session behaves exactly as it
  // did before slice (c). Proves the new clause is genuinely opt-in and BRW-002's sessions are
  // not silently broken by it.
  it("POSITIVE CONTROL — with the gate off, no resolver is needed and navigation proceeds", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession(BASE, deps(driver, undefined));
    expect(result.ok).toBe(true);
    expect(calls).toContain("navigate(https://site.test/page)");
  });

  it("the timeout refuses the navigation when no decision ever arrives", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession(
      { ...BASE, requireApproval: true, approvalTimeoutMs: 1 },
      deps(driver, never),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("timed_out");
    expect(calls).not.toContain("navigate(https://site.test/page)");
  });
});

describe("BRW-004 — the download gate refuses BEFORE saveAs writes anything", () => {
  it("a refused download is never written", async () => {
    const { driver, calls } = recordingDriver(["report.pdf"]);
    const result = await runBrowserSession(
      { ...BASE, steps: [], requireApproval: true },
      deps(driver, grant("deny")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("approval_refused");
    expect(calls.some((c) => c.startsWith("saveAs("))).toBe(false);
  });

  // ★ POSITIVE CONTROL — the same download, granted, IS written through the same code path.
  it("POSITIVE CONTROL — a granted download is written", async () => {
    const { driver, calls } = recordingDriver(["report.pdf"]);
    const result = await runBrowserSession(
      { ...BASE, steps: [], requireApproval: true },
      deps(driver, grant("allow_once")),
    );
    expect(result.ok).toBe(true);
    expect(calls).toContain("saveAs(/job/downloads/report.pdf)");
  });
});

describe("BRW-004 — the intent carries a scope the control plane can act on", () => {
  it("a navigation's target is the destination ORIGIN, not the full URL", () => {
    // Origin, because an approval scoped to a full path would have to be re-asked for every
    // link on the same site, and a trust rule matches on the target field verbatim.
    expect(navigationTarget("https://site.test/a/b?c=d#e")).toBe("https://site.test");
  });

  it("an unparseable URL yields a null target rather than a guessed one", () => {
    // A scope this code cannot name must not be invented; the caller treats null as
    // "unscopable", never as a wildcard.
    expect(navigationTarget("not a url")).toBeNull();
  });

  it("every bounded field is truncated to its frozen limit", () => {
    const intent = buildApprovalIntent({
      action: "navigate",
      title: "t".repeat(600),
      summary: "s".repeat(5000),
      networkTarget: "n".repeat(1200),
      riskClass: "r".repeat(200),
    });
    expect(intent.title).toHaveLength(500);
    expect(intent.summary).toHaveLength(4000);
    expect(intent.networkTarget).toHaveLength(1000);
    expect(intent.riskClass).toHaveLength(100);
  });

  it("a null summary and a null target stay null", () => {
    const intent = buildApprovalIntent({ action: "download", title: "t", riskClass: "download" });
    expect(intent.summary).toBeNull();
    expect(intent.networkTarget).toBeNull();
  });
});

describe("BRW-004 — a late rejection is harmless, and that was MEASURED, not assumed", () => {
  // ★★★ THE MOST USEFUL THING IN THIS FILE IS THE TEST THAT IS NOT HERE.
  //
  // An earlier version of `awaitApprovalDecision` carried a `void Promise.allSettled([...])` guard
  // and a test for it, on the reasoning that `Promise.race` settles once, so a resolver rejecting
  // AFTER the deadline had won would leave a rejected promise with nothing listening — fatal under
  // `--unhandled-rejections=strict`, and this code runs as the sandbox's entrypoint process.
  //
  // The mutation deleting that guard SURVIVED. A surviving mutant is a question, and the question
  // had two possible answers: the test cannot see the property, or the guard is unnecessary. The
  // FIRST attempt at the test listened for `process.on("unhandledRejection")` inside vitest, which
  // installs its own handler — so it genuinely could not see it, and the second attempt moved to a
  // real strict-mode child process. The mutant survived THAT too, and a direct experiment settled
  // it: `Promise.race` calls `.then` on every element, so the loser's rejection is already
  // observed and a strict-mode process is not killed by it.
  //
  // So the guard was removed. Shipping a defensive line beside a test that can never fail is a
  // FALSE CLAIM OF ENFORCEMENT, which this programme treats as worse than a missing check — and it
  // would have read, to any later reader, as a hazard someone had handled.
  //
  // What remains is the property that IS real and IS falsifiable: a rejection that WINS the race
  // must become `resolver_failed` rather than being swallowed.
  it("a resolver that rejects FIRST becomes resolver_failed, not a silent pass", async () => {
    const out = await awaitApprovalDecision({
      resolver: async () => {
        throw new Error("channel down");
      },
      intent: buildApprovalIntent({ action: "navigate", title: "t", riskClass: "r" }),
      timeoutMs: 5,
      delay: () => new Promise<void>(() => {}),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("resolver_failed");
    expect(out.detail).toContain("channel down");
  });

  it("a resolver that rejects LATE leaves the deadline's refusal untouched", async () => {
    // Not a guard test — an outcome test. The late rejection must not turn a `timed_out` refusal
    // into something else, which is the only observable the guest actually owns here.
    const out = await awaitApprovalDecision({
      resolver: () =>
        new Promise<BrowserPermissionDecision>((_r, reject) => {
          setTimeout(() => reject(new Error("late collapse")), 5);
        }),
      intent: buildApprovalIntent({ action: "navigate", title: "t", riskClass: "r" }),
      timeoutMs: 1,
      delay: async () => {},
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("timed_out");
    await new Promise((r) => setTimeout(r, 20));
  });
});
