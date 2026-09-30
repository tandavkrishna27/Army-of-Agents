// BRW-004 slice (c) — the guest's mirrored vocabulary, bound to the FROZEN source.
//
// ★★ WHY THIS TEST EXISTS. `approval.ts` mirrors two things it does not import: the six
// permission decisions, and the subset of `permissionRuntimeDecisionRequestV1`'s fields the
// guest is the authority for. Mirroring is deliberate — the runtime is staged into a sandbox
// as bare files with no node_modules, so it must stay dependency-free — but an unchecked
// mirror is a second implementation of a frozen contract, and this programme's record on
// second implementations is that they diverge silently.
//
// So the mirror is bound to the frozen SOURCE TEXT, the same way `runtime-dependency.test.ts`
// binds the staged runner's assumptions to the image's Dockerfile.
//
// ★ THE DECISION-SET CASE IS THE LOAD-BEARING ONE. `classifyBrowserPermissionDecision`
// refuses anything it does not recognise, which is the right default — but it means a SEVENTH
// permission decision added upstream would be swallowed as `unrecognised_decision` with no
// signal at all. That is fail-closed and therefore safe, but it is also invisible, and an
// invisible divergence is how "we support the protocol" stops being true without anyone
// noticing. This test makes the addition RED so a human has to decide what it means for a
// browser prompt.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyBrowserPermissionDecision, buildApprovalIntent } from "../approval.js";

const eventsSrc = readFileSync(
  fileURLToPath(new URL("../../../worker-protocol/src/events.ts", import.meta.url)),
  "utf8",
);
const transportSrc = readFileSync(
  fileURLToPath(new URL("../../../worker-protocol/src/transport.ts", import.meta.url)),
  "utf8",
);

/** Pull a `const NAME = [...] as const;` string-array literal out of the frozen source. */
function frozenStringArray(src: string, name: string): string[] {
  const re = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(src);
  if (!m) throw new Error(`cannot find ${name} in the frozen source — the mirror has nothing to bind to`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("BRW-004 — the guest's permission-decision mirror matches the frozen enum", () => {
  it("finds the frozen decision list at all (a parse failure must not pass vacuously)", () => {
    // Without this the regex could silently match nothing and every case below would iterate
    // an empty array — green, and proving nothing. This is the same shape as the guards this
    // programme keeps finding: a check that runs over no input.
    expect(frozenStringArray(transportSrc, "PERMISSION_DECISIONS").length).toBeGreaterThan(0);
  });

  it("every frozen permission decision is CLASSIFIED, not defaulted", () => {
    const frozen = frozenStringArray(transportSrc, "PERMISSION_DECISIONS");
    for (const decision of frozen) {
      const out = classifyBrowserPermissionDecision(decision);
      if (out.ok) {
        // Only allow_once may proceed (D5).
        expect(decision).toBe("allow_once");
        continue;
      }
      // A frozen decision reaching the `default` branch means the mirror is out of date.
      expect(
        out.reason,
        `frozen permission decision "${decision}" fell through to the unrecognised default — the guest's mirror is stale`,
      ).not.toBe("unrecognised_decision");
    }
  });

  it("exactly one frozen decision proceeds", () => {
    const frozen = frozenStringArray(transportSrc, "PERMISSION_DECISIONS");
    const proceeding = frozen.filter((d) => classifyBrowserPermissionDecision(d).ok);
    expect(proceeding).toEqual(["allow_once"]);
  });
});

describe("BRW-004 — every intent field is a field of the frozen permission request", () => {
  it("finds the frozen permission-request schema (not a vacuous match)", () => {
    expect(eventsSrc).toContain("permissionRuntimeDecisionRequestV1Schema");
  });

  it.each(["title", "summary", "networkTarget", "riskClass"])(
    "%s is declared on the frozen request",
    (field) => {
      // The guest may only populate fields the frozen request actually carries. A field that
      // exists only here would be dropped — or rejected by `.strict()` — at completion time,
      // and the session would fail as an unparseable request rather than as a refusal.
      expect(eventsSrc).toMatch(new RegExp(`\\b${field}\\s*:`));
    },
  );

  it("the intent carries ONLY fields the frozen request has, plus the guest's own action tag", () => {
    const intent = buildApprovalIntent({
      action: "navigate",
      title: "t",
      summary: "s",
      networkTarget: "https://x.test",
      riskClass: "network_egress",
    });
    for (const key of Object.keys(intent)) {
      if (key === "action") continue; // the guest's own routing tag; never sent on the wire
      expect(eventsSrc, `intent field "${key}" has no counterpart on the frozen request`).toMatch(
        new RegExp(`\\b${key}\\s*:`),
      );
    }
  });

  it("★ the guest does NOT mint requestDigest or sourceRevision", () => {
    // It cannot: it has no canonicalizer and no revision counter. A digest the control plane
    // would recompute differently fails as a request that never verifies — which reads as a
    // hung session, not as a bug. The worker-side sequencer completes those fields.
    const intent = buildApprovalIntent({ action: "navigate", title: "t", riskClass: "r" });
    expect(Object.keys(intent)).not.toContain("requestDigest");
    expect(Object.keys(intent)).not.toContain("sourceRevision");
    expect(Object.keys(intent)).not.toContain("nonce");
  });
});
