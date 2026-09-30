import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { SpinOffSuggestionCard } from "../SpinOffSuggestionCard";

describe("SpinOffSuggestionCard", () => {
  const suggestion = {
    topicSummary: "Rate-limit handling on the queue worker",
    rationale: "We've drifted from onboarding into infra debugging.",
  };

  it("renders summary + rationale + both buttons", () => {
    renderWithProviders(
      <SpinOffSuggestionCard
        suggestion={suggestion}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("spinoff-suggestion-summary")).toHaveTextContent(
      /rate-limit handling/i,
    );
    expect(screen.getByTestId("spinoff-suggestion-rationale")).toHaveTextContent(
      /onboarding into infra/i,
    );
    expect(screen.getByTestId("spinoff-suggestion-accept")).toBeInTheDocument();
    expect(screen.getByTestId("spinoff-suggestion-dismiss")).toBeInTheDocument();
  });

  it("fires onAccept when accept is clicked", async () => {
    const onAccept = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SpinOffSuggestionCard
        suggestion={suggestion}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("spinoff-suggestion-accept"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("fires onDismiss when dismiss is clicked", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SpinOffSuggestionCard
        suggestion={suggestion}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByTestId("spinoff-suggestion-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
