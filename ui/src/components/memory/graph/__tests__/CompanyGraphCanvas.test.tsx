import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompanyBrainOverviewResponse } from "@armyofagents/shared";
import { CompanyGraphCanvas } from "../CompanyGraphCanvas";

const sigmaKillMock = vi.hoisted(() => vi.fn());
const sigmaOnMock = vi.hoisted(() => vi.fn());

vi.mock("sigma", () => ({
  default: vi.fn().mockImplementation(() => ({
    kill: sigmaKillMock,
    on: sigmaOnMock,
  })),
}));

function graph(overrides: Partial<CompanyBrainOverviewResponse> = {}): CompanyBrainOverviewResponse {
  return {
    nodes: [
      {
        type: "memory_item",
        id: "mem-1",
        companyId: "co-1",
        label: "Pricing policy",
        status: "approved",
        href: "/memory/explore?item=mem-1",
      },
      {
        type: "memory_item",
        id: "mem-2",
        companyId: "co-1",
        label: "Seat billing",
        status: "approved",
        href: "/memory/explore?item=mem-2",
      },
      {
        type: "department",
        id: "dept-1",
        companyId: "co-1",
        label: "Product",
        status: "active",
        href: "/memory/explore?dept=dept-1",
      },
    ],
    edges: [
      {
        id: "edge-supports",
        companyId: "co-1",
        from: { type: "memory_item", id: "mem-1" },
        to: { type: "memory_item", id: "mem-2" },
        kind: "supports",
        sourceClass: "semantic",
        editability: "editable",
      },
      {
        id: "edge-dept",
        companyId: "co-1",
        from: { type: "memory_item", id: "mem-1" },
        to: { type: "department", id: "dept-1" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "source_row_only",
      },
    ],
    limit: 100,
    truncated: false,
    ...overrides,
  };
}

describe("CompanyGraphCanvas", () => {
  it("renders an empty graph state", () => {
    render(<CompanyGraphCanvas graph={{ nodes: [], edges: [], limit: 100, truncated: false }} />);

    expect(screen.getByText("No visible graph relationships yet")).toBeInTheDocument();
  });

  it("renders graph counts and node labels", () => {
    render(<CompanyGraphCanvas graph={graph()} />);

    expect(screen.getByText("3 nodes / 2 edges")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show graph details" }));
    expect(screen.getByRole("button", { name: "Select Pricing policy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Seat billing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Product" })).toBeInTheDocument();
  });

  it("opens memory item nodes from the details panel", () => {
    const onOpenMemoryItem = vi.fn();
    render(<CompanyGraphCanvas graph={graph()} onOpenMemoryItem={onOpenMemoryItem} />);

    fireEvent.click(screen.getByRole("button", { name: "Show graph details" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Pricing policy" }));

    expect(onOpenMemoryItem).toHaveBeenCalledWith({ id: "mem-1", title: "Pricing policy" });
  });

  it("opens graph nodes from the map click handler", async () => {
    const onOpenGraphNode = vi.fn();
    render(<CompanyGraphCanvas graph={graph()} onOpenGraphNode={onOpenGraphNode} />);

    await waitFor(() => {
      expect(sigmaOnMock.mock.calls.find(([event]) => event === "clickNode")?.[1]).toBeTypeOf("function");
    });
    const clickNodeHandler = sigmaOnMock.mock.calls.find(([event]) => event === "clickNode")?.[1];

    act(() => {
      clickNodeHandler({ node: "department:dept-1" });
    });

    expect(onOpenGraphNode).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "department",
        id: "dept-1",
        href: "/memory/explore?dept=dept-1",
      }),
    );
  });

  it("uses a full-width map shell with an optional inspector drawer", () => {
    render(<CompanyGraphCanvas graph={graph()} />);

    expect(screen.getByTestId("company-graph-map-view")).not.toHaveClass("xl:grid-cols-[minmax(0,1fr)_260px]");
    expect(screen.getByRole("button", { name: "Show graph details" })).toBeInTheDocument();
  });

  it("shows connected relations for the selected node", () => {
    render(<CompanyGraphCanvas graph={graph()} />);

    fireEvent.click(screen.getByRole("button", { name: "Show graph details" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Pricing policy" }));

    expect(screen.getByTestId("company-graph-selected-node")).toHaveTextContent("Pricing policy");
    expect(screen.getByRole("button", { name: "Relationships" })).toBeInTheDocument();
    expect(screen.getByText("Supports Seat billing")).toBeInTheDocument();
    expect(screen.getByText("Belongs to Product")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Relationships" }));
    expect(screen.queryByText("Supports Seat billing")).not.toBeInTheDocument();
  });
});
