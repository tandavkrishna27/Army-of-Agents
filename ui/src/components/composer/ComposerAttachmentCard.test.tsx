import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerAttachmentCard } from "./ComposerAttachmentCard";

describe("ComposerAttachmentCard", () => {
  it("renders filename, compact size, and Ready state", () => {
    render(
      <ComposerAttachmentCard name="brief.pdf" byteSize={421888} state="ready" onRemove={() => {}} />,
    );
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
    expect(screen.getByText("412 KB")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders NO size when byteSize is absent (artifact-upload path has none)", () => {
    render(<ComposerAttachmentCard name="plan.md" state="ready" onRemove={() => {}} />);
    expect(screen.getByText("plan.md")).toBeInTheDocument();
    expect(screen.queryByText(/KB|MB/)).not.toBeInTheDocument();
  });

  it("failed state shows the failure label and Retry only when onRetry is given", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ComposerAttachmentCard name="deck.pdf" byteSize={1_500_000} state="failed" onRemove={() => {}} onRetry={onRetry} />,
    );
    expect(screen.getByText("Failed to upload")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerAttachmentCard name="deck.pdf" byteSize={1_500_000} state="failed" onRemove={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("uploading state announces progress and images render a thumbnail", () => {
    render(
      <ComposerAttachmentCard
        name="dashboard.png"
        byteSize={980_000}
        state="uploading"
        previewUrl="blob:preview"
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/Uploading/)).toBeInTheDocument();
    // alt="" (decorative — the filename is adjacent text) strips the img role;
    // query the element directly.
    const img = screen.getByTestId("composer-attachment-dashboard.png").querySelector("img");
    expect(img).toHaveAttribute("src", "blob:preview");
  });

  it("remove is keyboard-accessible with a per-file accessible name", async () => {
    const onRemove = vi.fn();
    render(<ComposerAttachmentCard name="notes.txt" state="ready" onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
