import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { InlineArtifactCard, isInlinePreviewable } from "../InlineArtifactCard";
import type { DiscussionEntryAttachment } from "../../../api/discussions";

function makeAttachment(overrides: Partial<DiscussionEntryAttachment> = {}): DiscussionEntryAttachment {
  return {
    id: "att-1",
    assetId: null,
    artifactId: "art-1",
    artifactType: "document",
    artifactTitle: "Onboarding plan",
    ...overrides,
  };
}

describe("InlineArtifactCard", () => {
  it("renders an attachment with title + type label", () => {
    renderWithProviders(
      <InlineArtifactCard attachments={[makeAttachment()]} />,
    );
    expect(screen.getByTestId("inline-artifact-card")).toBeInTheDocument();
    expect(screen.getByText("Onboarding plan")).toBeInTheDocument();
    expect(screen.getByText("Document")).toBeInTheDocument();
  });

  it("fires onOpen with the attachment when clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const attachment = makeAttachment({ id: "att-1", artifactId: "art-1" });
    renderWithProviders(
      <InlineArtifactCard
        attachments={[attachment]}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByTestId("inline-artifact-card-att-1"));
    expect(onOpen).toHaveBeenCalledWith(attachment);
  });

  it("renders multiple attachments", () => {
    renderWithProviders(
      <InlineArtifactCard
        attachments={[
          makeAttachment({ id: "a1", artifactTitle: "First" }),
          makeAttachment({ id: "a2", artifactTitle: "Second" }),
        ]}
      />,
    );
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("renders empty when given no attachments", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an asset-only attachment as a file chip", () => {
    renderWithProviders(
      <InlineArtifactCard
        attachments={[
          makeAttachment({
            id: "asset-att",
            artifactId: null,
            artifactType: null,
            artifactTitle: null,
            assetId: "asset-1",
            assetOriginalFilename: "notes.txt",
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("artifact-file-chip")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("opens an asset-only attachment when clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const attachment = makeAttachment({
      id: "asset-att",
      artifactId: null,
      artifactType: null,
      artifactTitle: null,
      assetId: "asset-1",
      assetOriginalFilename: "screenshot.png",
    });
    renderWithProviders(<InlineArtifactCard attachments={[attachment]} onOpen={onOpen} />);
    await user.click(screen.getByTestId("inline-artifact-card-asset-att"));
    expect(onOpen).toHaveBeenCalledWith(attachment);
  });

  it("renders a file chip for an artifact whose current version is asset-backed", () => {
    renderWithProviders(
      <InlineArtifactCard
        attachments={[
          makeAttachment({
            id: "file-att", artifactId: "art-file", artifactType: "design", artifactTitle: "Brand deck",
            currentVersionStorageKind: "asset", currentVersionFilename: "deck.pdf",
            currentVersionContentType: "application/pdf", currentVersionByteSize: 2048, currentVersionAssetId: "asset-9",
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("artifact-file-chip")).toBeInTheDocument();
    expect(screen.getByText("deck.pdf")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-download")).toHaveAttribute("href", "/api/assets/asset-9/content");
  });

  it("renders a file chip for a direct asset attachment", () => {
    renderWithProviders(
      <InlineArtifactCard
        attachments={[
          makeAttachment({
            id: "raw-asset", artifactId: null, artifactType: null, artifactTitle: null,
            assetId: "asset-7", assetContentType: "image/png", assetOriginalFilename: "shot.png", assetByteSize: 512,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("artifact-file-chip")).toBeInTheDocument();
    expect(screen.getByText("shot.png")).toBeInTheDocument();
  });

  it("does NOT render a file chip for an inline (text) artifact — regression", () => {
    renderWithProviders(
      <InlineArtifactCard
        attachments={[makeAttachment({ id: "inline-att", artifactId: "art-inline", artifactType: "document", artifactTitle: "Spec", currentVersionStorageKind: "inline" })]}
      />,
    );
    expect(screen.queryByTestId("artifact-file-chip")).not.toBeInTheDocument();
    expect(screen.getByText("Spec")).toBeInTheDocument();
    expect(screen.getByText("Document")).toBeInTheDocument();
  });

  it("shows the archive action only when canManage is true (active artifact)", () => {
    const { rerender } = renderWithProviders(
      <InlineArtifactCard attachments={[makeAttachment({ artifactId: "art-1", artifactStatus: "active" })]} />,
    );
    expect(screen.queryByTestId("artifact-archive")).not.toBeInTheDocument();
    rerender(
      <InlineArtifactCard attachments={[makeAttachment({ artifactId: "art-1", artifactStatus: "active" })]} canManage onArchiveArtifact={vi.fn()} onUnarchiveArtifact={vi.fn()} />,
    );
    expect(screen.getByTestId("artifact-archive")).toBeInTheDocument();
  });
  it("does not show lifecycle actions for draft artifacts", () => {
    renderWithProviders(
      <InlineArtifactCard attachments={[makeAttachment({ artifactId: "art-1", artifactStatus: "draft" })]} canManage onArchiveArtifact={vi.fn()} onUnarchiveArtifact={vi.fn()} />,
    );
    expect(screen.queryByTestId("artifact-archive")).not.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-unarchive")).not.toBeInTheDocument();
  });
  it("shows the unarchive action when the artifact is archived", () => {
    renderWithProviders(
      <InlineArtifactCard attachments={[makeAttachment({ artifactId: "art-1", artifactStatus: "archived" })]} canManage onArchiveArtifact={vi.fn()} onUnarchiveArtifact={vi.fn()} />,
    );
    expect(screen.getByTestId("artifact-unarchive")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-archive")).not.toBeInTheDocument();
  });
  it("fires onArchiveArtifact with the artifactId", async () => {
    const user = userEvent.setup();
    const onArchiveArtifact = vi.fn();
    renderWithProviders(
      <InlineArtifactCard attachments={[makeAttachment({ artifactId: "art-1", artifactStatus: "active" })]} canManage onArchiveArtifact={onArchiveArtifact} onUnarchiveArtifact={vi.fn()} />,
    );
    await user.click(screen.getByTestId("artifact-archive"));
    expect(onArchiveArtifact).toHaveBeenCalledWith("art-1");
  });
});

const imgAtt = { id: "att-img", assetId: "asset-1", assetOriginalFilename: "pic.png", assetContentType: "image/png", assetByteSize: 1024, artifactId: null, artifactType: null, artifactTitle: null, artifactStatus: null, currentVersionStorageKind: null, currentVersionAssetId: null, currentVersionFilename: null, currentVersionContentType: null, currentVersionByteSize: null } as any;
const zipAtt = { ...imgAtt, id: "att-zip", assetOriginalFilename: "a.zip", assetContentType: "application/zip" } as any;
const txtAtt = { ...imgAtt, id: "att-txt", assetOriginalFilename: "n.md", assetContentType: "text/markdown", assetByteSize: 2000 } as any;

describe("isInlinePreviewable", () => {
  it("raster images + small text inline; svg(+params)/pdf/zip/unknown-size-text not", () => {
    expect(isInlinePreviewable("image/png", 9e9)).toBe(true);
    expect(isInlinePreviewable("IMAGE/PNG", 10)).toBe(true);
    expect(isInlinePreviewable("image/svg+xml; charset=utf-8", 10)).toBe(false);
    expect(isInlinePreviewable("text/markdown", 1000)).toBe(true);
    expect(isInlinePreviewable("text/plain", 300 * 1024)).toBe(false);
    expect(isInlinePreviewable("text/plain", null)).toBe(false);
    expect(isInlinePreviewable("application/pdf", 10)).toBe(false);
    expect(isInlinePreviewable("application/zip", 10)).toBe(false);
    expect(isInlinePreviewable("text/html", 1000)).toBe(false);
    expect(isInlinePreviewable("text/html; charset=utf-8", 1000)).toBe(false);
  });
});
describe("InlineArtifactCard hybrid preview", () => {
  it("renders an inline lazy image preview for an image attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[imgAtt]} onOpen={() => {}} />);
    const img = container.querySelector('img[src="/api/assets/asset-1/content"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).not.toBeNull();
  });
  it("mounts an inline preview region for a small text attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[txtAtt]} onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).not.toBeNull();
  });
  it("chip-only (no preview region) for a non-previewable attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[zipAtt]} onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="artifact-file-chip"]')).not.toBeNull();
  });
  it("does not inline-preview text/html (pops to panel instead)", () => {
    const htmlAtt = { ...imgAtt, id: "att-html", assetOriginalFilename: "page.html", assetContentType: "text/html", assetByteSize: 1000 } as any;
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[htmlAtt]} onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="artifact-file-chip"]')).not.toBeNull();
  });
  it("still fires onOpen from the filename button", () => {
    const onOpen = vi.fn();
    const { getByTestId } = renderWithProviders(<InlineArtifactCard attachments={[imgAtt]} onOpen={onOpen} />);
    fireEvent.click(getByTestId("inline-artifact-card-att-img"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
