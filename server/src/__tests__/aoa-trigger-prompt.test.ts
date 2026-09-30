// T1.2 — pure-function tests for buildTriggerPrompt (role-aware crew
// trigger prompt). Pins the per-role action directive table in code so
// a future edit can't quietly regress (e.g. switching Scribe's directive
// to "post_entry" and breaking extraction silently).
//
// Codex F1: prompt regression broke Maker → no posts. Codex F2: Scribe
// regression risk if the prompt's directive doesn't match its tool. Codex
// F6: dispatcher must pass wakeup.source through (covered in dispatcher
// integration tests; here we just assert the prompt CONTAINS whatever
// source is passed). Codex F7: role lookup is case-insensitive on the
// runtimeConfig.aoa.role key, not agent.name.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTriggerPrompt } from "../services/internal-agent/aoa-agents/aoa-trigger-prompt.js";

// Task 0.4 — ensure-adjutant instruction text (read raw so changes to
// the module don't require re-importing; the string constant is exported via
// the seedCrewAgent call, not directly, so read the source file directly).
const ENSURE_ADJUTANT_SRC = readFileSync(
  join(__dirname, "../services/internal-agent/aoa-agents/ensure-adjutant.ts"),
  "utf8"
);

const BASE_INSTRUCTION = "## Persona\nYou are a focused, terse agent.\n";

