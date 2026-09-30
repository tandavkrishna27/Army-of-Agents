import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FormatCapability } from "@armyofagents/shared";
import { ArtifactPanel } from "./ArtifactPanel";

vi.mock("../viewers/SharedContentViewer", () => ({
  SharedContentViewer: ({ viewer }: { viewer: { kind: string; assetUrl: string } }) => (
    <div data-testid="shared-viewer" data-kind={viewer.kind} data-url={viewer.assetUrl} />
  ),
}));

const native: FormatCapability = {
  id: "pdf", version: 1, extensions: ["pdf"], preview: "native", extraction: "provider_gated",
  nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 1024,
  limitations: ["OCR unavailable"],
};

describe("ArtifactPanel", () => {
  it("renders only the authorized asset URL and independent capability badges", () => {
    render(<ArtifactPanel assetId="asset-1" filename="plan.pdf" contentType="application/pdf"
      capability={native} previewReady />);
    expect(screen.getByTestId("shared-viewer")).toHaveAttribute("data-url", "/api/assets/asset-1/content");
    expect(screen.getByText("Preview ready")).toBeInTheDocument();
    expect(screen.getByText("Extraction gated")).toBeInTheDocument();
    expect(screen.getByText("Original export")).toBeInTheDocument();
  });

  it("keeps Download original available when preview is unsupported", () => {
    render(<ArtifactPanel assetId="asset-2" filename="model.psd" contentType="application/octet-stream"
      capability={{ ...native, id: "specialized-original", extensions: ["psd"], preview: "download_only", extraction: "none" }}
      previewReady={false} failure="unsupported" />);
    expect(screen.queryByTestId("shared-viewer")).toBeNull();
    expect(screen.getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/assets/asset-2/content");
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });

  it("does not render an ordinary password field for locked material", () => {
    render(<ArtifactPanel assetId="asset-3" filename="locked.pdf" contentType="application/pdf"
      capability={native} previewReady={false} failure="locked" />);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByText("This file is locked. Its original remains available.")).toBeInTheDocument();
  });
});
