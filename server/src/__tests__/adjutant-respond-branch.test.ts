// Live-QA BUG-2 — Adjutant "respond" branch.
//
// Symptom isolated in live QA: at Assist (autonomy 1) the proactive Adjutant
// WAKES (the thread controller fires) but completes with `tools_called: []` —
// it stays SILENT on a direct founder question instead of conversing. Root
// cause: the Adjutant's action directive had NO "respond to the founder"
// branch (only propose_crew_work / advance_phase / exit-silently), so an open
// founder question that isn't converged work fell through to silence.
//
// Fix: a scoped respond branch — when the founder has asked a question, raised
// a problem, or invited input and no agent has substantively answered yet, the
// Adjutant posts ONE brief helpful reply via post_entry. Idle-silence (the
// locked eval in eval-adjutant-suite.test.ts) is PRESERVED: silence stays
// correct for mid-work / nothing-new.
//
// This file is the focused TDD guard for the respond branch. RED before the
// directive edit in aoa-trigger-prompt.ts, GREEN after. The broader locked
// constraints (propose_crew_work present, convergence guidance, silence
// sanctioned, no forcing clause) are re-asserted here so a future edit can't
// satisfy the respond branch by dropping one of them.

import { describe, expect, it } from "vitest";
import { buildTriggerPrompt } from "../services/internal-agent/aoa-agents/aoa-trigger-prompt.js";

const BASE_INSTRUCTION = "## Persona\nYou are the Adjutant.\n";

function buildAdjutantPrompt() {
  return buildTriggerPrompt({
    instruction: "",
    payload: {
      companyId: "co-1",
      source: "thread.controller",
      threadId: "thr-1",
    },
    agentName: "Adjutant",
    agentRoleKey: "adjutant",
  });
}

describe("Adjutant respond branch (live-QA BUG-2)", () => {
  it("directive instructs responding to an unanswered founder question via post_entry", () => {
    const prompt = buildAdjutantPrompt();
    // The NEW respond guidance: an unanswered founder message that invites a
    // reply must be answered, not treated as "nothing to do".
    expect(prompt).toMatch(/unanswered founder|invited the team|asked a question/i);
    expect(prompt).toMatch(/respond|post_entry/i);
    // post_entry is the tool the Adjutant uses to converse.
    expect(prompt).toContain("post_entry");
  });

  it("scopes the respond branch to the founder's LATEST message — a follow-up after an earlier answer is still unanswered (live-QA follow-up-silence)", () => {
    // Follow-up-silence bug: the first respond-branch guard was thread-global
    // ("no agent has substantively responded yet"), so once ANY agent replied
    // in the thread the Adjutant treated it as handled and went silent on the
    // founder's later follow-up questions. The directive must scope to the
    // founder's most-recent message and explicitly count a follow-up as
    // unanswered — and must NOT carry the old thread-global guard.
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/most recent|latest message/i);
    expect(prompt).toMatch(/follow-up/i);
    expect(prompt).not.toMatch(/no agent has substantively responded yet/i);
  });

  it("still names propose_crew_work as the convergence tool", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).toContain("propose_crew_work");
  });

  it("still conditions convergence on the conversation having converged", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/converged|conversation has converged/i);
  });

  it("PRESERVES idle-silence — silence is still sanctioned as correct", () => {
    const prompt = buildAdjutantPrompt();
    // Idle-silence must remain a first-class outcome (locked eval line 420).
    expect(prompt).toMatch(/return without posting|silence is correct/i);
  });

  it("does NOT re-introduce the 'returning is a bug' forcing clause", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).not.toMatch(/returning without taking the directed action is a bug/i);
  });

  it("instructs the reply to be normal chat — do NOT set sourceInfo.systemNotice", () => {
    // Thread-chat bug: EntryRow renders any entry with sourceInfo.systemNotice
    // as a muted "System notice" divider BEFORE the agent-bubble branch. A
    // conversational Adjutant reply that carries that flag therefore renders as
    // a faint divider, not a chat bubble. The directive must steer the Adjutant
    // to post conversational replies as NORMAL chat (no systemNotice).
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/do NOT set `?sourceInfo\.systemNotice`?/i);
    expect(prompt).toMatch(/normal conversational reply/i);
  });

  it("works with a non-empty instruction bundle too (regression guard)", () => {
    const prompt = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      payload: { companyId: "co-2", source: "sweep.adjutant" },
      agentName: "Adjutant",
      agentRoleKey: "adjutant",
    });
    expect(prompt).toMatch(/unanswered founder|invited the team|asked a question/i);
    expect(prompt).toContain("propose_crew_work");
    expect(prompt).toMatch(/return without posting|silence is correct/i);
  });

  // ── Crew-collaboration retune (Phases 1+2): convene the crew in-thread,
  //    don't auto-scope, don't fake advancing the phase. ──
  it("convenes the relevant crew in-thread via agent.dispatch when the founder wants the team's input", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/convene the relevant crew/i);
    expect(prompt).toContain("agent.dispatch");
    expect(prompt).toMatch(/Scout/);
    expect(prompt).toMatch(/Engineer/);
  });

  it("does NOT auto-scope — propose_crew_work is founder-gated, not a convergence reflex", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/do NOT jump to scoping/i);
    expect(prompt).toMatch(/only when the founder explicitly asks/i);
    expect(prompt).toMatch(/the founder's decision|not your reflex/i);
  });

  it("points to the inline Approve card and never fakes advancing the phase at Manual/Assist", () => {
    const prompt = buildAdjutantPrompt();
    expect(prompt).toMatch(/Approve control|inline scope card/i);
    expect(prompt).toMatch(/never claim you advanced the phase/i);
  });
});
