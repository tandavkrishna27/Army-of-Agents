import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabBodySwitch } from "./CommanderViewerPanel";
import type { ViewerTab } from "./commanderViewerModel";

// SharedContentViewer renders real content viewers (some fetch) — stub it so the
// asset/artifact branches are observable without hitting the network.
vi.mock("@/components/viewers/SharedContentViewer", () => ({
  SharedContentViewer: ({ viewer, filename }: { viewer: { kind: string }; filename: string }) => (
    <div data-testid="shared-content-viewer" data-kind={viewer.kind} data-filename={filename} />
  ),
}));

const getMeta = vi.fn();
const getOutput = vi.fn();
const getMemory = vi.fn();
const getArtifact = vi.fn();

vi.mock("@/api/assets", () => ({ assetsApi: { getMeta: (...a: unknown[]) => getMeta(...a) } }));
vi.mock("@/api/task-outputs", () => ({ taskOutputsApi: { get: (...a: unknown[]) => getOutput(...a) } }));
vi.mock("@/api/memory", () => ({ memoryApi: { get: (...a: unknown[]) => getMemory(...a) } }));
vi.mock("@/api/artifacts", () => ({ artifactsApi: { get: (...a: unknown[]) => getArtifact(...a) } }));

const markdownAsset = {
  id: "as-1",
  originalFilename: "plan.md",
  contentType: "text/markdown",
  byteSize: 42,
  createdAt: "2026-07-19T00:00:00.000Z",
};

function output(overrides: Record<string, unknown> = {}) {
  return {
    id: "out-1",
    companyId: "comp-1",
    projectId: null,
    issueId: "issue-1",
    type: "detected_file",
    provider: "workspace",
    externalId: null,
    artifactId: null,
    artifactVersionId: null,
    assetId: null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    url: null,
    title: "Output",
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "ready",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function renderTab(activeTab: ViewerTab) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TabBodySwitch
        activeId={activeTab.id}
        activeTab={activeTab}
        companyId="comp-1"
        conversationRefs={[]}
        onOpen={vi.fn()}
        onCloseTab={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

const assetTab: ViewerTab = { id: "asset:as-1", kind: "asset", title: "plan.md", refId: "as-1" };
const outputTab: ViewerTab = { id: "output:out-1", kind: "output", title: "Output", refId: "out-1" };
const memoryTab: ViewerTab = { id: "memory_item:m-1", kind: "memory_item", title: "Prefer TS", refId: "m-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssetRefTabBody", () => {
  it("resolves a viewer from asset meta and renders SharedContentViewer (no src prop)", async () => {
    getMeta.mockResolvedValue(markdownAsset);
    renderTab(assetTab);
    const el = await screen.findByTestId("shared-content-viewer");
    expect(el).toHaveAttribute("data-kind", "markdown");
    expect(el).toHaveAttribute("data-filename", "plan.md");
    expect(getMeta).toHaveBeenCalledWith("as-1");
  });

  it("shows the loading body while the meta query is pending", () => {
    getMeta.mockReturnValue(new Promise(() => {}));
    renderTab(assetTab);
    expect(screen.getByTestId("commander-viewer-loading")).toBeInTheDocument();
  });

  it("shows a friendly not-available message on 404 (deleted/inaccessible)", async () => {
    getMeta.mockRejectedValue(new Error("404 Asset not found"));
    renderTab(assetTab);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it("shows a friendly not-available message on 403 (cross-company)", async () => {
    getMeta.mockRejectedValue(new Error("403 Forbidden"));
    renderTab(assetTab);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });
});

describe("OutputRefTabBody branches", () => {
  it("artifact-version output → renders the artifact viewer via artifactId", async () => {
    getOutput.mockResolvedValue(
      output({ type: "artifact_version", artifactId: "art-1", artifactVersionId: "ver-1" }),
    );
    getArtifact.mockResolvedValue({
      id: "art-1",
      title: "Spec",
      versions: [{ id: "ver-1", assetId: "as-9", content: null }],
    });
    renderTab(outputTab);
    expect(await screen.findByTestId("shared-content-viewer")).toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith("art-1");
  });

  it("asset-backed output → resolves the asset content viewer", async () => {
    getOutput.mockResolvedValue(output({ type: "detected_file", assetId: "as-1" }));
    getMeta.mockResolvedValue(markdownAsset);
    renderTab(outputTab);
    expect(await screen.findByTestId("shared-content-viewer")).toBeInTheDocument();
    expect(getMeta).toHaveBeenCalledWith("as-1");
  });

  it("url output → scheme-gated external link card", async () => {
    getOutput.mockResolvedValue(
      output({ type: "preview_url", url: "https://preview.example.test", title: "Live preview" }),
    );
    renderTab(outputTab);
    expect(await screen.findByTestId("commander-output-ref-link")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open link" });
    expect(link).toHaveAttribute("href", "https://preview.example.test");
  });

  it("url output with an unsafe scheme → no link, blocked message", async () => {
    getOutput.mockResolvedValue(output({ type: "external_link", url: "javascript:alert(1)" }));
    renderTab(outputTab);
    expect(await screen.findByTestId("commander-output-ref-link")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open link" })).not.toBeInTheDocument();
    expect(screen.getByText(/unsupported scheme/i)).toBeInTheDocument();
  });

  it("non-content output → compact detail card", async () => {
    getOutput.mockResolvedValue(output({ type: "branch", title: "feature/x", provider: "git" }));
    renderTab(outputTab);
    expect(await screen.findByTestId("commander-output-ref-body")).toBeInTheDocument();
    expect(screen.getByText("feature/x")).toBeInTheDocument();
    expect(screen.getByText(/No preview is available/i)).toBeInTheDocument();
  });

  it("shows the loading body while the output query is pending", () => {
    getOutput.mockReturnValue(new Promise(() => {}));
    renderTab(outputTab);
    expect(screen.getByTestId("commander-viewer-loading")).toBeInTheDocument();
  });

  it("shows a friendly not-available message on 404", async () => {
    getOutput.mockRejectedValue(new Error("404 Task output not found"));
    renderTab(outputTab);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });
});

describe("MemoryItemRefTabBody", () => {
  it("renders the memory layer/category/status + content", async () => {
    getMemory.mockResolvedValue({
      id: "m-1",
      title: "Prefer TypeScript",
      content: "Use TypeScript for all new services.",
      category: "decision",
      status: "approved",
      layer: "domain",
      tags: ["eng"],
    });
    renderTab(memoryTab);
    expect(await screen.findByTestId("commander-memory-ref-body")).toBeInTheDocument();
    expect(screen.getByText("Prefer TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Use TypeScript for all new services.")).toBeInTheDocument();
    expect(screen.getByText(/domain · decision · approved/)).toBeInTheDocument();
    expect(getMemory).toHaveBeenCalledWith("comp-1", "m-1");
  });

  it("shows the loading body while the memory query is pending", () => {
    getMemory.mockReturnValue(new Promise(() => {}));
    renderTab(memoryTab);
    expect(screen.getByTestId("commander-viewer-loading")).toBeInTheDocument();
  });

  it("shows a friendly not-available message on 404", async () => {
    getMemory.mockRejectedValue(new Error("404 Memory item not found"));
    renderTab(memoryTab);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });
});
