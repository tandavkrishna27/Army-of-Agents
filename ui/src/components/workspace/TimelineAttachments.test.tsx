import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { IssueAttachment } from "@armyofagents/shared";
import { TimelineAttachments } from "./TimelineAttachments";

afterEach(cleanup);
function att(o: Partial<IssueAttachment>): IssueAttachment {
  return { id: "a1", assetId: "asset-1", originalFilename: "pic.png", contentType: "image/png",
    byteSize: 1024, contentPath: "/api/assets/asset-1/content", ...(o as object) } as IssueAttachment;
}
const img = att({});
const zip = att({ id: "a2", originalFilename: "x.zip", contentType: "application/zip" });

describe("TimelineAttachments hybrid", () => {
  it("renders an inline lazy image for an image attachment", () => {
    const { container } = render(<TimelineAttachments attachments={[img]} testId="t" />);
    expect(container.querySelector('img[loading="lazy"][src="/api/assets/asset-1/content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="attachment-inline-preview"]')).not.toBeNull();
  });
  it("no inline image region for a non-image attachment", () => {
    const { container } = render(<TimelineAttachments attachments={[zip]} testId="t" />);
    expect(container.querySelector('[data-testid^="attachment-inline-preview"]')).toBeNull();
  });
  it("renders a download link for an attachment", () => {
    const { container } = render(<TimelineAttachments attachments={[img]} testId="t" />);
    const dl = container.querySelector('a[download][href="/api/assets/asset-1/content"]');
    expect(dl).not.toBeNull();
  });
  it("opens when the image thumbnail is clicked", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<TimelineAttachments attachments={[img]} testId="t" onOpen={onOpen} />);
    fireEvent.click(getByTestId("attachment-image-open-a1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("fires onOpen when provided (pop-to-panel)", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<TimelineAttachments attachments={[img]} testId="t" onOpen={onOpen} />);
    fireEvent.click(getByTestId("attachment-open-a1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("falls back to a direct link when onOpen is absent", () => {
    const { getByTestId } = render(<TimelineAttachments attachments={[img]} testId="t" />);
    expect(getByTestId("attachment-open-a1").getAttribute("href")).toBe("/api/assets/asset-1/content");
  });
});
