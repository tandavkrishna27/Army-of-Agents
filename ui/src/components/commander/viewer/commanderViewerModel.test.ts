import { describe, it, expect } from "vitest";
import {
  emptyViewerState,
  openRefTab,
  openInputRefTab,
  openReplyTab,
  openTaskTab,
  openBrowserTab,
  closeTab,
  shouldAutoOpen,
  pickAutoOpenRef,
  chipLabel,
  collectConversationRefs,
  mergeRefs,
  type ConversationViewerState,
} from "./commanderViewerModel";
import type { CommanderOutputRef } from "@armyofagents/shared";
import type { CommanderInputRef } from "@armyofagents/shared";

const ref = (id: string, action: "created" | "referenced" = "created", title: string | null = "Plan"): CommanderOutputRef =>
  ({ v: 1, kind: "artifact", id, action, title } as CommanderOutputRef);

describe("commanderViewerModel", () => {
  it("openRefTab adds a tab and focuses it; reopening focuses without duplicating", () => {
    let s: ConversationViewerState = emptyViewerState();
    s = openRefTab(s, ref("a1"));
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    expect(s.expanded).toBe(true);
    const again = openRefTab(s, ref("a1"));
    expect(again.tabs).toHaveLength(1);
  });

  it("closeTab removes and re-focuses neighbor (home when empty)", () => {
    let s = openRefTab(openRefTab(emptyViewerState(), ref("a1")), ref("a2"));
    const closing = s.tabs.find((t) => t.refId === "a2")!;
    s = closeTab(s, closing.id);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    s = closeTab(s, s.tabs[0]!.id);
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBe("home");
  });

  it("openReplyTab opens a markdown tab keyed by message id", () => {
    let s = openReplyTab(emptyViewerState(), "msg-1", "# Hello");
    expect(s.tabs[0]).toMatchObject({ kind: "reply", refId: "msg-1" });
    s = openReplyTab(s, "msg-1", "# Hello");
    expect(s.tabs).toHaveLength(1); // focus, not duplicate
  });

  it("openBrowserTab opens a browser tab titled by hostname, expands, dedupes", () => {
    let s = emptyViewerState();
    s = openBrowserTab(s, "https://example.com/path");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ kind: "browser", url: "https://example.com/path", title: "example.com" });
    expect(s.expanded).toBe(true);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    const again = openBrowserTab(s, "https://example.com/path");
    expect(again.tabs).toHaveLength(1); // dedup, focus
  });

  it("openBrowserTab falls back to the raw url as title when the url cannot be parsed", () => {
    const s = openBrowserTab(emptyViewerState(), "not a url");
    expect(s.tabs[0]).toMatchObject({ kind: "browser", title: "not a url", url: "not a url" });
  });

  it("shouldAutoOpen: created+desktop only", () => {
    expect(shouldAutoOpen(ref("a", "created"), false)).toBe(true);
    expect(shouldAutoOpen(ref("a", "created"), true)).toBe(false);
    expect(shouldAutoOpen(ref("a", "referenced"), false)).toBe(false);
  });

  it("chipLabel falls back to kind + short id", () => {
    expect(chipLabel(ref("a1", "created", "GTM Plan"))).toBe("GTM Plan");
    expect(chipLabel(ref("abcdef123456", "created", null))).toBe("artifact abcdef12");
  });

  it("collectConversationRefs dedupes across messages, created wins", () => {
    const refs = collectConversationRefs([
      { outputRefs: [ref("a1", "referenced")] },
      { outputRefs: [ref("a1", "created"), ref("a2", "referenced")] },
      { outputRefs: null },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.id === "a1")!.action).toBe("created");
  });

  describe("mergeRefs", () => {
    it("created wins over referenced for same kind|id|versionId key", () => {
      const existing = [ref("a1", "referenced")];
      const incoming = [ref("a1", "created")];
      const result = mergeRefs(existing, incoming);
      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe("created");
    });

    it("existing wins when incoming is also referenced (no promotion)", () => {
      const existing = [ref("a1", "referenced")];
      const incoming = [ref("a1", "referenced")];
      const result = mergeRefs(existing, incoming);
      expect(result).toHaveLength(1);
    });

    it("distinct versionIds are kept as separate entries", () => {
      const r1: CommanderOutputRef = { v: 1, kind: "artifact", id: "a1", versionId: "v1", action: "created", title: "Plan" } as unknown as CommanderOutputRef;
      const r2: CommanderOutputRef = { v: 1, kind: "artifact", id: "a1", versionId: "v2", action: "created", title: "Plan v2" } as unknown as CommanderOutputRef;
      const result = mergeRefs([r1], [r2]);
      expect(result).toHaveLength(2);
    });

    it("existing entry wins in a tie (no incoming promotion for non-created)", () => {
      const existing = [ref("a1", "created")];
      const incoming = [ref("a1", "referenced")];
      const result = mergeRefs(existing, incoming);
      expect(result).toHaveLength(1);
      expect(result[0]!.action).toBe("created");
    });
  });

  describe("mergeRefs v1/v2 coalescing + field-wise provenance (twin of server mergeOutputRefs)", () => {
    const prov = (emittedAt: string) => ({
      surface: "commander" as const,
      entityId: "conv-1",
      runId: "run-1",
      agentId: null,
      messageId: null,
      seq: 0,
      emittedAt,
    });
    const v1 = (id: string, action: "created" | "referenced", title: string | null = null): any =>
      ({ v: 1, kind: "artifact", id, versionId: null, action, title });
    const v2 = (
      id: string,
      action: "created" | "referenced",
      provenance: ReturnType<typeof prov> | null = null,
      versionId: string | null = null,
      title: string | null = null,
    ): any => ({ v: 2, kind: "artifact", id, versionId, action, title, provenance });
    const EARLY = "2026-07-19T10:00:00.000Z";
    const LATE = "2026-07-19T11:00:00.000Z";

    it("v1-created + v2-referenced coalesces to ONE created v2 with the v2's provenance (both orders)", () => {
      const a = mergeRefs([v1("a1", "created")], [v2("a1", "referenced", prov(EARLY))]);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ v: 2, action: "created", provenance: { emittedAt: EARLY } });
      const b = mergeRefs([v2("a1", "referenced", prov(EARLY))], [v1("a1", "created")]);
      expect(b).toHaveLength(1);
      expect(b[0]).toMatchObject({ v: 2, action: "created", provenance: { emittedAt: EARLY } });
    });

    it("two v2 created refs → newer emittedAt wins; real beats null (both orders)", () => {
      const older = v2("a1", "created", prov(EARLY));
      const newer = v2("a1", "created", prov(LATE));
      expect((mergeRefs([older], [newer])[0] as any).provenance.emittedAt).toBe(LATE);
      expect((mergeRefs([newer], [older])[0] as any).provenance.emittedAt).toBe(LATE);
      const noProv = v2("a1", "created", null);
      expect((mergeRefs([noProv], [older])[0] as any).provenance.emittedAt).toBe(EARLY);
      expect((mergeRefs([older], [noProv])[0] as any).provenance.emittedAt).toBe(EARLY);
    });

    it("same-artifact v1 + v2 → exactly one card", () => {
      expect(mergeRefs([v1("a1", "referenced")], [v2("a1", "referenced", prov(EARLY))])).toHaveLength(1);
    });

    it("backfills title first-non-empty across a v1/v2 collision (same versionId)", () => {
      const a: any = { v: 1, kind: "artifact", id: "a1", versionId: "ver-9", action: "created", title: null };
      const merged = mergeRefs([a], [v2("a1", "referenced", prov(EARLY), "ver-9", "From V2")]);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ v: 2, action: "created", title: "From V2", versionId: "ver-9" });
    });
  });
});

