import { describe, expect, it, vi } from "vitest";
import type { CompanyBrainNeighborsResponse } from "@armyofagents/shared";
import { expandRetrievalWithCompanyGraph } from "../services/company-brain/retrieval-expansion.js";

interface MemoryFixture {
  id: string;
  companyId: string;
  title: string;
  content: string;
  status: string;
  departmentId?: string | null;
  projectId?: string | null;
}

const seed = (id: string, title = id): MemoryFixture => ({
  id,
  companyId: "co-1",
  title,
  content: `${title} content`,
  status: "approved",
  departmentId: null,
  projectId: null,
});

function graphFor(
  center: MemoryFixture,
  edges: Array<{
    id: string;
    toId: string;
    toType?: "memory_item" | "agent" | "project";
    kind: CompanyBrainNeighborsResponse["edges"][number]["kind"];
  }>,
): CompanyBrainNeighborsResponse {
  return {
    center: {
      type: "memory_item",
      id: center.id,
      companyId: center.companyId,
      label: center.title,
    },
    nodes: [
      {
        type: "memory_item",
        id: center.id,
        companyId: center.companyId,
        label: center.title,
      },
      ...edges.map((edge) => ({
        type: edge.toType ?? "memory_item",
        id: edge.toId,
        companyId: center.companyId,
        label: edge.toId,
      })),
    ],
    edges: edges.map((edge) => ({
      id: edge.id,
      companyId: center.companyId,
      from: { type: "memory_item", id: center.id },
      to: { type: edge.toType ?? "memory_item", id: edge.toId },
      kind: edge.kind,
      sourceClass: "semantic",
      editability: "editable",
    })),
  };
}

