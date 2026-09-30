/**
 * Phase 0 / Task 0.2 — persona-bundle coherence.
 *
 * The crew onboarding bundles drifted from what the agents actually do at
 * runtime. This test pins the bundle text to the runtime role so the two can't
 * silently diverge again:
 *
 *   - Adjutant: the runtime directive (ensure-adjutant.ts) calls it "the
 *     discuss-phase director" that drives the conversation, proposes work via
 *     propose_crew_work, and advances the phase. Its bundle used to describe a
 *     "quiet observer" that "never interrupts" and "runs every ~4h via sweep" —
 *     directly contradictory. Assert the contradiction is gone and the director
 *     identity is present.
 *   - Engineer: its bundle said tasks are created by "the Dispatcher", a role
 *     retired in Task 2.7. Assert that reference is gone (tasks come from the
 *     founder / the Adjutant's propose_crew_work chokepoint).
 *
 * Text-only contract — no tool list, allowlist, adapter, or behavior is asserted
 * here (those live in the ensure-* and crew-persona-bundles suites).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "onboarding-assets");

describe("persona bundle coherence (Task 0.2)", () => {
  it("Adjutant SOUL matches its runtime director role", () => {
    const soul = readFileSync(join(root, "adjutant", "SOUL.md"), "utf8").toLowerCase();
    expect(soul).not.toMatch(/quiet observer|never interrupt/);
    expect(soul).toMatch(/discuss|director|orchestrat/);
  });

  it("Engineer bundle does not reference the retired Dispatcher role", () => {
    const soul = readFileSync(join(root, "engineer", "SOUL.md"), "utf8").toLowerCase();
    expect(soul).not.toMatch(/dispatcher/);
  });

  it("Adjutant HEARTBEAT no longer blanket-instructs systemNotice on every post_entry", () => {
    // Thread-chat bug root cause: HEARTBEAT.md told the Adjutant to set
    // sourceInfo.systemNotice on EVERY post_entry. Now that the Adjutant
    // converses, that flag made its chat replies render as muted "System
    // notice" dividers instead of chat bubbles. The unconditional rule must be
    // gone — systemNotice is reserved for rare procedural notices only.
    const heartbeat = readFileSync(join(root, "adjutant", "HEARTBEAT.md"), "utf8");
    // No "If you call post_entry, set ... systemNotice: true" unconditional rule.
    expect(heartbeat).not.toMatch(/If you call `?post_entry`?,?\s*set[^.]*systemNotice/i);
    // And the new guidance: conversational replies are normal chat, no systemNotice.
    expect(heartbeat).toMatch(/do NOT set `?sourceInfo\.systemNotice`?/i);
    expect(heartbeat).toMatch(/normal chat/i);
    // systemNotice is now reserved for a rare procedural notice.
    expect(heartbeat).toMatch(/procedural notice|never for conversation/i);
  });
});
