import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-pdf", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");

  return {
    Document: ({
      children,
      onLoadSuccess,
    }: {
      children: React.ReactNode;
      onLoadSuccess: (document: { numPages: number }) => void;
    }) => {
      useEffect(() => {
        onLoadSuccess({ numPages: 3 });
      }, [onLoadSuccess]);

      return <div data-testid="react-pdf-document">{children}</div>;
    },
    Page: ({ pageNumber }: { pageNumber: number }) => (
      <div data-testid="react-pdf-page">page {pageNumber}</div>
    ),
    pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  };
});
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockRunsWithOutputs = [
  {
    runId: "run-1",
    status: "completed",
    agentId: "agent-1",
    startedAt: "2026-04-04T10:00:00Z",
    finishedAt: "2026-04-04T10:05:00Z",
    createdAt: "2026-04-04T10:00:00Z",
    invocationSource: "heartbeat",
    usageJson: null,
    resultJson: null,
    detectedOutputs: [
      {
        path: "src/components/Button.tsx",
        filename: "Button.tsx",
        byteSize: 2048,
        contentType: "text/typescript",
        assetId: null,
        sha256: null,
        source: "git_diff",
        status: "pending",
      },
      {
        path: "src/styles/theme.css",
        filename: "theme.css",
        byteSize: 1200,
        contentType: "text/css",
        assetId: null,
        sha256: null,
        source: "workspace_scan",
        status: "pending",
      },
      {
        path: "package.json",
        filename: "package.json",
        byteSize: 800,
        contentType: "application/json",
        assetId: null,
        sha256: null,
        source: "git_diff",
        status: "confirmed",
      },
    ],
  },
];

const mockRunningService = [
  {
    id: "svc-1",
    serviceName: "npm_dev_server",
    status: "running",
    port: 3000,
    url: "http://localhost:3000",
    previewUrl: "/preview/services/svc-1/",
    previewAccess: "local",
    localTargetUrl: "http://localhost:3000/",
    healthStatus: "healthy",
    command: "npm run dev",
    cwd: "/tmp/workspace",
    provider: "local_process",
    lifecycle: "shared",
    startedAt: "2026-04-04T10:00:00Z",
    stoppedAt: null,
  },
];

const mockArtifact = {
  id: "art-1",
  companyId: "comp-1",
  title: "Workspace summary",
  description: null,
  type: "document" as const,
  status: "active" as const,
  currentVersionId: "v-1",
  createdById: "agent-1",
  createdAt: new Date("2026-04-04T10:00:00Z"),
  updatedAt: new Date("2026-04-04T10:00:00Z"),
  versions: [
    {
      id: "v-1",
      artifactId: "art-1",
      versionNumber: 1,
      source: "agent" as const,
      sourceDetail: "Codex",
      changelog: null,
      parentVersionId: null,
      content: "Artifact body",
      fileUrl: null,
      createdAt: new Date("2026-04-04T10:00:00Z"),
    },
  ],
};

// ─── API Mocks ────────────────────────────────────────────────────────────────

const activityApiMock = {
  runsForIssue: vi.fn().mockResolvedValue([]),
};

const artifactsApiMock = {
  getByIssueId: vi.fn().mockResolvedValue(null),
};

const executionWorkspacesApiMock = {
  runtimeServices: vi.fn().mockResolvedValue([]),
};

const heartbeatsApiMock = {
  log: vi.fn().mockResolvedValue({ runId: "", store: "file", logRef: "", content: "" }),
};

const outputDetectionApiMock = {
  listForIssue: vi.fn().mockResolvedValue([]),
};

