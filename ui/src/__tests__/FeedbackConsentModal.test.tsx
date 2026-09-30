import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { FeedbackConsentModal } from "../components/FeedbackConsentModal";

describe("FeedbackConsentModal", () => {
  it("renders the prompt title and description when open", () => {
    renderWithProviders(
      <FeedbackConsentModal
        open
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/share feedback with aoa labs/i)).toBeInTheDocument();
    expect(
      screen.getByText(/runs locally and never shares data by default/i),
    ).toBeInTheDocument();
  });

  it("does not render content when open=false", () => {
    renderWithProviders(
      <FeedbackConsentModal
        open={false}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByText(/share feedback with aoa labs/i)).not.toBeInTheDocument();
  });

  it("calls onDecide('allowed') when 'Yes, always' is clicked", async () => {
    const onDecide = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FeedbackConsentModal open onOpenChange={vi.fn()} onDecide={onDecide} />,
    );

    await user.click(screen.getByRole("button", { name: /always share feedback/i }));
    expect(onDecide).toHaveBeenCalledWith("allowed");
  });

  it("calls onDecide('not_allowed') when 'Never' is clicked", async () => {
    const onDecide = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FeedbackConsentModal open onOpenChange={vi.fn()} onDecide={onDecide} />,
    );

    await user.click(screen.getByRole("button", { name: /never share feedback/i }));
    expect(onDecide).toHaveBeenCalledWith("not_allowed");
  });

  it("calls onOpenChange(false) when Cancel is clicked (no decision recorded)", async () => {
    const onOpenChange = vi.fn();
    const onDecide = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FeedbackConsentModal
        open
        onOpenChange={onOpenChange}
        onDecide={onDecide}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("disables buttons while parent reports isSaving=true", () => {
    renderWithProviders(
      <FeedbackConsentModal
        open
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
        isSaving
      />,
    );
    expect(screen.getByRole("button", { name: /always share feedback/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /never share feedback/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeDisabled();
  });

  it("disables buttons while onDecide is in-flight", async () => {
    let resolveDecide: (() => void) | null = null;
    const onDecide = vi.fn(
      () => new Promise<void>((r) => { resolveDecide = () => r(); }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <FeedbackConsentModal open onOpenChange={vi.fn()} onDecide={onDecide} />,
    );

    await user.click(screen.getByRole("button", { name: /always share feedback/i }));
    // onDecide is pending — buttons should disable.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /always share feedback/i })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /never share feedback/i })).toBeDisabled();

    // Let it resolve.
    resolveDecide?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /always share feedback/i })).not.toBeDisabled(),
    );
  });

  it("surfaces the local bundle path so users know where data is written", () => {
    renderWithProviders(
      <FeedbackConsentModal open onOpenChange={vi.fn()} onDecide={vi.fn()} />,
    );
    expect(
      screen.getByText(/~\/\.aoa\/feedback-exports\//),
    ).toBeInTheDocument();
  });
});
