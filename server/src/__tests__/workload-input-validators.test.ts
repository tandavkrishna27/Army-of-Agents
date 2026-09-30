// BRW-001 — the workload-input validator registry (unit-shaped; runs on Windows, DEC-03).
//
// The hazard this registry closes is GENERAL, not browser-specific: `buildJobEnvelope`
// passes `job.input` through as the workload for ALL THREE frozen workload types, gated
// only by `jobEnvelopeV1Schema.safeParse`. An input that does not satisfy the strict frozen
// workload schema yields a null envelope and therefore no lease, silently.
//
// DECLARED IS NOT ENFORCED. Every frozen workload type must have a DECLARED slot — that is
// what makes "this workload type has no validator" a test failure instead of an invisible
// default. Only `browser_session` is ENFORCED in BRW-001. `batch` and `service` are
// declared `not_enforced` on purpose, so this registry changes the behaviour of the live
// CLI-006 cutover path by exactly zero bytes.
import { describe, expect, it } from "vitest";
import { WORKLOAD_TYPES } from "@armyofagents/worker-protocol";
import {
  WORKLOAD_INPUT_VALIDATORS,
  validateWorkloadInput,
} from "../services/workload-input-validators.js";

describe("BRW-001 — registry exhaustiveness over the frozen workload types", () => {
  // GUARD (mutation-tested): this is the control that makes the registry worth building.
  // A new frozen workload type with no declared slot fails here rather than silently
  // acquiring pass-through behaviour.
  it("declares a slot for every frozen workload type", () => {
    for (const workloadType of WORKLOAD_TYPES) {
      expect(Object.keys(WORKLOAD_INPUT_VALIDATORS)).toContain(workloadType);
    }
  });

  it("declares no slot that is not a frozen workload type", () => {
    for (const declared of Object.keys(WORKLOAD_INPUT_VALIDATORS)) {
      expect(WORKLOAD_TYPES as readonly string[]).toContain(declared);
    }
  });

  it("gives every declared slot an explicit enforced/not_enforced status", () => {
    for (const slot of Object.values(WORKLOAD_INPUT_VALIDATORS)) {
      expect(["enforced", "not_enforced"]).toContain(slot.status);
    }
  });

  it("requires a stated reason on every not_enforced slot", () => {
    for (const [workloadType, slot] of Object.entries(WORKLOAD_INPUT_VALIDATORS)) {
      if (slot.status !== "not_enforced") continue;
      expect(slot.reason, `${workloadType} must say why it is not enforced`).toBeTruthy();
      expect(String(slot.reason).length).toBeGreaterThan(10);
    }
  });
});

describe("BRW-001 — only browser_session is enforced in this ticket", () => {
  it("enforces browser_session", () => {
    expect(WORKLOAD_INPUT_VALIDATORS.browser_session.status).toBe("enforced");
  });

  // GUARD (mutation-tested): a mutant that promotes either of these to `enforced` would
  // change the behaviour of Lane A's live cutover path, which this lane must not touch.
  it("leaves batch not enforced", () => {
    expect(WORKLOAD_INPUT_VALIDATORS.batch.status).toBe("not_enforced");
  });

  it("SVC-001 promoted service to ENFORCED", () => {
    // Was `not_enforced` when BRW-001 declared the slot, with a reason naming SVC-001 as
    // the ticket that would wire it. SVC-001 did. Before the promotion, a service job
    // carrying {"port": 8080} was accepted with 201 and then never leased, silently.
    expect(WORKLOAD_INPUT_VALIDATORS.service.status).toBe("enforced");
  });
});

describe("BRW-001 — a not_enforced slot passes input through UNCHANGED", () => {
  // This is the whole safety argument for declaring batch and service now. If a
  // not_enforced slot altered, defaulted, or rejected anything, this registry would be a
  // live change to the cutover path rather than an inert declaration.
  const untouchedInputs: Array<[string, Record<string, unknown>]> = [
    ["the empty object the live task_run path actually sends", {}],
    ["a populated batch workload", { command: "run", args: ["--x"], stdinArtifactId: null, maxRuntimeSeconds: 600 }],
    ["a shape no schema would accept", { nonsense: true, nested: { deep: [1, 2, 3] } }],
  ];

  for (const [name, raw] of untouchedInputs) {
    it(`returns ${name} byte-identically for batch`, () => {
      const result = validateWorkloadInput("batch", raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(raw);
      expect(JSON.stringify(result.value)).toBe(JSON.stringify(raw));
    });

    it(`REFUSES ${name} for service now that SVC-001 enforces it`, () => {
      // The inverse of the assertion this test used to make. These three fixtures are
      // shapes the frozen serviceWorkloadV1Schema does not accept, so passing them
      // through byte-identically is exactly what produced a null envelope and a job that
      // never leased. Refusing them at submit is the fix.
      expect(validateWorkloadInput("service", raw).ok).toBe(false);
    });
  }
});

describe("BRW-001 — the enforced browser_session slot actually validates", () => {
  it("normalises a valid browser config", () => {
    const result = validateWorkloadInput("browser_session", { locale: "en-GB" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.locale).toBe("en-GB");
    expect(result.value.maxSessionSeconds).toBeGreaterThan(0);
  });

  it("rejects an invalid browser config with a typed reason", () => {
    const result = validateWorkloadInput("browser_session", { engine: "firefox" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBeTruthy();
  });

  it("rejects the empty object that batch passes through", () => {
    // The same input is inert for batch and normalised for browser — proof the registry
    // dispatches per workload type rather than applying one policy to everything.
    const browser = validateWorkloadInput("browser_session", {});
    const batch = validateWorkloadInput("batch", {});
    expect(browser.ok).toBe(true);
    expect(batch.ok).toBe(true);
    if (!browser.ok || !batch.ok) return;
    expect(browser.value).not.toEqual({});
    expect(batch.value).toEqual({});
  });
});

describe("BRW-001 — an unknown workload type fails closed", () => {
  it("refuses a workload type with no declared slot", () => {
    const result = validateWorkloadInput("not_a_workload_type", {});
    expect(result.ok).toBe(false);
  });
});
