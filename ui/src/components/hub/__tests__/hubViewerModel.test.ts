import { describe, expect, it } from "vitest";
import { closeTab, ensureTab } from "../../../lib/viewer-tabs";
import {
  HOME_TAB,
  agentTab,
  approvalTab,
  browserTab,
  budgetTab,
  joinRequestTab,
  marketplaceOpTab,
  notificationTab,
  reminderTab,
  routineTab,
  runTab,
  runtimeDecisionTab,
  suggestionTab,
  taskTab,
  threadTab,
} from "../hubViewerModel";

describe("hubViewerModel", () => {
  it("exposes a non-closeable HOME tab", () => {
    expect(HOME_TAB).toEqual({
      key: "home",
      kind: "home",
      title: "Home",
      closeable: false,
    });
    expect(HOME_TAB.closeable).toBe(false);
  });

  it("builds an approval tab keyed by id", () => {
    expect(approvalTab("a1", "Hire Scout")).toEqual({
      key: "approval:a1",
      kind: "approval",
      title: "Hire Scout",
      closeable: true,
      payload: { approvalId: "a1" },
    });
  });

  it("falls back to a default title when none is given", () => {
    expect(approvalTab("a1").title).toBe("Approval");
  });

  it("builds a join_request tab keyed by id", () => {
    expect(joinRequestTab("jr1")).toMatchObject({
      key: "join_request:jr1",
      kind: "join_request",
      payload: { joinRequestId: "jr1" },
    });
  });

  it("builds a thread tab carrying an optional entryId", () => {
    expect(threadTab("d1", "Launch thread", "e9")).toEqual({
      key: "thread:d1",
      kind: "thread",
      title: "Launch thread",
      closeable: true,
      payload: { discussionId: "d1", entryId: "e9" },
    });
    expect(threadTab("d1").payload).toEqual({ discussionId: "d1", entryId: undefined });
  });

  it("builds a runtime_decision tab carrying the hub item id", () => {
    expect(runtimeDecisionTab("hub-7")).toMatchObject({
      key: "runtime_decision:hub-7",
      kind: "runtime_decision",
      payload: { hubItemId: "hub-7" },
    });
  });

  it("builds a task tab keyed by issue id", () => {
    expect(taskTab("i1", "Ship it")).toMatchObject({
      key: "task:i1",
      kind: "task",
      title: "Ship it",
      payload: { issueId: "i1" },
    });
  });

  it("builds an agent tab keyed by agent id", () => {
    expect(agentTab("ag1")).toMatchObject({
      key: "agent:ag1",
      kind: "agent",
      payload: { agentId: "ag1" },
    });
  });

  it("builds a run tab carrying BOTH runId and agentId", () => {
    const tab = runTab("run-1", "ag-2", "Heartbeat run");
    expect(tab).toEqual({
      key: "run:run-1",
      kind: "run",
      title: "Heartbeat run",
      closeable: true,
      payload: { runId: "run-1", agentId: "ag-2" },
    });
  });

  it("builds a budget tab with a fixed company key", () => {
    expect(budgetTab()).toEqual({
      key: "budget:company",
      kind: "budget",
      title: "Budget",
      closeable: true,
      payload: { scope: "company" },
    });
  });

  it("builds a suggestion tab keyed by id", () => {
    expect(suggestionTab("s1")).toMatchObject({
      key: "suggestion:s1",
      kind: "suggestion",
      payload: { suggestionId: "s1" },
    });
  });

  it("builds a marketplace_op tab keyed by source id", () => {
    expect(marketplaceOpTab("src-1")).toMatchObject({
      key: "marketplace_op:src-1",
      kind: "marketplace_op",
      payload: { sourceId: "src-1" },
    });
  });

  it("builds a reminder tab keyed by id", () => {
    expect(reminderTab("rem-1")).toMatchObject({
      key: "reminder:rem-1",
      kind: "reminder",
      payload: { reminderId: "rem-1" },
    });
  });

  it("builds a routine tab keyed by id", () => {
    expect(routineTab("routine-1")).toMatchObject({
      key: "routine:routine-1",
      kind: "routine",
      payload: { routineId: "routine-1" },
    });
  });

  it("can carry the originating hub item id without changing the tab key", () => {
    expect(taskTab("issue-1", "Task", "hub-1")).toMatchObject({
      key: "task:issue-1",
      payload: { issueId: "issue-1", hubItemId: "hub-1" },
    });
  });

  it("normalizes a browser tab url like the thread viewer does", () => {
    expect(browserTab("https://www.example.com/path")).toMatchObject({
      key: "browser:https://www.example.com/path",
      kind: "browser",
      title: "example.com",
      payload: { url: "https://www.example.com/path" },
    });
  });

  it("builds a generic notification fallback tab", () => {
    expect(notificationTab("hub-9")).toMatchObject({
      key: "notification:hub-9",
      kind: "notification",
      payload: { hubItemId: "hub-9" },
    });
  });

  describe("composition with generic tab helpers", () => {
    it("dedupes a tab by key on re-add", () => {
      const tabs = ensureTab([HOME_TAB], approvalTab("a1"));
      expect(tabs).toHaveLength(2);
      const again = ensureTab(tabs, approvalTab("a1"));
      expect(again).toHaveLength(2);
      expect(again).toBe(tabs);
    });

    it("keeps two tabs for distinct approval ids but one for the same id", () => {
      let tabs = ensureTab([HOME_TAB], approvalTab("a1"));
      tabs = ensureTab(tabs, approvalTab("a2"));
      expect(tabs).toHaveLength(3);
      tabs = ensureTab(tabs, approvalTab("a1"));
      expect(tabs).toHaveLength(3);
    });

    it("cannot close the HOME tab but can close others", () => {
      const tabs = ensureTab([HOME_TAB], approvalTab("a1"));
      expect(closeTab(tabs, "home")).toEqual(tabs);
      expect(closeTab(tabs, "approval:a1")).toEqual([HOME_TAB]);
    });
  });
});