describe("buildTriggerPrompt (T1.2)", () => {
  describe("role-specific action directive", () => {
    it("scribe → submit_extracted_items directive (NOT post_entry)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "outbox", entryId: "e1" },
        agentName: "Scribe",
        agentRoleKey: "scribe",
      });
      expect(out).toContain("submit_extracted_items");
      // CRITICAL REGRESSION GUARD: must NOT tell Scribe to post_entry.
      // Doing so would break extraction (Scribe's allowlist doesn't have
      // post_entry; even if it did, calling it would skip extraction).
      expect(out).not.toContain("post_entry");
    });

    it("maker → post_entry directive with parentEntryId reference", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention", entryId: "e1", mention: "@Maker" },
        agentName: "Maker",
        agentRoleKey: "maker",
      });
      expect(out).toContain("post_entry");
      expect(out).toContain("parentEntryId");
    });

    it("adjutant → propose_crew_work at convergence (Task 0.4)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "sweep.adjutant" },
        agentName: "Adjutant",
        agentRoleKey: "adjutant",
      });
      // Must mention the new propose_crew_work tool and scope-proposing
      expect(out).toContain("propose_crew_work");
      // advance_phase is still valid for phase transitions
      expect(out).toContain("advance_phase");
      // Silence must be explicitly correct (not a bug)
      expect(out).toMatch(/silence is correct/i);
    });

    it("adjutant → does NOT carry the 'returning is a bug' forcing clause (Task 0.4)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "sweep.adjutant" },
        agentName: "Adjutant",
        agentRoleKey: "adjutant",
      });
      // The old forcing clause said returning without the directed action is a bug.
      // This must be removed — silence is the correct behavior when idle.
      expect(out).not.toMatch(/returning without taking the directed action is a bug/i);
    });

    it("adjutant → conversational replies are normal chat (no sourceInfo.systemNotice)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "sweep.adjutant" },
        agentName: "Adjutant",
        agentRoleKey: "adjutant",
      });
      // Thread-chat bug: an Adjutant reply carrying sourceInfo.systemNotice
      // renders as a muted "System notice" divider, not a chat bubble. The
      // respond directive must tell it to post as a normal conversational reply.
      expect(out).toMatch(/do NOT set `?sourceInfo\.systemNotice`?/i);
      expect(out).toMatch(/normal conversational reply/i);
    });

    it("router → attach_to_thread or spin_off_thread (NOT post_entry)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "phase-advance" },
        agentName: "Router",
        agentRoleKey: "router",
      });
      expect(out).toContain("attach_to_thread");
      expect(out).toContain("spin_off_thread");
      // post_entry is NOT in the Navigator allowlist — must not be promised here
      expect(out).not.toContain("post_entry");
    });

    it("planner → post_entry with plan", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "phase-advance" },
        agentName: "Planner",
        agentRoleKey: "planner",
      });
      expect(out).toContain("post_entry");
      expect(out).toContain("plan");
    });

    it("dispatcher → create_task + assign_task + add_task_dependency", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "phase-advance" },
        agentName: "Dispatcher",
        agentRoleKey: "dispatcher",
      });
      expect(out).toContain("create_task");
      expect(out).toContain("assign_task");
      expect(out).toContain("add_task_dependency");
    });

    it("memory_keeper → suggest_memory (propose-only)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "event" },
        agentName: "Memory Keeper",
        agentRoleKey: "memory_keeper",
      });
      expect(out).toContain("suggest_memory");
      expect(out).toContain("propose-only");
    });

    it("chronicler → thread.updateSummary directive (NOT the generic directive)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "sweep" },
        agentName: "Chronicler",
        agentRoleKey: "chronicler",
      });
      // Concrete chronicler directive (Codex P1 #5) — must update the thread summary
      expect(out).toContain("thread.updateSummary");
      expect(out).toContain("get_thread_summary");
      // Must NOT fall back to the weak generic directive
      expect(out).not.toContain("use the tools in your allowlist");
      // Chronicler must never post_entry
      expect(out).toMatch(/Never post_entry/i);
    });

    it("commander → post_entry with synthesis", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention", mention: "@Commander" },
        agentName: "Commander",
        agentRoleKey: "commander",
      });
      expect(out).toContain("post_entry");
      expect(out).toContain("synthesis");
    });

    it("reviewer → critique then post_entry, advise-only (no mutation)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention", mention: "@Reviewer" },
        agentName: "Reviewer",
        agentRoleKey: "reviewer",
      });
      expect(out).toMatch(/critique/i);
      expect(out).toContain("post_entry");
      // advise-only: must tell the reviewer NOT to approve / create tasks / mutate
      expect(out).toMatch(/do NOT\s+approve/i);
    });

    it("unknown role → generic directive (no crash)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention" },
        agentName: "MysteryAgent",
        agentRoleKey: "mystery",
      });
      expect(out).toContain("use the tools in your allowlist");
    });

    it("case-insensitive role lookup (per codex F7 — runtimeConfig may have mixed case)", () => {
      const lower = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "outbox" },
        agentName: "X", agentRoleKey: "scribe",
      });
      const upper = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "outbox" },
        agentName: "X", agentRoleKey: "SCRIBE",
      });
      const mixed = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "outbox" },
        agentName: "X", agentRoleKey: "Scribe",
      });
      // All three should resolve to the same directive
      expect(lower).toContain("submit_extracted_items");
      expect(upper).toContain("submit_extracted_items");
      expect(mixed).toContain("submit_extracted_items");
    });
  });

  describe("tool call visibility", () => {
    it("makes MCP tool names and final stdout visibility explicit", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread.participation", threadId: "thr-1", mention: "@Adjutant" },
        agentName: "Adjutant",
        agentRoleKey: "adjutant",
      });

      expect(out).toContain("mcp__aoa__foo");
      expect(out).toMatch(/Final text\/stdout is internal/i);
      expect(out).toMatch(/not shown in the thread/i);
    });

    it("uses routed payload role for the directive when display/config role is renamed", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: {
          companyId: "co",
          source: "thread.participation",
          threadId: "thr-1",
          mention: "@Adjutant",
          role: "adjutant",
        },
        agentName: "AoA Adjutant",
        agentRoleKey: "aoa_adjutant",
      });

      expect(out).toContain("founder");
      expect(out).toContain("call `post_entry` exactly once");
      expect(out).not.toContain("use the tools in your allowlist appropriate to this trigger");
    });
  });

  describe("trigger context block", () => {
    it("includes trigger source verbatim (codex F6 dispatcher pass-through)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention" },
        agentName: "Maker", agentRoleKey: "maker",
      });
      expect(out).toContain("Trigger source: thread_mention");
    });

    it("includes threadId, entryId, mention when present", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: {
          companyId: "co", source: "thread_mention",
          threadId: "thr-1", entryId: "entry-42", mention: "@Maker",
        },
        agentName: "Maker", agentRoleKey: "maker",
      });
      expect(out).toContain("Thread: thr-1");
      expect(out).toContain("Inviting entry: entry-42");
      expect(out).toContain("Mention: @Maker");
    });

    it("omits absent fields (no 'undefined' lines confusing the LLM)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "sweep" }, // no threadId, no entry, no mention
        agentName: "Adjutant", agentRoleKey: "adjutant",
      });
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("Thread:");
      expect(out).not.toContain("Inviting entry:");
      expect(out).not.toContain("Mention:");
    });

    it("includes routed role when present", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "phase-advance", role: "dispatcher" },
        agentName: "Dispatcher", agentRoleKey: "dispatcher",
      });
      expect(out).toContain("Routed role: dispatcher");
    });
  });

  describe("structure", () => {
    it("instruction bundle precedes the trigger context block", () => {
      const out = buildTriggerPrompt({
        instruction: "## INSTRUCTION_MARKER\n",
        payload: { companyId: "co", source: "outbox" },
        agentName: "Scribe", agentRoleKey: "scribe",
      });
      const instructionIdx = out.indexOf("INSTRUCTION_MARKER");
      const wakeupIdx = out.indexOf("## This wakeup");
      expect(instructionIdx).toBeGreaterThanOrEqual(0);
      expect(wakeupIdx).toBeGreaterThan(instructionIdx);
    });

    it("agent name appears in the directive sentence", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention" },
        agentName: "Maker", agentRoleKey: "maker",
      });
      expect(out).toContain("You are Maker");
    });

    it("escape hatch for uncertainty (surfaces feedback to the human)", () => {
      const out = buildTriggerPrompt({
        instruction: BASE_INSTRUCTION,
        payload: { companyId: "co", source: "thread_mention" },
        agentName: "Maker", agentRoleKey: "maker",
      });
      // Match the actual prompt language: "surfaces feedback to the human"
      // (was "ask the human" but that copy got reworded to not mention
      // post_entry by name — the Scribe regression test forbids that)
      expect(out).toMatch(/surfaces? feedback to the human/i);
    });
  });
});

