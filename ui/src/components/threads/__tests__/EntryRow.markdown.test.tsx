import { describe, it, expect, vi } from "vitest";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { EntryRow } from "../EntryRow";
import type { DiscussionEntry } from "../../../api/discussions";

function makeEntry(overrides: Partial<DiscussionEntry> = {}): DiscussionEntry {
  return {
    id: "e1",
    inputType: "write",
    rawContent: "We should ship Threads.",
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
    createdBy: "user-1",
    createdAt: "2026-01-01T09:00:00Z",
    extractedItems: [],
    annotations: [],
    ...overrides,
  };
}

const MD = "**bold** and\n\n- a\n- b";

describe("EntryRow — markdown rendering", () => {
  it("renders markdown in the agent card body", () => {
    const { container } = renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "agent-7",
          authorAgentName: "Scribe",
          rawContent: MD,
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });

  it("renders markdown in the other-human bubble", () => {
    const { container } = renderWithProviders(
      <EntryRow
        entry={makeEntry({ id: "e-h", createdBy: "user-1", rawContent: MD })}
        currentUserId="user-99"
        onReprocess={vi.fn()}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });

  it("renders markdown in the self (me) bubble", () => {
    const { container } = renderWithProviders(
      <EntryRow
        entry={makeEntry({ id: "e-me", createdBy: "user-1", rawContent: MD })}
        currentUserId="user-1"
        onReprocess={vi.fn()}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });

  it("does not render raw HTML tags in agent markdown (XSS-safe)", () => {
    const { container } = renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "agent-7",
          authorAgentName: "Scribe",
          rawContent: "<img src=x onerror=alert(1)>hi",
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("hi");
  });
});