describe("shouldAutoOpen level gate", () => {
  const created = (id: string) => ({ v: 1, kind: "artifact", id, action: "created" } as any);
  it("manual never; own_output/full open created on desktop; mobile never; referenced never", () => {
    expect(shouldAutoOpen(created("a"), false, "manual")).toBe(false);
    expect(shouldAutoOpen(created("a"), false, "own_output")).toBe(true);
    expect(shouldAutoOpen(created("a"), false, "full")).toBe(true);
    expect(shouldAutoOpen(created("a"), true, "own_output")).toBe(false);
    expect(shouldAutoOpen({ ...created("a"), action: "referenced" }, false, "full")).toBe(false);
  });
});

describe("pickAutoOpenRef (one per batch)", () => {
  const created = (id: string) => ({ v: 1, kind: "artifact", id, action: "created" } as any);
  it("returns the first eligible created ref, or null", () => {
    expect(pickAutoOpenRef([created("a"), created("b")], "own_output", false)?.id).toBe("a");
    expect(pickAutoOpenRef([created("a")], "manual", false)).toBeNull();
    expect(pickAutoOpenRef([created("a")], "own_output", true)).toBeNull();
    expect(pickAutoOpenRef([{ ...created("a"), action: "referenced" }], "own_output", false)).toBeNull();
  });

  // DEFERRED-FRESHNESS BASELINE (Phase-6, Codex P2.2): the auto-open gate is
  // version- AND provenance-agnostic today — it reads ONLY `action`. A v2 ref
  // carrying a STALE `provenance.emittedAt` (e.g. an old `created` ref
  // reattached to an SSE tool_result during an idempotent replay, agent-loop.ts
  // reattach path) is STILL auto-open-eligible. This test documents that
  // intended baseline so a future replay/freshness gate has a tripwire: when
  // freshness gating lands (consuming provenance.emittedAt), THIS expectation
  // must flip to `toBeNull()`. Do not "fix" it before that gate exists.
  it("baseline: a stale-provenance created ref is still eligible (no freshness gate yet)", () => {
    const stale = {
      v: 2,
      kind: "artifact",
      id: "old",
      action: "created",
      provenance: { surface: "commander", entityId: "c1", seq: 0, emittedAt: "2000-01-01T00:00:00.000Z" },
    } as any;
    expect(pickAutoOpenRef([stale], "own_output", false)?.id).toBe("old");
  });
});