vi.mock("../api/activity", () => ({
  activityApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (activityApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (artifactsApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (executionWorkspacesApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (heartbeatsApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/output-detection", () => ({
  outputDetectionApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (outputDetectionApiMock as Record<string, unknown>)[prop] },
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// ─── Import after mocks ──────────────────────────────────────────────────────

import { WorkspacePreviewPanel, type WorkspacePreviewTab } from "../components/workspace/WorkspacePreviewPanel";
import { resolveOutputViewer } from "../components/workspace/output-viewer-registry";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspacePreviewPanel — Changes mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders file list for software_development workspaces", async () => {
    activityApiMock.runsForIssue.mockResolvedValue(mockRunsWithOutputs);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="changes"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("changes-view")).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId("changes-file-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("src/components/Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/styles/theme.css")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("3 files changed in this run")).toBeInTheDocument();
  });

  it("shows 'no code changes' for non-software departments", async () => {
    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="changes"
        onModeChange={() => {}}
        functionType="marketing"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("changes-no-code")).toBeInTheDocument();
    });

    expect(screen.getByText("No code changes to display")).toBeInTheDocument();
  });
});

describe("WorkspacePreviewPanel tab deck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders closeable tabs and the active browser tab", () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "browser:svc-1",
        kind: "browser",
        title: "web",
        url: "/preview/services/svc-1/",
        localTargetUrl: "http://localhost:3000/",
      },
      {
        id: "logs:issue-1",
        kind: "logs",
        title: "Logs",
        issueId: "issue-1",
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="browser:svc-1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
      />,
      { wrapper },
    );

    expect(screen.getByTestId("workspace-preview-tabs")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /web/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /logs/i })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("preview-browser-tab")).toBeInTheDocument();
    expect(screen.getByTestId("preview-browser-iframe")).toHaveAttribute("src", "/preview/services/svc-1/");
    expect(screen.getByTestId("preview-browser-local-target")).toHaveTextContent("Local target: http://localhost:3000/");

    fireEvent.click(screen.getByTestId("preview-tab-close-browser:svc-1"));
    expect(onCloseTab).toHaveBeenCalledWith("browser:svc-1");
  });

  it("uses the add-tab button to add a browser tab without opening a picker", () => {
    const onOpenTab = vi.fn();
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "browser:manual:ws-1",
        kind: "browser",
        title: "Browser",
        url: "about:blank",
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="home:issue-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenTab={onOpenTab}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByTestId("preview-tab-add"));

    expect(onOpenTab).toHaveBeenCalledWith("browser");
    expect(screen.queryByTestId("preview-tab-add-menu")).not.toBeInTheDocument();
  });

  it("lists service, artifact, and logs in Viewer Home without a Changes entry", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue(mockRunningService);
    artifactsApiMock.getByIssueId.mockResolvedValue(mockArtifact);
    activityApiMock.runsForIssue.mockResolvedValue(mockRunsWithOutputs);
    const onOpenResolvedTab = vi.fn();

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={[{ id: "home:issue-1", kind: "home", title: "Viewer", issueId: "issue-1" }]}
        activeTabId="home:issue-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenResolvedTab={onOpenResolvedTab}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("viewer-home")).toBeInTheDocument();
      expect(screen.getByTestId("viewer-home-service-svc-1")).toBeInTheDocument();
      expect(screen.getByTestId("viewer-home-artifact-art-1")).toBeInTheDocument();
      expect(screen.getByTestId("viewer-home-logs")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("viewer-home-changes")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("viewer-home-service-svc-1"));
    expect(onOpenResolvedTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "browser",
        id: "browser:svc-1",
        url: "/preview/services/svc-1/",
        localTargetUrl: "http://localhost:3000/",
      }),
    );

    fireEvent.click(screen.getByTestId("viewer-home-artifact-art-1"));
    expect(onOpenResolvedTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "artifact", id: "artifact:art-1:v-1", artifact: mockArtifact }),
    );
  });

  it("lists multiple running preview services in Viewer Home and opens the selected one", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([
      {
        ...mockRunningService[0],
        id: "svc-1",
        serviceName: "web",
        url: "http://localhost:3000",
        previewUrl: "/preview/services/svc-1/",
        localTargetUrl: "http://localhost:3000/",
        healthStatus: "healthy",
      },
      {
        ...mockRunningService[0],
        id: "svc-2",
        serviceName: "docs",
        url: "http://localhost:4173",
        previewUrl: "/preview/services/svc-2/",
        localTargetUrl: "http://localhost:4173/",
        healthStatus: "healthy",
      },
    ]);
    artifactsApiMock.getByIssueId.mockResolvedValue(null);
    outputDetectionApiMock.listForIssue.mockResolvedValue([]);
    activityApiMock.runsForIssue.mockResolvedValue([]);
    const onOpenResolvedTab = vi.fn();

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={[{ id: "home:issue-1", kind: "home", title: "Viewer", issueId: "issue-1" }]}
        activeTabId="home:issue-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenResolvedTab={onOpenResolvedTab}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("viewer-home-service-svc-2")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("viewer-home-service-svc-2"));
    expect(onOpenResolvedTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "browser",
        id: "browser:svc-2",
        url: "/preview/services/svc-2/",
        localTargetUrl: "http://localhost:4173/",
      }),
    );
  });

  it("does not offer unhealthy preview services from Viewer Home", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([
      {
        ...mockRunningService[0],
        id: "svc-unhealthy",
        serviceName: "broken-preview",
        url: "http://localhost:5173",
        previewUrl: "/preview/services/svc-unhealthy/",
        healthStatus: "unhealthy",
      },
    ]);
    artifactsApiMock.getByIssueId.mockResolvedValue(null);
    outputDetectionApiMock.listForIssue.mockResolvedValue([]);
    activityApiMock.runsForIssue.mockResolvedValue([]);

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={[{ id: "home:issue-1", kind: "home", title: "Viewer", issueId: "issue-1" }]}
        activeTabId="home:issue-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByText("No live browser services")).toBeInTheDocument());
    expect(screen.queryByTestId("viewer-home-service-svc-unhealthy")).not.toBeInTheDocument();
  });

  it("opens captured output candidates from Viewer Home as preview tabs", async () => {
    artifactsApiMock.getByIssueId.mockResolvedValue(null);
    outputDetectionApiMock.listForIssue.mockResolvedValue([
      {
        runId: "run-1",
        outputIndex: 0,
        path: "workspace-summary.md",
        filename: "workspace-summary.md",
        byteSize: 512,
        contentType: "text/markdown",
        assetId: "asset-1",
        sha256: null,
        source: "workspace_scan",
        status: "pending",
      },
    ]);
    const onOpenResolvedTab = vi.fn();

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={[{ id: "home:issue-1", kind: "home", title: "Viewer", issueId: "issue-1" }]}
        activeTabId="home:issue-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenResolvedTab={onOpenResolvedTab}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("viewer-home-output-run-1-0")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("viewer-home-output-run-1-0"));

    expect(onOpenResolvedTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "output",
        id: "output:run-1:0",
        title: "workspace-summary.md",
        output: expect.objectContaining({ assetId: "asset-1" }),
      }),
    );
  });

  it("renders captured markdown output tabs by loading and formatting the asset content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("# Workspace summary\n\n- Rendered output body", { status: 200 })),
    );
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "workspace-summary.md",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "workspace-summary.md",
          filename: "workspace-summary.md",
          byteSize: 512,
          contentType: "text/markdown",
          assetId: "asset-1",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("work-product-markdown")).toHaveTextContent("Rendered output body"));
    expect(screen.getByRole("heading", { name: "Workspace summary" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/assets/asset-1/content", { credentials: "include" });
    expect(screen.getAllByText("workspace-summary.md").length).toBeGreaterThan(0);
  });

  it("renders saved markdown artifact versions with the work-product viewer", async () => {
    const artifact = {
      id: "artifact-1",
      companyId: "comp-1",
      title: "Workspace summary.md",
      description: null,
      type: "document" as const,
      status: "active" as const,
      currentVersionId: "version-1",
      createdById: "agent-1",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      updatedAt: new Date("2026-05-28T00:00:00.000Z"),
      versions: [
        {
          id: "version-1",
          artifactId: "artifact-1",
          versionNumber: 1,
          source: "agent" as const,
          sourceDetail: "Codex",
          changelog: "Initial",
          parentVersionId: null,
          content: "# Summary\n\nThis is saved.",
          fileUrl: null,
          createdAt: new Date("2026-05-28T00:00:00.000Z"),
        },
      ],
    };
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "artifact:artifact-1:version-1",
        kind: "artifact",
        title: "Workspace summary.md",
        artifact,
        version: artifact.versions[0],
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="artifact:artifact-1:version-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(await screen.findByTestId("preview-artifact-tab")).toBeInTheDocument();
    expect(screen.getByTestId("work-product-markdown")).toHaveTextContent("This is saved.");
  });

  it("renders empty saved text artifact content without fetching its asset", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("unexpected network body", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const artifact = {
      id: "artifact-1",
      companyId: "comp-1",
      title: "empty-summary.md",
      description: null,
      type: "document" as const,
      status: "active" as const,
      currentVersionId: "version-1",
      createdById: "agent-1",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      updatedAt: new Date("2026-05-28T00:00:00.000Z"),
      versions: [
        {
          id: "version-1",
          artifactId: "artifact-1",
          versionNumber: 1,
          source: "agent" as const,
          sourceDetail: "Codex",
          changelog: "Initial",
          parentVersionId: null,
          content: "",
          fileUrl: "/api/assets/asset-empty/content",
          createdAt: new Date("2026-05-28T00:00:00.000Z"),
        },
      ],
    };
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "artifact:artifact-1:version-1",
        kind: "artifact",
        title: "empty-summary.md",
        artifact,
        version: artifact.versions[0],
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="artifact:artifact-1:version-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(await screen.findByTestId("preview-artifact-tab")).toBeInTheDocument();
    expect(screen.getByTestId("work-product-markdown")).toHaveTextContent("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders saved image artifact versions with the work-product viewer", async () => {
    const artifact = {
      id: "artifact-1",
      companyId: "comp-1",
      title: "Logo.png",
      description: null,
      type: "design" as const,
      status: "active" as const,
      currentVersionId: "version-1",
      createdById: "agent-1",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      updatedAt: new Date("2026-05-28T00:00:00.000Z"),
      versions: [
        {
          id: "version-1",
          artifactId: "artifact-1",
          versionNumber: 1,
          source: "agent" as const,
          sourceDetail: "Codex",
          changelog: "Initial",
          parentVersionId: null,
          content: null,
          fileUrl: "/api/assets/asset-image/content",
          createdAt: new Date("2026-05-28T00:00:00.000Z"),
        },
      ],
    };
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "artifact:artifact-1:version-1",
        kind: "artifact",
        title: "Logo.png",
        artifact,
        version: artifact.versions[0],
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="artifact:artifact-1:version-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(await screen.findByTestId("preview-artifact-tab")).toBeInTheDocument();
    expect(screen.getByTestId("preview-output-image")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Logo.png" })).toHaveAttribute("src", "/api/assets/asset-image/content");
  });

  it("renders captured html output in a sandboxed preview frame with source available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<button>Agent UI</button>", { status: 200 })),
    );
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "interactive.html",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "interactive.html",
          filename: "interactive.html",
          byteSize: 256,
          contentType: "text/html",
          assetId: "asset-html",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    const frame = await screen.findByTestId("work-product-html-frame");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-forms");
    expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-downloads");
    expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
    expect(screen.getByTestId("preview-output-tab")).toHaveTextContent("HTML preview");

    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(screen.getByTestId("work-product-source")).toHaveTextContent("<button>Agent UI</button>");
  });

  it("renders video outputs with native controls", () => {
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "demo.mp4",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "demo.mp4",
          filename: "demo.mp4",
          byteSize: 1024 * 1024,
          contentType: "video/mp4",
          assetId: "asset-video",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByTestId("work-product-video")).toHaveAttribute("controls");
    expect(screen.getByTestId("work-product-video")).toHaveAttribute("src", "/api/assets/asset-video/content");
  });

  it("pretty-prints json outputs with a source view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{\"ok\":true,\"count\":2}", { status: 200 })),
    );
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "result.json",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "result.json",
          filename: "result.json",
          byteSize: 128,
          contentType: "application/json",
          assetId: "asset-json",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("work-product-json")).toHaveTextContent('"ok": true'));
    expect(screen.getByTestId("work-product-json")).toHaveTextContent('"count": 2');
  });

  it("renders declared canvas json as a read-only canvas surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        version: 1,
        width: 800,
        height: 400,
        items: [{ type: "text", x: 20, y: 40, text: "Plan" }],
      }), { status: 200 })),
    );
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "board.aoa-canvas.json",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "board.aoa-canvas.json",
          filename: "board.aoa-canvas.json",
          byteSize: 256,
          contentType: "application/json",
          assetId: "asset-canvas",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("work-product-canvas")).toHaveTextContent("Plan"));
  });

  it("renders graph-shaped canvas json with nodes and edges", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        version: 1,
        nodes: [
          { id: "brief", label: "Brief" },
          { id: "artifact", label: "Artifact" },
          { id: "decision", label: "Decision" },
        ],
        edges: [
          { from: "brief", to: "artifact" },
          { from: "artifact", to: "decision" },
        ],
      }), { status: 200 })),
    );
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "board.aoa-canvas.json",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "board.aoa-canvas.json",
          filename: "board.aoa-canvas.json",
          byteSize: 256,
          contentType: "application/json",
          assetId: "asset-canvas",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("work-product-canvas")).toHaveTextContent("Brief"));
    expect(screen.getByTestId("work-product-canvas")).toHaveTextContent("Artifact");
    expect(screen.getByTestId("work-product-canvas")).toHaveTextContent("Decision");
  });

  it("renders image outputs as images", () => {
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "mock.png",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "mock.png",
          filename: "mock.png",
          byteSize: 4096,
          contentType: "image/png",
          assetId: "asset-image",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByTestId("preview-output-image")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "mock.png" })).toHaveAttribute("src", "/api/assets/asset-image/content");
  });

  it("renders pdf outputs in the shared PDF document viewer", () => {
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "report.pdf",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "report.pdf",
          filename: "report.pdf",
          byteSize: 8192,
          contentType: "application/pdf",
          assetId: "asset-pdf",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    const pdfViewer = screen.getByTestId("pdf-document-viewer");
    expect(pdfViewer).toBeInTheDocument();
    expect(within(pdfViewer).getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", "/api/assets/asset-pdf/content");
    expect(screen.queryByTestId("preview-output-frame")).not.toBeInTheDocument();
  });

  it("does not preview binary output types inline", () => {
    const tabs: WorkspacePreviewTab[] = [
      {
        id: "output:run-1:0",
        kind: "output",
        title: "archive.zip",
        output: {
          runId: "run-1",
          outputIndex: 0,
          path: "archive.zip",
          filename: "archive.zip",
          byteSize: 1024,
          contentType: "application/zip",
          assetId: "asset-zip",
          sha256: null,
          source: "workspace_scan",
          status: "pending",
          runFinishedAt: "2026-04-04T10:05:00Z",
        },
      },
    ];

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={tabs}
        activeTabId="output:run-1:0"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByTestId("preview-output-download")).toHaveTextContent("Preview unavailable");
  });

  it("classifies output viewer capability from content type and filename", () => {
    expect(resolveOutputViewer({ contentType: "text/html", filename: "page.html", assetId: "a1" })).toMatchObject({
      kind: "html_sandbox",
      label: "HTML preview",
      canOpenDirectly: true,
      shouldExecuteInBrowser: false,
      canShowSource: true,
    });
    expect(resolveOutputViewer({ contentType: "image/png", filename: "mock.png", assetId: "a1" })).toMatchObject({
      kind: "image",
      label: "Image preview",
    });
    expect(resolveOutputViewer({ contentType: "application/pdf", filename: "report.pdf", assetId: "a1" })).toMatchObject({
      kind: "pdf",
      label: "PDF preview",
    });
    expect(resolveOutputViewer({ contentType: "video/mp4", filename: "demo.mp4", assetId: "a1" })).toMatchObject({
      kind: "video",
      label: "Video preview",
    });
    expect(resolveOutputViewer({ contentType: "application/zip", filename: "archive.zip", assetId: "a1" })).toMatchObject({
      kind: "download",
      label: "Open externally",
    });
  });

  it("shows a useful manual browser start surface with URL entry and service shortcuts", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue(mockRunningService);

    render(
      <WorkspacePreviewPanel
        companyId="comp-1"
        tabs={[{ id: "browser:manual:ws-1", kind: "browser", title: "Browser", url: "about:blank" }]}
        activeTabId="browser:manual:ws-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    expect(screen.getByTestId("preview-browser-url-input")).toHaveValue("");
    await waitFor(() => expect(screen.getByTestId("preview-browser-service-svc-1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("preview-browser-service-svc-1"));
    expect(screen.getByTestId("preview-browser-iframe")).toHaveAttribute("src", "/preview/services/svc-1/");
    expect(screen.getByTestId("preview-browser-url-input")).toHaveValue("/preview/services/svc-1/");
    expect(screen.getByTestId("preview-browser-local-target")).toHaveTextContent("Local target: http://localhost:3000/");
  });
});

describe("WorkspacePreviewPanel — Preview mode (dev server)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows iframe when dev server URL is available", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue(mockRunningService);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="preview"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-devserver")).toBeInTheDocument();
    });

    const iframe = screen.getByTestId("preview-iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("/preview/services/svc-1/");
    expect(screen.getByText("/preview/services/svc-1/")).toBeInTheDocument();
    expect(screen.getByTestId("preview-refresh")).toBeInTheDocument();
  });

  it("shows 'no dev server' when none running", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([]);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="preview"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-no-devserver")).toBeInTheDocument();
    });

    expect(screen.getByText("No dev server running")).toBeInTheDocument();
  });

  it("renders a mode-preview artifact through the shared viewer, not a raw <pre> (P3.5)", async () => {
    // Discriminator for the consolidation: mode-preview used to hand-roll img/<pre>/download
    // (testid `preview-text`). It must now route through resolveOutputViewer -> WorkProductViewer
    // -> SharedContentViewer exactly like the tabbed view, so markdown renders richly.
    const markdownArtifact = {
      ...mockArtifact,
      id: "art-md",
      title: "notes.md",
      currentVersionId: "v-md",
      versions: [
        {
          ...mockArtifact.versions[0],
          id: "v-md",
          artifactId: "art-md",
          content: "# Heading\n\nrendered body",
        },
      ],
    };
    artifactsApiMock.getByIssueId.mockResolvedValue(markdownArtifact);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="preview"
        onModeChange={() => {}}
        functionType="design"
      />,
      { wrapper },
    );

    // Shared viewer rendered the markdown (old code would have shown the literal "# Heading").
    await waitFor(() => {
      expect(screen.getByTestId("work-product-markdown")).toHaveTextContent("rendered body");
    });
    expect(screen.getByTestId("preview-artifact")).toBeInTheDocument();
    // The divergent hand-rolled raw-<pre> path is gone.
    expect(screen.queryByTestId("preview-text")).not.toBeInTheDocument();
  });
});
