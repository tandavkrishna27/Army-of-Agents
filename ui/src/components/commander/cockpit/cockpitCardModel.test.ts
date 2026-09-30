import { describe, it, expect } from "vitest";
import {
  groupCardsBySection,
  selectVisibleCards,
  selectVisibleSectionGroups,
  type CockpitCardDef,
} from "./cockpitCardModel";

const RUNNING_CARD: CockpitCardDef = {
  id: "running",
  title: "Running now",
  defaultOn: true,
  sectionId: "watch",
};
const REGISTRY = [RUNNING_CARD];

describe("selectVisibleCards", () => {
  it("empty active -> no cards shown", () => {
    const result = selectVisibleCards({ registry: REGISTRY, hidden: [], order: [], active: {} });
    expect(result).toHaveLength(0);
  });

  it("active.running=true -> running card shown", () => {
    const result = selectVisibleCards({ registry: REGISTRY, hidden: [], order: [], active: { running: true } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("running");
  });

  it("hidden:['running'] -> hidden even when active", () => {
    const result = selectVisibleCards({ registry: REGISTRY, hidden: ["running"], order: [], active: { running: true } });
    expect(result).toHaveLength(0);
  });

  it("order reorders multiple cards", () => {
    const cardA: CockpitCardDef = { id: "a", title: "A", defaultOn: true, sectionId: "triage" };
    const cardB: CockpitCardDef = { id: "b", title: "B", defaultOn: true, sectionId: "my_work" };
    const result = selectVisibleCards({
      registry: [cardA, cardB],
      hidden: [],
      order: ["b", "a"],
      active: { a: true, b: true },
    });
    expect(result.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("defaultOn=false excludes card even when active", () => {
    const offCard: CockpitCardDef = { id: "off", title: "Off", defaultOn: false, sectionId: "memory_context" };
    const result = selectVisibleCards({
      registry: [offCard],
      hidden: [],
      order: [],
      active: { off: true },
    });
    expect(result).toHaveLength(0);
  });

  it("defaultOn=false card IS shown when its id is in enabled", () => {
    const offCard: CockpitCardDef = { id: "off", title: "Off", defaultOn: false, sectionId: "memory_context" };
    const result = selectVisibleCards({
      registry: [offCard],
      hidden: [],
      order: [],
      active: { off: true },
      enabled: ["off"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("off");
  });
});

describe("Cockpit card sections", () => {
  const SECTION_REGISTRY: CockpitCardDef[] = [
    { id: "inbox", title: "Inbox", defaultOn: true, sectionId: "triage" },
    { id: "review", title: "Review", defaultOn: true, sectionId: "triage" },
    { id: "approvals", title: "Approvals", defaultOn: true, sectionId: "triage" },
    { id: "myTasks", title: "My tasks", defaultOn: true, sectionId: "my_work" },
    { id: "today", title: "Today", defaultOn: true, sectionId: "my_work" },
    { id: "stickyNotes", title: "Sticky notes", defaultOn: true, sectionId: "my_work" },
    { id: "discussions", title: "Discussions", defaultOn: true, sectionId: "conversations" },
    { id: "running", title: "Running now", defaultOn: true, sectionId: "watch" },
    { id: "goalsAtRisk", title: "Goals at risk", defaultOn: false, sectionId: "watch" },
    { id: "budgetPulse", title: "Budget pulse", defaultOn: false, sectionId: "watch" },
    { id: "doneToday", title: "Done today", defaultOn: false, sectionId: "watch" },
    { id: "proactiveFindings", title: "Proactive findings", defaultOn: false, sectionId: "watch" },
    { id: "teammatesActivity", title: "Teammates' activity", defaultOn: false, sectionId: "watch" },
    { id: "pinned", title: "Pinned", defaultOn: true, sectionId: "memory_context" },
    { id: "memory", title: "Memory", defaultOn: true, sectionId: "memory_context" },
  ];

  it("groups cards by the fixed cockpit section order", () => {
    const result = groupCardsBySection(SECTION_REGISTRY);
    expect(result.map((group) => group.section.id)).toEqual([
      "triage",
      "my_work",
      "conversations",
      "watch",
      "memory_context",
    ]);
    expect(result.map((group) => group.section.title)).toEqual([
      "Triage",
      "My Work",
      "Conversations",
      "Watch",
      "Memory & Context",
    ]);
    expect(result[0].cards.map((card) => card.id)).toEqual(["inbox", "review", "approvals"]);
  });

  it("selects visible card groups and skips empty sections", () => {
    const result = selectVisibleSectionGroups({
      registry: SECTION_REGISTRY,
      hidden: [],
      order: [],
      active: {
        approvals: false,
        myTasks: true,
        discussions: false,
        running: true,
        pinned: false,
      },
      enabled: [],
    });

    expect(result.map((group) => group.section.id)).toEqual(["my_work", "watch"]);
    expect(result.flatMap((group) => group.cards.map((card) => card.id))).toEqual(["myTasks", "running"]);
  });
});