describe("expandRetrievalWithCompanyGraph", () => {
  it("keeps primary multipath items ordered and adds compact one-hop graph context", async () => {
    const primary = [seed("mem-1", "Brand voice"), seed("mem-2", "Launch plan")];
    const neighbor = seed("mem-related", "Tone examples");
    const loadNeighbors = vi.fn(async (itemId: string) =>
      itemId === "mem-1"
        ? graphFor(primary[0], [{ id: "edge-1", toId: neighbor.id, kind: "supports" }])
        : graphFor(primary[1], []),
    );

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      loadNeighbors,
      loadMemoryItem: vi.fn(async (itemId: string) => (itemId === neighbor.id ? neighbor : null)),
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(expanded.items.map((item) => item.id)).toEqual(["mem-1", "mem-2"]);
    expect(expanded.graphContext).toEqual([
      {
        itemId: "mem-related",
        title: "Tone examples",
        sourceItemId: "mem-1",
        sourceTitle: "Brand voice",
        edgeKind: "supports",
        why: "supports Brand voice",
      },
    ]);
    expect(expanded.graphContext[0]).not.toHaveProperty("content");
  });

  it("filters neighbors to useful one-hop memory edges only", async () => {
    const primary = [seed("mem-1", "Brand voice")];
    const useful = seed("mem-applies", "Messaging checklist");
    const ignored = seed("mem-mentions", "Incidental mention");

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      loadNeighbors: vi.fn(async () =>
        graphFor(primary[0], [
          { id: "edge-useful", toId: useful.id, kind: "applies_to" },
          { id: "edge-noise", toId: ignored.id, kind: "mentions" },
          { id: "edge-agent", toId: "agent-1", toType: "agent", kind: "supports" },
        ]),
      ),
      loadMemoryItem: vi.fn(async (itemId: string) =>
        itemId === useful.id ? useful : itemId === ignored.id ? ignored : null,
      ),
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(expanded.graphContext.map((entry) => entry.itemId)).toEqual(["mem-applies"]);
  });

  it("caps high-degree expansion and deduplicates neighbors across seeds", async () => {
    const primary = [seed("mem-1", "A"), seed("mem-2", "B")];
    const neighbors = ["mem-a", "mem-b", "mem-c"].map((id) => seed(id, id));
    const byId = new Map(neighbors.map((item) => [item.id, item]));

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      maxGraphItems: 2,
      loadNeighbors: vi.fn(async (itemId: string) =>
        itemId === "mem-1"
          ? graphFor(primary[0], [
              { id: "edge-a", toId: "mem-a", kind: "related_to" },
              { id: "edge-b", toId: "mem-b", kind: "related_to" },
            ])
          : graphFor(primary[1], [
              { id: "edge-b2", toId: "mem-b", kind: "supports" },
              { id: "edge-c", toId: "mem-c", kind: "supports" },
            ]),
      ),
      loadMemoryItem: vi.fn(async (itemId: string) => byId.get(itemId) ?? null),
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(expanded.graphContext.map((entry) => entry.itemId)).toEqual(["mem-a", "mem-b"]);
  });

  it("applies the caller scope filter to expanded graph neighbors", async () => {
    const primary = [seed("mem-1", "A")];
    const visible = seed("mem-visible", "Visible");
    const hidden = seed("mem-hidden", "Hidden");

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      loadNeighbors: vi.fn(async () =>
        graphFor(primary[0], [
          { id: "edge-visible", toId: visible.id, kind: "supports" },
          { id: "edge-hidden", toId: hidden.id, kind: "supports" },
        ]),
      ),
      loadMemoryItem: vi.fn(async (itemId: string) =>
        itemId === visible.id ? visible : itemId === hidden.id ? hidden : null,
      ),
      filterMemoryItems: vi.fn(async (items) => items.filter((item) => item.id !== hidden.id)),
    });

    expect(expanded.graphContext.map((entry) => entry.itemId)).toEqual(["mem-visible"]);
  });

  it("never exposes pending graph neighbors to agent retrieval context", async () => {
    const primary = [seed("mem-1", "A")];
    const pending = { ...seed("mem-pending", "Pending suggestion"), status: "pending" };

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      loadNeighbors: vi.fn(async () =>
        graphFor(primary[0], [{ id: "edge-pending", toId: pending.id, kind: "supports" }]),
      ),
      loadMemoryItem: vi.fn(async (itemId: string) => (itemId === pending.id ? pending : null)),
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(expanded.graphContext).toEqual([]);
  });

  it("applies the graph cap after approval and scope filtering", async () => {
    const primary = [seed("mem-1", "A")];
    const pendingA = { ...seed("mem-pending-a", "Pending A"), status: "pending" };
    const pendingB = { ...seed("mem-pending-b", "Pending B"), status: "pending" };
    const visible = seed("mem-visible", "Visible");
    const byId = new Map([pendingA, pendingB, visible].map((item) => [item.id, item]));

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      maxGraphItems: 1,
      loadNeighbors: vi.fn(async () =>
        graphFor(primary[0], [
          { id: "edge-pending-a", toId: pendingA.id, kind: "supports" },
          { id: "edge-pending-b", toId: pendingB.id, kind: "supports" },
          { id: "edge-visible", toId: visible.id, kind: "supports" },
        ]),
      ),
      loadMemoryItem: vi.fn(async (itemId: string) => byId.get(itemId) ?? null),
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(expanded.graphContext.map((entry) => entry.itemId)).toEqual(["mem-visible"]);
  });

  it("bounds candidate loading before the final visible graph cap", async () => {
    const primary = [seed("mem-1", "A")];
    const neighborIds = Array.from({ length: 20 }, (_, index) => `mem-neighbor-${index}`);
    const byId = new Map(neighborIds.map((id) => [id, seed(id, id)]));
    const loadMemoryItem = vi.fn(async (itemId: string) => byId.get(itemId) ?? null);

    const expanded = await expandRetrievalWithCompanyGraph({
      companyId: "co-1",
      seeds: primary,
      maxGraphItems: 2,
      maxCandidateItems: 5,
      loadNeighbors: vi.fn(async () =>
        graphFor(
          primary[0],
          neighborIds.map((id, index) => ({
            id: `edge-${index}`,
            toId: id,
            kind: "supports",
          })),
        ),
      ),
      loadMemoryItem,
      filterMemoryItems: vi.fn(async (items) => items),
    });

    expect(loadMemoryItem).toHaveBeenCalledTimes(5);
    expect(expanded.graphContext.map((entry) => entry.itemId)).toEqual([
      "mem-neighbor-0",
      "mem-neighbor-1",
    ]);
  });
});
