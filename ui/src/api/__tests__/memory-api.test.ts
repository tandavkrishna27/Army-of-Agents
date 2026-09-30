import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from "../client";
import { memoryApi } from "../memory";

describe("memoryApi.neighbors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("URL-encodes memory item ids and forwards graph query options", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      center: {
        type: "memory_item",
        id: "item/1",
        companyId: "company-1",
        label: "Pricing",
      },
      nodes: [],
      edges: [],
    });

    await memoryApi.neighbors("company-1", "item/1", {
      depth: 1,
      kinds: ["belongs_to", "related_to"],
    });

    expect(api.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/items/item%2F1/neighbors?depth=1&kinds=belongs_to%2Crelated_to",
    );
  });
});

describe("memoryApi.usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("URL-encodes memory item ids for usage lookup", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ itemId: "item/1", agents: [] });

    await memoryApi.usage("company-1", "item/1");

    expect(api.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/items/item%2F1/usage",
    );
  });
});

describe("memoryApi.companyGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards company graph overview options", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      nodes: [],
      edges: [],
      limit: 150,
      truncated: false,
    });

    await memoryApi.companyGraph("company-1", {
      limit: 150,
      includeStructural: false,
      kinds: ["related_to", "supports"],
    });

    expect(api.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/graph?limit=150&includeStructural=false&kinds=related_to%2Csupports",
    );
  });
});

describe("memoryApi graph edge CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts semantic edge creates to the graph edge endpoint", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ id: "edge-1" });

    await memoryApi.createGraphEdge("company-1", {
      from: { type: "memory_item", id: "item-1" },
      to: { type: "memory_item", id: "item-2" },
      kind: "related_to",
      evidence: "Same policy area",
    });

    expect(api.post).toHaveBeenCalledWith(
      "/companies/company-1/memory/graph/edges",
      {
        from: { type: "memory_item", id: "item-1" },
        to: { type: "memory_item", id: "item-2" },
        kind: "related_to",
        evidence: "Same policy area",
      },
    );
  });

  it("URL-encodes edge ids for update and archive", async () => {
    vi.mocked(api.patch).mockResolvedValueOnce({ id: "edge/1" });
    vi.mocked(api.delete).mockResolvedValueOnce({ id: "edge/1" });

    await memoryApi.updateGraphEdge("company-1", "edge/1", { evidence: "Updated" });
    await memoryApi.archiveGraphEdge("company-1", "edge/1");

    expect(api.patch).toHaveBeenCalledWith(
      "/companies/company-1/memory/graph/edges/edge%2F1",
      { evidence: "Updated" },
    );
    expect(api.delete).toHaveBeenCalledWith(
      "/companies/company-1/memory/graph/edges/edge%2F1",
    );
  });
});
