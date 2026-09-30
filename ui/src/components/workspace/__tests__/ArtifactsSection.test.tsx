import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ToastProvider } from "../../../context/ToastContext";

const mocks = vi.hoisted(() => ({
  artifactsApiMock: { getByIssueId: vi.fn().mockResolvedValue(null) },
  outputDetectionApiMock: { listForIssue: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../api/artifacts", () => ({ artifactsApi: mocks.artifactsApiMock }));
vi.mock("../../../api/output-detection", () => ({ outputDetectionApi: mocks.outputDetectionApiMock }));

import { ArtifactsSection } from "../sections/ArtifactsSection";
import type { ArtifactWithVersions, ArtifactVersion } from "@armyofagents/shared";

function renderSection(props: Partial<ComponentProps<typeof ArtifactsSection>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ArtifactsSection issueId="issue-1" {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ArtifactsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactsApiMock.getByIssueId.mockResolvedValue(null);
    mocks.outputDetectionApiMock.listForIssue.mockResolvedValue([]);
  });

  it("uses a compact empty state when there are no artifacts or output candidates", async () => {
    renderSection();

    expect(await screen.findByTestId("artifacts-empty")).toHaveTextContent("No artifacts yet");
    expect(screen.queryByText("No artifacts linked")).not.toBeInTheDocument();
  });

  it("keeps saved artifact versions visible in the cockpit after outputs are confirmed", async () => {
    const user = userEvent.setup();
    const versions: ArtifactVersion[] = [
      {
        id: "version-2",
        artifactId: "artifact-1",
        versionNumber: 2,
        source: "agent",
        sourceDetail: null,
        changelog: "Agent output: loader.html",
        parentVersionId: "version-1",
        content: "<html>updated</html>",
        fileUrl: null,
        createdAt: new Date("2026-05-19T12:00:00Z"),
      },
      {
        id: "version-1",
        artifactId: "artifact-1",
        versionNumber: 1,
        source: "agent",
        sourceDetail: null,
        changelog: "Initial animated loader",
        parentVersionId: null,
        content: "<html>initial</html>",
        fileUrl: null,
        createdAt: new Date("2026-05-19T11:00:00Z"),
      },
    ];
    const artifact: ArtifactWithVersions = {
      id: "artifact-1",
      companyId: "company-1",
      title: "loader.html",
      description: null,
      type: "design",
      status: "active",
      currentVersionId: "version-2",
      createdById: "agent-1",
      createdAt: new Date("2026-05-19T11:00:00Z"),
      updatedAt: new Date("2026-05-19T12:00:00Z"),
      versions,
    };
    const onPreviewArtifact = vi.fn();
    mocks.artifactsApiMock.getByIssueId.mockResolvedValue(artifact);

    renderSection({ onPreviewArtifact });

    expect(await screen.findByTestId("artifact-row")).toHaveTextContent("loader.html");
    expect(screen.getByTestId("artifact-version-row-version-2")).toHaveTextContent("v2");
    expect(screen.getByTestId("artifact-version-row-version-2")).toHaveTextContent("loader.html");
    expect(screen.getByTestId("artifact-version-row-version-1")).toHaveTextContent("Initial animated loader");

    await user.click(screen.getByTestId("artifact-version-row-version-1"));

    expect(onPreviewArtifact).toHaveBeenCalledWith(artifact, versions[1]);
  });
});
