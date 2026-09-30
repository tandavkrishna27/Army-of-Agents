import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import Sigma from "sigma";
import { MemoryGraphViewer } from "../MemoryGraphViewer";

const memoryApiMock = vi.hoisted(() => ({
  companyGraph: vi.fn(async () => ({
    nodes: [
      {
        type: "memory_item",
        id: "mem-1",
        companyId: "co-1",
        label: "Launch plan",
        status: "approved",
        href: "/memory/explore?item=mem-1",
      },
      {
        type: "department",
        id: "dept-1",
        companyId: "co-1",
        label: "Marketing",
        status: "active",
        href: "/memory/explore?dept=dept-1",
      },
      {
        type: "memory_folder",
        id: "folder-overview",
        companyId: "co-1",
        label: "Overview",
        href: "/memory/explore?folder=Marketing%2FOverview",
        metadata: { path: "Marketing/Overview" },
      },
      {
        type: "memory_folder",
        id: "folder-playbooks",
        companyId: "co-1",
        label: "Playbooks",
        href: "/memory/explore?folder=Marketing%2FPlaybooks",
        metadata: { path: "Marketing/Playbooks" },
      },
      {
        type: "memory_folder",
        id: "folder-company",
        companyId: "co-1",
        label: "Company",
        href: "/memory/explore?folder=Company",
        metadata: { path: "Company" },
      },
      {
        type: "memory_folder",
        id: "folder-people",
        companyId: "co-1",
        label: "People",
        href: "/memory/explore?folder=Company%2FPeople",
        metadata: { path: "Company/People" },
      },
      {
        type: "memory_folder",
        id: "folder-roles",
        companyId: "co-1",
        label: "Roles",
        href: "/memory/explore?folder=Company%2FPeople%2FRoles",
        metadata: { path: "Company/People/Roles" },
      },
      {
        type: "memory_folder",
        id: "folder-humans",
        companyId: "co-1",
        label: "Humans",
        href: "/memory/explore?folder=Company%2FPeople%2FHumans",
        metadata: { path: "Company/People/Humans" },
      },
    ],
    edges: [
      {
        id: "edge-1",
        companyId: "co-1",
        from: { type: "memory_item", id: "mem-1" },
        to: { type: "department", id: "dept-1" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "source_row_only",
      },
      {
        id: "edge-folder-1",
        companyId: "co-1",
        from: { type: "memory_folder", id: "folder-overview" },
        to: { type: "department", id: "dept-1" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "source_row_only",
      },
      {
        id: "edge-folder-2",
        companyId: "co-1",
        from: { type: "memory_folder", id: "folder-playbooks" },
        to: { type: "department", id: "dept-1" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "source_row_only",
      },
    ],
    limit: 100,
    truncated: false,
  })),
  neighbors: vi.fn(async () => ({
    center: { id: "mem-1", label: "Launch plan" },
    nodes: [],
    edges: [],
  })),
  usage: vi.fn(async () => ({ agents: [] })),
}));

const sigmaKillMock = vi.hoisted(() => vi.fn());
const sigmaOnMock = vi.hoisted(() => vi.fn());
const sigmaConstructorMock = vi.hoisted(() => vi.fn().mockImplementation(() => ({
  kill: sigmaKillMock,
  on: sigmaOnMock,
})));

vi.mock("sigma", () => ({
  default: sigmaConstructorMock,
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: memoryApiMock,
}));

function renderViewer(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("MemoryGraphViewer", () => {
  it("loads and renders the company graph tab", async () => {
    const onOpenMemoryItem = vi.fn();

    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
        onOpenMemoryItem={onOpenMemoryItem}
      />,
    );

    await waitFor(() =>
      expect(memoryApiMock.companyGraph).toHaveBeenCalledWith("co-1", {
        includeStructural: true,
        limit: 100,
      }),
    );

    expect(await screen.findByTestId("company-graph-sigma-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("company-graph-map-view")).toHaveClass("text-text");
    expect(screen.getByTestId("company-graph-mode-shell")).toHaveClass("overflow-hidden");
    expect(screen.getByText("8 nodes / 3 edges")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(Sigma)).toHaveBeenCalled());
    const sigmaOptions = vi.mocked(Sigma).mock.calls[0]?.[2];
    expect(sigmaOptions).toEqual(
      expect.objectContaining({
        labelColor: { color: expect.any(String) },
        edgeLabelColor: { color: expect.any(String) },
        defaultEdgeColor: "#6f7784",
        defaultDrawNodeHover: expect.any(Function),
        renderLabels: true,
      }),
    );
    expect(sigmaOptions).not.toHaveProperty("nodeReducer");
    expect(sigmaOptions).not.toHaveProperty("edgeReducer");

    fireEvent.click(screen.getByRole("button", { name: "Show graph details" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Launch plan" }));
    expect(onOpenMemoryItem).toHaveBeenCalledWith({
      id: "mem-1",
      title: "Launch plan",
    });
  });

  it("switches between map, network, and cluster graph views", async () => {
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
      />,
    );

    expect(await screen.findByTestId("company-graph-sigma-canvas")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Network view" }));
    expect(screen.getByTestId("company-graph-network-view")).toBeInTheDocument();
    expect(screen.getByTestId("company-graph-network-view")).toHaveClass("h-full");
    expect(screen.getByTestId("company-graph-network-view")).toHaveClass("text-text");
    expect(screen.getByTestId("company-graph-network-svg")).toHaveClass("cursor-grab");

    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));
    expect(screen.getByTestId("company-graph-cluster-view")).toBeInTheDocument();
    expect(screen.getByTestId("company-graph-cluster-view")).toHaveClass("h-full");
    expect(screen.getByTestId("company-graph-cluster-view")).toHaveClass("text-text");
    expect(screen.getByTestId("company-graph-cluster-svg")).toHaveClass("cursor-grab");
    expect(screen.getByTestId("company-graph-cluster-svg")).toHaveTextContent("Marketing");
    expect(
      screen.getByRole("button", { name: "Zoom into Marketing" }).querySelector("circle"),
    ).toHaveAttribute("fill-opacity", "0.16");
    expect(screen.getByText("Marketing").closest('[role="button"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Map view" }));
    expect(screen.getByTestId("company-graph-sigma-canvas")).toBeInTheDocument();
  });

  it("zooms into cluster parents and opens leaf folders", async () => {
    const onOpenGraphNode = vi.fn();
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
        onOpenGraphNode={onOpenGraphNode}
      />,
    );

    await screen.findByTestId("company-graph-sigma-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));
    const clusterSvg = screen.getByTestId("company-graph-cluster-svg");
    const initialViewBox = clusterSvg.getAttribute("viewBox");

    fireEvent.click(screen.getByRole("button", { name: "Zoom into Marketing" }));
    expect(clusterSvg.getAttribute("viewBox")).not.toBe(initialViewBox);
    expect(screen.getByRole("button", { name: "Show full cluster map" })).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Playbooks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Overview" }));
    expect(onOpenGraphNode).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_folder",
        id: "folder-overview",
        href: "/memory/explore?folder=Marketing%2FOverview",
      }),
    );
  });

  it("shows readable labels for major cluster containers and direct folders", async () => {
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
      />,
    );

    await screen.findByTestId("company-graph-sigma-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));

    const clusterSvg = screen.getByTestId("company-graph-cluster-svg");
    expect(clusterSvg).toHaveTextContent("Company");
    expect(clusterSvg).toHaveTextContent("People");
    expect(screen.getByRole("button", { name: "Zoom into Company" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom into People" })).toBeInTheDocument();
  });

  it("reveals nested folder labels after focusing a cluster parent", async () => {
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
      />,
    );

    await screen.findByTestId("company-graph-sigma-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom into People" }));

    expect(screen.getByText("Roles")).toBeInTheDocument();
    expect(screen.getByText("Humans")).toBeInTheDocument();
  });

  it("keeps small cluster nodes identifiable even when their text is hidden", async () => {
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
      />,
    );

    await screen.findByTestId("company-graph-sigma-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));

    expect(screen.getByRole("button", { name: "Open Roles" })).toBeInTheDocument();
  });

  it("shows selected cluster details for small folders", async () => {
    renderViewer(
      <MemoryGraphViewer
        companyId="co-1"
        itemId={null}
      />,
    );

    await screen.findByTestId("company-graph-sigma-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Cluster view" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Open Roles" }));

    expect(screen.getByTestId("company-graph-cluster-selection")).toHaveTextContent("Roles");
  });
});