// Task 1.7 / routing-card redesign — inbox-routing trigger prompt.
// The Navigator now decides over the raw inbound content (rendered under
// "Inbound content:") and fetches routing cards at runtime via list_thread_cards;
// candidateThreadIds / distances / gap are no longer rendered (Codex P1 #1).
describe("buildTriggerPrompt (T1.7) — inbox.routing_ambiguous", () => {
  it("renders inboxItemId and the inbound content", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: {
        companyId: "co-1",
        source: "inbox.routing_ambiguous",
        inboxItemId: "inbox-1",
        inboundContent: "Customer wants SSO before the pilot.",
      },
    });
    // Inbox item ID must appear
    expect(out).toContain("inbox-1");
    // The inbound content must be rendered under its labelled line
    expect(out).toContain("Inbound content:");
    expect(out).toContain("Customer wants SSO before the pilot.");
  });

  it("truncates very long inbound content to keep the prompt bounded", () => {
    const long = "x".repeat(5000);
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: {
        companyId: "co-1",
        source: "inbox.routing_ambiguous",
        inboxItemId: "inbox-long",
        inboundContent: long,
      },
    });
    expect(out).toContain("Inbound content:");
    // Capped at 4000 chars with a truncation marker — the full 5000-char run must not survive.
    expect(out).toContain("[truncated]");
    expect(out).not.toContain(long);
  });

  it("uses INBOX_ROUTING_DIRECTIVE — names list_thread_cards / promote_inbox_to_thread / defer_inbox_to_human", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: {
        companyId: "co-1",
        source: "inbox.routing_ambiguous",
        inboxItemId: "inbox-1",
        inboundContent: "Some inbound material.",
      },
    });
    // Distinctive phrase from INBOX_ROUTING_DIRECTIVE
    expect(out).toContain("An inbound item needs routing");
    // The three card/promote/defer tools the Navigator must choose between
    expect(out).toContain("list_thread_cards");
    expect(out).toContain("promote_inbox_to_thread");
    expect(out).toContain("defer_inbox_to_human");
    // Old candidate-thread framing must not appear
    expect(out).not.toContain("Candidate threads:");
    expect(out).not.toContain("Ambiguity gap:");
    // And it must steer away from spin_off_thread for inbox items
    expect(out).toContain("Do NOT call spin_off_thread for inbox items");
  });

  it("guard case: no inboundContent still renders without throwing", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: {
        companyId: "co-1",
        source: "inbox.routing_ambiguous",
        inboxItemId: "inbox-2",
      },
    });
    // Must still contain the inbox item ID
    expect(out).toContain("inbox-2");
    // Must not crash or produce "undefined"
    expect(out).not.toContain("undefined");
    // The inbound-content line should be absent when no content was supplied
    expect(out).not.toContain("Inbound content:");
  });

  it("non-inbox navigator wakeup still uses the role-table directive (regression guard)", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: { companyId: "co", source: "thread_mention", mention: "@Navigator" },
    });
    // Role-table directive for 'navigator' must appear
    expect(out).toContain("attach_to_thread");
    // But the inbox-routing opener must NOT appear for a non-inbox trigger
    expect(out).not.toContain("An inbound item needs routing");
  });
});

