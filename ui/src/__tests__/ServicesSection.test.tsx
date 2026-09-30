import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServicesSection } from "../components/workspace/sections/ServicesSection";

// ─── API Mocks ───────────────────────────────────────────────────────────────

const executionWorkspacesApiMock = {
  runtimeServices: vi.fn(),
  controlRuntimeServices: vi.fn(),
};
let canControlRuntimeServices = true;

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy(
    {},
    { get: (_t, prop) => (executionWorkspacesApiMock as Record<string, unknown>)[prop as string] },
  ),
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => ({
    canControlRuntimeServices,
  }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const runningService = {
  id: "svc-1",
  serviceName: "web-dev-server",
  status: "running",
  port: 3000,
  url: "http://localhost:3000",
  previewUrl: "/preview/services/svc-1/",
  previewAccess: "local",
  localTargetUrl: "http://localhost:3000/",
  healthStatus: "healthy",
  command: "pnpm dev",
  cwd: "/home/agent/workspace",
  provider: "local_process",
  lifecycle: "shared",
  startedAt: new Date().toISOString(),
  stoppedAt: null,
};

const previewOnlyService = {
  ...runningService,
  id: "svc-preview",
  serviceName: "localhost:4173",
  port: 4173,
  url: "http://127.0.0.1:4173/",
  previewUrl: "/preview/services/svc-preview/",
  localTargetUrl: "http://127.0.0.1:4173/",
  command: null,
  provider: "adapter_managed",
  providerRef: null,
  lifecycle: "ephemeral",
  healthStatus: "healthy",
};

const unavailablePreviewService = {
  ...previewOnlyService,
  id: "svc-preview-stopped",
  status: "stopped",
  healthStatus: "unhealthy",
  stoppedAt: new Date().toISOString(),
};

const unhealthyRunningPreviewService = {
  ...previewOnlyService,
  id: "svc-preview-unhealthy",
  status: "running",
  healthStatus: "unhealthy",
};

const stoppedService = {
  ...runningService,
  id: "svc-2",
  serviceName: "api-server",
  status: "stopped",
  port: 8080,
  url: null,
};

const failedService = {
  ...runningService,
  id: "svc-3",
  serviceName: "worker",
  status: "failed",
  port: null,
  url: null,
};

const startingService = {
  ...runningService,
  id: "svc-4",
  serviceName: "migrator",
  status: "starting",
  port: null,
  url: null,
};

const mockWorkspace = {
  id: "ws-1",
  companyId: "comp-1",
  projectId: "proj-1",
  projectWorkspaceId: null,
  sourceIssueId: "issue-1",
  mode: "isolated_workspace" as const,
  strategyType: "git_worktree" as const,
  name: "ws-1",
  status: "active" as const,
  cwd: "/home/agent/workspace",
  repoUrl: null,
  branchName: "feat",
  baseRef: "main",
  providerType: "git_worktree" as const,
  providerRef: null,
  derivedFromExecutionWorkspaceId: null,
  lastUsedAt: new Date(),
  openedAt: new Date(),
  closedAt: null,
  cleanupEligibleAt: null,
  cleanupReason: null,
  config: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderSection(options: { onOpenBrowser?: (service: any) => void } = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return {
    ...render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ServicesSection workspace={mockWorkspace as any} onOpenBrowser={options.onOpenBrowser} />
      </QueryClientProvider>,
    ),
    queryClient: qc,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  canControlRuntimeServices = true;
});

describe("ServicesSection", () => {
  it("renders loading skeleton while query is pending", () => {
    // Never-resolving promise -> stays in pending state
    executionWorkspacesApiMock.runtimeServices.mockReturnValue(new Promise(() => {}));

    renderSection();

    const body = screen.getByTestId("section-services-body");
    expect(body).toBeInTheDocument();
    // Should contain skeleton elements
    expect(body.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("shows empty state when no services are configured", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("No app previews")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Agent-created localhost apps will appear here."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("section-services-body").className).toContain("py-2");
  });

  it("renders a running service row with name, port, and host-local debug target", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("service-row-svc-1")).toBeInTheDocument();
    });
    expect(screen.getByText("web-dev-server")).toBeInTheDocument();
    expect(screen.getByText(":3000")).toBeInTheDocument();
    const localTarget = screen.getByTestId("service-local-target-svc-1");
    expect(localTarget).toHaveTextContent("Local to AoA host");
    expect(localTarget).toHaveTextContent("http://localhost:3000/");
    expect(screen.queryByTestId("service-url-svc-1")).not.toBeInTheDocument();
  });

  it("running service shows Stop + Restart buttons (not Start)", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("service-stop-svc-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("service-restart-svc-1")).toBeInTheDocument();
    expect(screen.queryByTestId("service-start-svc-1")).not.toBeInTheDocument();
  });

  it("hides local process controls when the current user cannot control runtime services", async () => {
    canControlRuntimeServices = false;
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("service-row-svc-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("service-open-svc-1")).toBeInTheDocument();
    expect(screen.queryByTestId("service-stop-svc-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-restart-svc-1")).not.toBeInTheDocument();
  });

  it("preview-only adapter-managed service shows Open but no process controls", async () => {
    const user = userEvent.setup();
    const onOpenBrowser = vi.fn();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([previewOnlyService]);

    renderSection({ onOpenBrowser });

    const row = await screen.findByTestId("service-row-svc-preview");
    expect(row).toHaveTextContent("Preview");
    expect(screen.getByTestId("service-open-svc-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("service-stop-svc-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-restart-svc-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-start-svc-preview")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("service-open-svc-preview"));
    expect(onOpenBrowser).toHaveBeenCalledWith(previewOnlyService);
  });

  it("does not offer Open when a service has no AoA preview URL", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([{
      ...runningService,
      id: "svc-local-only",
      previewUrl: null,
      localTargetUrl: "http://localhost:3000/",
    }]);

    renderSection();

    await screen.findByTestId("service-row-svc-local-only");
    expect(screen.queryByTestId("service-open-svc-local-only")).not.toBeInTheDocument();
    expect(screen.getByTestId("service-local-target-svc-local-only")).toHaveTextContent("Local to AoA host");
  });

  it("keeps unavailable preview-only services out of the primary service rows", async () => {
    const onOpenBrowser = vi.fn();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([unavailablePreviewService]);

    renderSection({ onOpenBrowser });

    expect(await screen.findByText("No running app previews")).toBeInTheDocument();
    expect(screen.getByTestId("service-stopped-preview-summary")).toHaveTextContent("1 stopped preview");
    expect(screen.queryByTestId("service-row-svc-preview-stopped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-open-svc-preview-stopped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-stop-svc-preview-stopped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-restart-svc-preview-stopped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-start-svc-preview-stopped")).not.toBeInTheDocument();
  });

  it("keeps unhealthy preview-only services out of the primary service rows", async () => {
    const onOpenBrowser = vi.fn();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([unhealthyRunningPreviewService]);

    renderSection({ onOpenBrowser });

    expect(await screen.findByText("No running app previews")).toBeInTheDocument();
    expect(screen.getByTestId("service-stopped-preview-summary")).toHaveTextContent("1 stopped preview");
    expect(screen.queryByTestId("service-row-svc-preview-unhealthy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-open-svc-preview-unhealthy")).not.toBeInTheDocument();
  });

  it("shows running services first and summarizes stopped detected previews quietly", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([
      runningService,
      { ...unavailablePreviewService, id: "svc-preview-stopped-a" },
      { ...unavailablePreviewService, id: "svc-preview-stopped-b" },
    ]);

    renderSection();

    expect(await screen.findByTestId("service-row-svc-1")).toBeInTheDocument();
    expect(screen.getByTestId("service-stopped-preview-summary")).toHaveTextContent("2 stopped previews");
    expect(screen.queryByTestId("service-row-svc-preview-stopped-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-row-svc-preview-stopped-b")).not.toBeInTheDocument();
  });

  it("stopped service shows Start button only (not Stop/Restart)", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([stoppedService]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("service-start-svc-2")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("service-stop-svc-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-restart-svc-2")).not.toBeInTheDocument();
  });

  it("failed service shows Start button (allowing retry)", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([failedService]);

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("service-start-svc-3")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("service-stop-svc-3")).not.toBeInTheDocument();
  });

  it("clicking Start calls controlRuntimeServices with 'start' action and correct target", async () => {
    const user = userEvent.setup();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([stoppedService]);
    executionWorkspacesApiMock.controlRuntimeServices.mockResolvedValue({
      workspace: mockWorkspace,
      runtimeServiceCount: 1,
      stdout: "",
      stderr: "",
    });

    renderSection();

    const startButton = await screen.findByTestId("service-start-svc-2");
    await user.click(startButton);

    await waitFor(() => {
      expect(executionWorkspacesApiMock.controlRuntimeServices).toHaveBeenCalledWith(
        "ws-1",
        "start",
        { runtimeServiceId: "svc-2" },
      );
    });
  });

  it("clicking Stop calls controlRuntimeServices with 'stop' action and correct target", async () => {
    const user = userEvent.setup();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);
    executionWorkspacesApiMock.controlRuntimeServices.mockResolvedValue({
      workspace: mockWorkspace,
      runtimeServiceCount: 1,
      stdout: "",
      stderr: "",
    });

    renderSection();

    const stopButton = await screen.findByTestId("service-stop-svc-1");
    await user.click(stopButton);

    await waitFor(() => {
      expect(executionWorkspacesApiMock.controlRuntimeServices).toHaveBeenCalledWith(
        "ws-1",
        "stop",
        { runtimeServiceId: "svc-1" },
      );
    });
  });

  it("clicking Restart calls controlRuntimeServices with 'restart' action and correct target", async () => {
    const user = userEvent.setup();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);
    executionWorkspacesApiMock.controlRuntimeServices.mockResolvedValue({
      workspace: mockWorkspace,
      runtimeServiceCount: 1,
      stdout: "",
      stderr: "",
    });

    renderSection();

    const restartButton = await screen.findByTestId("service-restart-svc-1");
    await user.click(restartButton);

    await waitFor(() => {
      expect(executionWorkspacesApiMock.controlRuntimeServices).toHaveBeenCalledWith(
        "ws-1",
        "restart",
        { runtimeServiceId: "svc-1" },
      );
    });
  });

  it("disables buttons while mutation is pending", async () => {
    const user = userEvent.setup();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);
    // Never-resolving mutation promise so the pending state sticks
    executionWorkspacesApiMock.controlRuntimeServices.mockReturnValue(new Promise(() => {}));

    renderSection();

    const stopButton = await screen.findByTestId("service-stop-svc-1");
    const restartButton = screen.getByTestId("service-restart-svc-1");

    await user.click(stopButton);

    await waitFor(() => {
      expect(stopButton).toBeDisabled();
    });
    expect(restartButton).toBeDisabled();
  });

  it("successful mutation invalidates runtime-services query (triggers refetch)", async () => {
    const user = userEvent.setup();
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([stoppedService]);
    executionWorkspacesApiMock.controlRuntimeServices.mockResolvedValue({
      workspace: mockWorkspace,
      runtimeServiceCount: 1,
      stdout: "",
      stderr: "",
    });

    renderSection();

    // Wait for initial fetch
    await screen.findByTestId("service-start-svc-2");
    const initialCallCount = executionWorkspacesApiMock.runtimeServices.mock.calls.length;

    const startButton = screen.getByTestId("service-start-svc-2");
    await user.click(startButton);

    // After success, invalidation should trigger a refetch
    await waitFor(() => {
      expect(executionWorkspacesApiMock.runtimeServices.mock.calls.length).toBeGreaterThan(
        initialCallCount,
      );
    });
  });

  it("raw local target is displayed as debug text rather than an external link", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([runningService]);

    renderSection();

    const localTarget = await screen.findByTestId("service-local-target-svc-1");
    expect(localTarget.tagName.toLowerCase()).toBe("div");
    expect(localTarget).toHaveTextContent("Local to AoA host");
    expect(screen.queryByTestId("service-url-svc-1")).not.toBeInTheDocument();
  });

  it("starting service shows disabled Stop button", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([startingService]);

    renderSection();

    const stopButton = await screen.findByTestId("service-stop-svc-4");
    expect(stopButton).toBeInTheDocument();
    expect(stopButton).toBeDisabled();
    expect(screen.queryByTestId("service-start-svc-4")).not.toBeInTheDocument();
    expect(screen.queryByTestId("service-restart-svc-4")).not.toBeInTheDocument();
  });

  it("handles concurrent mutations on different services correctly", async () => {
    const user = userEvent.setup();
    const stoppedA = { ...stoppedService, id: "svc-A", serviceName: "api-A" };
    const stoppedB = { ...stoppedService, id: "svc-B", serviceName: "api-B" };
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([stoppedA, stoppedB]);

    let resolveA: (v: unknown) => void;
    let resolveB: (v: unknown) => void;
    const pA = new Promise((r) => {
      resolveA = r;
    });
    const pB = new Promise((r) => {
      resolveB = r;
    });
    executionWorkspacesApiMock.controlRuntimeServices
      .mockImplementationOnce(() => pA)
      .mockImplementationOnce(() => pB);

    renderSection();

    const startA = await screen.findByTestId("service-start-svc-A");
    const startB = await screen.findByTestId("service-start-svc-B");

    await user.click(startA);
    await user.click(startB);

    // Both start buttons should be disabled (pending)
    expect(screen.getByTestId("service-start-svc-A")).toBeDisabled();
    expect(screen.getByTestId("service-start-svc-B")).toBeDisabled();

    // Resolve in reverse order — B first, then A
    resolveB!({ workspace: mockWorkspace, runtimeServiceCount: 2, stdout: "", stderr: "" });
    await waitFor(() => {
      expect(screen.getByTestId("service-start-svc-B")).not.toBeDisabled();
    });

    resolveA!({ workspace: mockWorkspace, runtimeServiceCount: 2, stdout: "", stderr: "" });
    await waitFor(() => {
      expect(screen.getByTestId("service-start-svc-A")).not.toBeDisabled();
    });

    expect(executionWorkspacesApiMock.controlRuntimeServices).toHaveBeenCalledTimes(2);
  });
});
