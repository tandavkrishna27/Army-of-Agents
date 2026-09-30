// ui/src/__tests__/transcript/StructuredRunBlock.test.tsx

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { StructuredRunBlock } from "../../components/workspace/transcript";

const { logMock, parseStdoutLineMock } = vi.hoisted(() => ({
  logMock: vi.fn(),
  parseStdoutLineMock: vi.fn(),
}));

// Mock heartbeatsApi
vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    log: logMock,
  },
}));

vi.mock("../../adapters/registry", () => ({
  getUIAdapter: () => ({
    parseStdoutLine: parseStdoutLineMock,
  }),
}));

// Import mocked module
import { heartbeatsApi } from "../../api/heartbeats";

function ndjsonLine(stream: "stdout" | "stderr" | "system", chunk: string, ts = "2026-01-01T00:00:00Z") {
  return JSON.stringify({ ts, stream, chunk });
}

function renderComponent(props: Partial<React.ComponentProps<typeof StructuredRunBlock>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StructuredRunBlock
          runId="test-run-1"
          adapterType="claude_local"
          departmentType="software_development"
          isRunning={false}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

describe("StructuredRunBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseStdoutLineMock.mockImplementation((line: string, ts: string) => {
      try {
        const parsed = JSON.parse(line);
        return [{ ts, ...parsed }];
      } catch {
        return [];
      }
    });
  });

  it("shows loading state initially", () => {
    (heartbeatsApi.log as any).mockReturnValue(new Promise(() => {})); // never resolves
    renderComponent();
    expect(screen.getByText("Loading run output...")).toBeTruthy();
  });

  it("shows empty state for run with no output", async () => {
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "", logRef: "", content: "" });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText("No output recorded.")).toBeTruthy();
    });
  });

  it("shows waiting state for running run with no output", async () => {
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "", logRef: "", content: "" });
    renderComponent({ isRunning: true });
    await waitFor(() => {
      expect(screen.getByText("Waiting for output...")).toBeTruthy();
    });
  });

  it("renders known stderr noise as quiet diagnostics instead of red stderr", async () => {
    const content = [
      JSON.stringify({
        ts: "2026-01-01T00:00:00Z",
        stream: "stderr",
        chunk: "WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt",
      }),
    ].join("\n");
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent();

    expect(await screen.findByText("Diagnostics (1 line)")).toBeTruthy();
    expect(screen.queryByText(/stderr/i)).toBeNull();
  });

  it("renders app preview detection summaries as quiet diagnostics", async () => {
    const content = [
      JSON.stringify({
        ts: "2026-01-01T00:00:00Z",
        stream: "stderr",
        chunk: "[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      }),
    ].join("\n");
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent();

    expect(await screen.findByText("Diagnostics (1 line)")).toBeTruthy();
    expect(screen.queryByText("Error details (1 line)")).toBeNull();
  });

  it("renders app preview detection system logs as info events", async () => {
    const content = [
      JSON.stringify({
        ts: "2026-01-01T00:00:00Z",
        stream: "system",
        chunk: "[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      }),
    ].join("\n");
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent();

    expect(await screen.findByText("preview")).toBeTruthy();
    expect(screen.getByText("App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)")).toBeTruthy();
    expect(screen.queryByText("Error details (1 line)")).toBeNull();
  });

  it("labels real stderr as error details", async () => {
    const content = JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      stream: "stderr",
      chunk: "ERROR tool failed",
    });
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent();

    expect(await screen.findByText("Error details (1 line)")).toBeTruthy();
  });

  it("shows starting state and does not poll logs before a running run has a log handle", async () => {
    renderComponent({ isRunning: true, runLogAvailable: false });

    expect(screen.getByText("Starting agent...")).toBeTruthy();
    expect(heartbeatsApi.log).not.toHaveBeenCalled();
  });

  it("keeps hook order stable when a run gains its log handle after starting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const content = ndjsonLine(
      "stdout",
      `${JSON.stringify({ kind: "message", role: "assistant", text: "Now writing output." })}\n`,
    );
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    const { rerender, queryClient } = renderComponent({ isRunning: true, runLogAvailable: false });
    expect(screen.getByText("Starting agent...")).toBeTruthy();

    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <StructuredRunBlock
            runId="test-run-1"
            adapterType="claude_local"
            departmentType="software_development"
            isRunning
            runLogAvailable
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Raw output")).toBeTruthy();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Rendered more hooks than during the previous render"));
    errorSpy.mockRestore();
  });

  it("shows output unavailable when a completed run has no log handle", () => {
    renderComponent({ runLogAvailable: false });

    expect(screen.getByText("Output unavailable.")).toBeTruthy();
    expect(heartbeatsApi.log).not.toHaveBeenCalled();
  });

  it("shows a current-step row while a run is editing files", async () => {
    const entries = [
      { kind: "tool_call", name: "Edit", input: { file_path: "src/a.ts" } },
      { kind: "tool_result", toolUseId: "edit-a", content: "+2 -0", isError: false },
      { kind: "tool_call", name: "Edit", input: { file_path: "src/b.ts" } },
    ];
    const content = entries
      .map((entry, index) => ndjsonLine("stdout", `${JSON.stringify(entry)}\n`, `2026-01-01T00:00:0${index}Z`))
      .join("\n");
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent({ isRunning: true });

    expect(await screen.findByText("Editing 2 files")).toBeTruthy();
    expect(screen.getByText("2 files edited")).toBeTruthy();
  });

  it("shows compact evidence summary for completed command output", async () => {
    const entries = [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test:run" } },
      { kind: "tool_result", toolUseId: "cmd-1", content: "passed", isError: false },
    ];
    const content = entries
      .map((entry, index) => ndjsonLine("stdout", `${JSON.stringify(entry)}\n`, `2026-01-01T00:00:0${index}Z`))
      .join("\n");
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content });

    renderComponent();

    expect(await screen.findByText("1 command")).toBeTruthy();
  });

  it("notifies the parent when rendered run activity changes", async () => {
    const onActivity = vi.fn();
    const firstContent = ndjsonLine(
      "stdout",
      `${JSON.stringify({ kind: "tool_call", name: "Read", input: { file_path: "src/a.ts" } })}\n`,
    );
    const secondContent = [
      firstContent,
      ndjsonLine(
        "stdout",
        `${JSON.stringify({ kind: "tool_call", name: "shell", input: { command: "pnpm test:run" } })}\n`,
        "2026-01-01T00:00:01Z",
      ),
    ].join("\n");
    (heartbeatsApi.log as any)
      .mockResolvedValueOnce({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content: firstContent })
      .mockResolvedValueOnce({ runId: "test-run-1", store: "local_file", logRef: "run.ndjson", content: secondContent });

    const { queryClient } = renderComponent({ isRunning: true, onActivity } as Partial<React.ComponentProps<typeof StructuredRunBlock>>);

    await screen.findByText("Reading 1 file");
    expect(onActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["run-log", "test-run-1"] });
    });

    await screen.findByText("Running command");
    expect(onActivity).toHaveBeenCalledTimes(2);
  });
});