// Spec B Task 5 — task-execution trigger directive.
// When the dispatcher wakes a crew agent with an `issueId` (a task assignment,
// not a thread), the prompt must steer the agent to the TASK tool surface
// (get_task / post_task_comment / attach_task_artifact / set_task_status) and
// AWAY from thread/post_entry tools. Inbox routing still takes precedence.
describe("buildTriggerPrompt (Spec B Task 5) — task execution (issueId)", () => {
  it("issueId present + non-inbox source → TASK directive (get_task), NOT a role directive", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Scout",
      agentRoleKey: "scout",
      payload: { companyId: "co", source: "dispatcher.task", issueId: "TASK-7" },
    });
    // The task directive's stable anchors.
    expect(out).toContain("get_task");
    expect(out).toContain("set_task_status");
    // Steers away from thread tooling — distinctive phrasing from the directive.
    expect(out).toMatch(/this is a task, not a thread/i);
    // The task id is rendered in the context block.
    expect(out).toContain("Task: TASK-7");
    // CRITICAL: it must NOT fall through to the scout role-map directive.
    // (The task directive itself NEGATES post_entry — "Do NOT call post_entry"
    // — so we cannot assert absence of the bare token; assert absence of the
    // scout directive's distinctive POSITIVE phrasing instead.)
    expect(out).not.toContain("investigate the thread context");
    expect(out).not.toContain("thread.createLink");
  });

  it("issueId present even with a role that posts entries → still the TASK directive (overrides role map)", () => {
    // maker's role directive normally says post_entry; issueId must win.
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Maker",
      agentRoleKey: "maker",
      payload: { companyId: "co", source: "dispatcher.task", issueId: "TASK-9" },
    });
    expect(out).toContain("get_task");
    // Must NOT carry the maker role directive's distinctive positive phrasing
    // (it instructs posting an entry with parentEntryId to the inviting entry).
    // The task directive mentions post_entry only to FORBID it, so we key off
    // "parentEntryId" — which appears only in the maker role directive.
    expect(out).not.toContain("parentEntryId");
    expect(out).not.toContain("attaching your artifact");
  });

  it("precedence: inbox.routing_ambiguous wins even if issueId is also present", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Navigator",
      agentRoleKey: "navigator",
      payload: {
        companyId: "co",
        source: "inbox.routing_ambiguous",
        inboxItemId: "inbox-x",
        issueId: "TASK-stowaway",
      },
    });
    // Inbox directive must appear; the task directive must NOT.
    expect(out).toContain("An inbound item needs routing");
    expect(out).not.toContain("get_task");
  });

  it("empty-string issueId does not trigger the task directive (falls back to role map)", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Scribe",
      agentRoleKey: "scribe",
      payload: { companyId: "co", source: "outbox", issueId: "" },
    });
    // Falls through to the scribe role directive, not the task directive.
    expect(out).toContain("submit_extracted_items");
    expect(out).not.toContain("get_task");
    expect(out).not.toContain("Task: ");
  });
});

