import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { SystemEntryCard } from "../SystemEntryCard";
import type { DiscussionEntry } from "../../../api/discussions";

function makeEntry(overrides: Partial<DiscussionEntry> = {}): DiscussionEntry {
  return {
    id: "sys-1",
    inputType: "system",
    rawContent: "Adjutant failed: rate limit exceeded.",
    title: null,
    sourceInfo: null,
    departmentId: null,
    projectId: null,
    goalId: null,
    parentEntryId: null,
    authorAgentId: null,
    authorAgentName: null,
    authorAgentAvatar: null,
    extractionStatus: "completed",
    createdBy: "system",
    createdAt: "2026-05-01T00:00:00Z",
    extractedItems: [],
    annotations: [],
    ...overrides,
  };
}

describe("SystemEntryCard", () => {
  it("renders the warning icon and the entry message", () => {
    renderWithProviders(<SystemEntryCard entry={makeEntry()} />);
    expect(screen.getByTestId("system-entry-card")).toBeInTheDocument();
    expect(screen.getByTestId("system-entry-card-message")).toHaveTextContent(
      /rate limit exceeded/i,
    );
  });

  it("does not render a Retry button when onRetry is not provided", () => {
    renderWithProviders(<SystemEntryCard entry={makeEntry()} />);
    expect(screen.queryByTestId("system-entry-card-retry")).not.toBeInTheDocument();
  });

  it("renders a Retry button and fires onRetry when onRetry is provided", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SystemEntryCard entry={makeEntry()} onRetry={onRetry} />);
    const retry = screen.getByTestId("system-entry-card-retry");
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