describe("openTaskTab", () => {
  it("opens a task tab (kind=task, refId=issueId), expands, activates", () => {
    const s = openTaskTab(emptyViewerState(), "issue-1", "Fix login");
    expect(s.expanded).toBe(true);
    expect(s.activeId).toBe("task:issue-1");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ id: "task:issue-1", kind: "task", refId: "issue-1", title: "Fix login" });
  });
  it("re-activates an existing task tab instead of duplicating", () => {
    const a = openTaskTab(emptyViewerState(), "issue-1", "Fix login");
    const b = openTaskTab({ ...a, activeId: "home", expanded: false }, "issue-1", "Fix login");
    expect(b.tabs).toHaveLength(1);
    expect(b.activeId).toBe("task:issue-1");
    expect(b.expanded).toBe(true);
  });
});

describe("openInputRefTab", () => {
  const inputRef = (
    kind: CommanderInputRef["kind"],
    id: string,
    label = "Referenced item",
    detail?: string,
  ): CommanderInputRef => ({
    v: 1,
    kind,
    id,
    label,
    ...(detail ? { detail } : {}),
  });

  it("opens discussion, approval, inbox, and note tabs in the viewer", () => {
    let state = emptyViewerState();
    state = openInputRefTab(state, inputRef("discussion", "disc-1", "Sprint planning"));
    state = openInputRefTab(state, inputRef("approval", "approval-1", "Approve budget"));
    state = openInputRefTab(state, inputRef("inbox", "hub-1", "Run complete", "Finished successfully"));
    state = openInputRefTab(state, inputRef("note", "note-1", "Sticky note", "Remember launch"));

    expect(state.tabs.map((tab) => tab.kind)).toEqual(["discussion", "approval", "inbox", "note"]);
    expect(state.tabs.map((tab) => tab.refId)).toEqual(["disc-1", "approval-1", "hub-1", "note-1"]);
    expect(state.activeId).toBe("note:note-1");
    expect(state.expanded).toBe(true);
  });

  it("re-activates an existing input-ref tab instead of duplicating", () => {
    const first = openInputRefTab(emptyViewerState(), inputRef("discussion", "disc-1", "Sprint planning"));
    const second = openInputRefTab({ ...first, activeId: "home", expanded: false }, inputRef("discussion", "disc-1", "Sprint planning"));
    expect(second.tabs).toHaveLength(1);
    expect(second.activeId).toBe("discussion:disc-1");
    expect(second.expanded).toBe(true);
  });

  it("maps task and artifact input refs to existing viewer tab kinds", () => {
    let state = emptyViewerState();
    state = openInputRefTab(state, inputRef("task", "issue-1", "Fix login"));
    state = openInputRefTab(state, inputRef("artifact", "artifact-1", "Launch plan"));

    expect(state.tabs[0]).toMatchObject({ id: "task:issue-1", kind: "task", refId: "issue-1" });
    expect(state.tabs[1]).toMatchObject({ id: "artifact:artifact-1:latest", kind: "artifact", refId: "artifact-1" });
  });
});