// Phase 4 / Task 4.3 — contextBundle injection.
// The runner builds a crew context bundle (thread history + summary + memory,
// and for tasks the task body + upstream artifact) and passes it as
// `contextBundle`. buildTriggerPrompt renders it as a `## Context` section
// BETWEEN the persona/instruction and the `## This wakeup` block — only when
// non-empty.
describe("buildTriggerPrompt (Task 4.3) — contextBundle injection", () => {
  it("renders a ## Context section with the bundle text when contextBundle is non-empty", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      payload: { companyId: "co", source: "thread.participation", threadId: "thr-1", mention: "@Scout" },
      agentName: "Scout",
      agentRoleKey: "scout",
      contextBundle: "Recent conversation:\nfounder: we need SSO precedent",
    });
    expect(out).toContain("## Context");
    expect(out).toContain("founder: we need SSO precedent");
  });

  it("places ## Context BETWEEN the persona/instruction and the ## This wakeup block", () => {
    const out = buildTriggerPrompt({
      instruction: "## INSTRUCTION_MARKER\n",
      payload: { companyId: "co", source: "thread.participation", threadId: "thr-1" },
      agentName: "Scout",
      agentRoleKey: "scout",
      contextBundle: "CONTEXT_BUNDLE_MARKER",
    });
    const instructionIdx = out.indexOf("INSTRUCTION_MARKER");
    const contextIdx = out.indexOf("## Context");
    const bundleIdx = out.indexOf("CONTEXT_BUNDLE_MARKER");
    const wakeupIdx = out.indexOf("## This wakeup");
    expect(instructionIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeGreaterThan(instructionIdx);
    expect(bundleIdx).toBeGreaterThan(contextIdx);
    expect(wakeupIdx).toBeGreaterThan(bundleIdx);
  });

  it("omits the ## Context section entirely when contextBundle is empty/whitespace/undefined", () => {
    const empty = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      payload: { companyId: "co", source: "thread.participation", threadId: "thr-1" },
      agentName: "Scout",
      agentRoleKey: "scout",
      contextBundle: "",
    });
    expect(empty).not.toContain("## Context");

    const ws = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      payload: { companyId: "co", source: "thread.participation", threadId: "thr-1" },
      agentName: "Scout",
      agentRoleKey: "scout",
      contextBundle: "   \n  ",
    });
    expect(ws).not.toContain("## Context");

    const undef = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      payload: { companyId: "co", source: "thread.participation", threadId: "thr-1" },
      agentName: "Scout",
      agentRoleKey: "scout",
    });
    expect(undef).not.toContain("## Context");
  });
});

