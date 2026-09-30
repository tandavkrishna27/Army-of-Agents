import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompanyBrainNeighborsResponse } from "@armyofagents/shared";
import { LocalGraphPreview } from "../LocalGraphPreview";

function graph(overrides: Partial<CompanyBrainNeighborsResponse> = {}): CompanyBrainNeighborsResponse {
  return {
    center: {
      type: "memory_item",
      id: "i-1",
      companyId: "co-1",
      label: "Pricing policy",
    },
    nodes: [
      { type: "memory_item", id: "i-1", companyId: "co-1", label: "Pricing policy" },
      { type: "memory_item", id: "i-2", companyId: "co-1", label: "Seat billing" },
      { type: "department", id: "d-1", companyId: "co-1", label: "Product" },
      { type: "task", id: "t-1", companyId: "co-1", label: "Draft pricing" },
      { type: "agent", id: "a-1", companyId: "co-1", label: "Market Analyst" },
      { type: "goal", id: "g-1", companyId: "co-1", label: "Launch pricing" },
    ],
    edges: [
      {
        id: "rel-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-1" },
        to: { type: "memory_item", id: "i-2" },
        kind: "related_to",
        sourceClass: "semantic",
        editability: "editable",
      },
      {
        id: "dept-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-1" },
        to: { type: "department", id: "d-1" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "readonly",
      },
      {
        id: "task-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-1" },
        to: { type: "task", id: "t-1" },
        kind: "applies_to",
        sourceClass: "derived",
        editability: "append_only",
      },
      {
        id: "agent-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-1" },
        to: { type: "agent", id: "a-1" },
        kind: "created_by",
        sourceClass: "derived",
        editability: "readonly",
      },
      {
        id: "goal-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "i-1" },
        to: { type: "goal", id: "g-1" },
        kind: "applies_to",
        sourceClass: "derived",
        editability: "append_only",
      },
    ],
    ...overrides,
  };
}

describe("LocalGraphPreview", () => {
  it("renders one-hop nodes grouped by edge kind", () => {
    render(<LocalGraphPreview graph={graph()} centerId="i-1" />);

    expect(screen.getByText("Local graph")).toBeInTheDocument();
    expect(screen.getByText("related_to")).toBeInTheDocument();
    expect(screen.getByText("belongs_to")).toBeInTheDocument();
    expect(screen.getByText("applies_to")).toBeInTheDocument();
    expect(screen.getByText("Seat billing")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
  });

  it("collapses high-degree groups behind show more", () => {
    render(<LocalGraphPreview graph={graph()} centerId="i-1" initialVisiblePerGroup={1} />);

    expect(screen.getByText("Draft pricing")).toBeInTheDocument();
    expect(screen.queryByText("Launch pricing")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show 1 more applies_to/i }));

    expect(screen.getByText("Launch pricing")).toBeInTheDocument();
  });

  it("opens memory item nodes as viewer tabs", () => {
    const onOpenMemoryItem = vi.fn();
    render(
      <LocalGraphPreview
        graph={graph()}
        centerId="i-1"
        onOpenMemoryItem={onOpenMemoryItem}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open seat billing/i }));

    expect(onOpenMemoryItem).toHaveBeenCalledWith({ id: "i-2", title: "Seat billing" });
  });
});