describe("openRefTab kind routing", () => {
  const empty = emptyViewerState();
  it("opens an artifact tab for a v1 artifact ref (unchanged)", () => {
    const s = openRefTab(empty, { v: 1, kind: "artifact", id: "a1", action: "created" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "artifact", refId: "a1" });
  });
  it("routes a v2 task ref to a task tab", () => {
    const s = openRefTab(empty, { v: 2, kind: "task", id: "t1", action: "referenced" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "task", refId: "t1", id: "task:t1" });
  });
  it("routes a v2 discussion ref to a discussion tab", () => {
    const s = openRefTab(empty, { v: 2, kind: "discussion", id: "d1", action: "referenced" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "discussion", refId: "d1", id: "discussion:d1" });
  });
  it("routes a v2 url ref to a scheme-gated browser tab", () => {
    const s = openRefTab(empty, { v: 2, kind: "url", id: "https://example.com", action: "referenced" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "browser", url: "https://example.com" });
    const blocked = openRefTab(empty, { v: 2, kind: "url", id: "javascript:alert(1)", action: "referenced" } as any);
    expect(blocked.tabs[0]).toMatchObject({ kind: "browser", url: "about:blank" });
  });
  it("routes a v2 asset ref to an asset tab (kind=asset, id=asset:<id>)", () => {
    const s = openRefTab(empty, { v: 2, kind: "asset", id: "as1", action: "referenced" } as any);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ kind: "asset", refId: "as1", id: "asset:as1" });
    expect(s.activeId).toBe("asset:as1");
    expect(s.expanded).toBe(true);
  });

  it("routes a v2 output ref to an output tab", () => {
    const s = openRefTab(empty, { v: 2, kind: "output", id: "out1", action: "created" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "output", refId: "out1", id: "output:out1" });
  });

  it("routes a v2 memory_item ref to a memory_item tab", () => {
    const s = openRefTab(empty, { v: 2, kind: "memory_item", id: "m1", action: "referenced" } as any);
    expect(s.tabs[0]).toMatchObject({ kind: "memory_item", refId: "m1", id: "memory_item:m1" });
  });

  it("carries the v2 viewerKind + mimeType hints onto the opened tab", () => {
    const s = openRefTab(empty, {
      v: 2,
      kind: "asset",
      id: "as2",
      action: "referenced",
      viewerKind: "markdown",
      mimeType: "text/markdown",
    } as any);
    expect(s.tabs[0]).toMatchObject({
      kind: "asset",
      refId: "as2",
      viewerKind: "markdown",
      mimeType: "text/markdown",
    });
  });

  it("dedupes an already-open asset tab (focus, not duplicate)", () => {
    const first = openRefTab(empty, { v: 2, kind: "asset", id: "as1", action: "referenced" } as any);
    const again = openRefTab(
      { ...first, activeId: "home", expanded: false },
      { v: 2, kind: "asset", id: "as1", action: "referenced" } as any,
    );
    expect(again.tabs).toHaveLength(1);
    expect(again.activeId).toBe("asset:as1");
    expect(again.expanded).toBe(true);
  });
});