// WS6 — braindump.ingest trigger directive (Librarian).
describe("buildTriggerPrompt (WS6) — braindump.ingest", () => {
  it("renders departmentId, departmentName, and the braindump content", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        departmentName: "Engineering",
        braindumpContent: "We ship on Fridays. Staging is called 'preview'.",
      },
    });
    expect(out).toContain("Department id: dept-1");
    expect(out).toContain("Department name: Engineering");
    expect(out).toContain("Braindump content:");
    expect(out).toContain("We ship on Fridays. Staging is called 'preview'.");
    expect(out).toContain("write_memory");
    expect(out).toContain('layer="domain"');
  });

  it("truncates very long braindump content to keep the prompt bounded", () => {
    const long = "y".repeat(20000);
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        braindumpContent: long,
      },
    });
    expect(out).toContain("Braindump content:");
    expect(out).toContain("[truncated]");
    expect(out).not.toContain(long);
  });

  it("guard case: no braindumpContent still renders without throwing or 'undefined'", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
      },
    });
    expect(out).toContain("Department id: dept-1");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("Braindump content:");
  });

  // -------------------------------------------------------------------------
  // Item 5 / Phase 5c — scope, folders, and attached files.
  // -------------------------------------------------------------------------

  it("company-wide capture: identity layer, no departmentId, explicit company framing", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        memoryLayer: "identity",
        braindumpContent: "We optimize for candor.",
      },
    });
    expect(out).toContain("Scope: company-wide (no department)");
    expect(out).toContain('layer="identity"');
    expect(out).toContain("NO departmentId");
    expect(out).not.toContain("Department id:");
  });

  it("lists the allowed folders and tells the agent they are the only accepted values", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        memoryLayer: "domain",
        allowedFolders: ["engineering/Architecture", "engineering/Decisions"],
        braindumpContent: "We use Drizzle.",
      },
    });
    expect(out).toContain("Folders you may file into:");
    expect(out).toContain("- engineering/Architecture");
    expect(out).toContain("- engineering/Decisions");
    expect(out).toContain("folderPath");
    expect(out).toMatch(/only accepted values/i);
  });

  it("omits all folder instructions when the scope has no folders", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        allowedFolders: [],
        braindumpContent: "x",
      },
    });
    expect(out).not.toContain("Folders you may file into:");
    expect(out).not.toContain("folderPath");
  });

  it("inlines attached-file text and names files that have none", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        braindumpContent: "See attached.",
        attachedFiles: [
          { fileName: "runway.md", text: "14 months of runway." },
          { fileName: "logo.png" },
        ],
      },
    });
    expect(out).toContain("Attached files:");
    expect(out).toContain("- runway.md:");
    expect(out).toContain("14 months of runway.");
    expect(out).toContain("- logo.png (stored in the memory tree; no readable text)");
    // The directive must warn against restating a file name as knowledge.
    expect(out).toMatch(/do not write a memory item that merely restates a file name/i);
  });

  it("caps total attached-file text so one huge file can't blow the prompt", () => {
    const huge = "z".repeat(50_000);
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        attachedFiles: [
          { fileName: "big.pdf", text: huge },
          { fileName: "second.md", text: "later file" },
        ],
      },
    });
    expect(out).toContain("[truncated]");
    expect(out).not.toContain(huge);
    // The second file still appears by name even though the budget is spent.
    expect(out).toContain("second.md");
    expect(out).toContain("prompt budget reached");
  });

  it("ignores malformed allowedFolders/attachedFiles entries rather than throwing", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        allowedFolders: ["ok/Path", 42, null, ""],
        attachedFiles: [{ fileName: "good.md" }, { nope: true }, null, "string"],
        braindumpContent: "x",
      },
    });
    expect(out).toContain("- ok/Path");
    expect(out).toContain("good.md");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("42");
  });

  it("defaults to layer=domain for a legacy payload with no memoryLayer", () => {
    const out = buildTriggerPrompt({
      instruction: "BUNDLE",
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: {
        companyId: "co-1",
        source: "braindump.ingest",
        departmentId: "dept-1",
        braindumpContent: "x",
      },
    });
    expect(out).toContain('layer="domain"');
  });

  it("non-braindump librarian wakeup falls back to the role-table directive (regression guard)", () => {
    const out = buildTriggerPrompt({
      instruction: BASE_INSTRUCTION,
      agentName: "Librarian",
      agentRoleKey: "librarian",
      payload: { companyId: "co", source: "some_other_source" },
    });
    expect(out).toContain("write_memory");
    expect(out).not.toContain("A braindump has been submitted");
  });
});

// Task 0.4 — ensure-adjutant stale-framing guard
describe("ensure-adjutant instruction (Task 0.4)", () => {
  it("does NOT contain stale 'Dispatcher and Engineer take over' framing", () => {
    // The Dispatcher card-making role is retired in a later task.
    // The Adjutant now proposes work directly via propose_crew_work.
    expect(ENSURE_ADJUTANT_SRC).not.toMatch(/Dispatcher.*take over/i);
  });

  it("does NOT reference Dispatcher taking over at the scope transition", () => {
    // Even partial "Dispatcher … take over" in any form is stale
    expect(ENSURE_ADJUTANT_SRC).not.toMatch(/Dispatcher[^.]*take over/i);
  });
});
