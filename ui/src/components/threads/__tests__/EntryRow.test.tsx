import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { EntryRow } from "../EntryRow";
import type {
  DiscussionEntry,
  DiscussionEntryAttachment,
} from "../../../api/discussions";

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

describe("EntryRow — agent authorship", () => {
  it("renders the agent name and an Agent badge for an agent entry", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "agent-7",
          authorAgentName: "Scribe",
          authorAgentAvatar: null,
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Scribe").length).toBeGreaterThan(0); // name + role badge
    expect(screen.getByTestId("entry-author-badge-agent")).toBeInTheDocument();
  });

  it("renders the human author (no Agent badge) for a human entry", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ createdBy: "jane-doe" })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("entry-author-badge-agent")).not.toBeInTheDocument();
  });

  it("right-aligns the bubble when currentUserId matches entry.createdBy", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ id: "e-42", createdBy: "user-1" })}
        currentUserId="user-1"
        onReprocess={vi.fn()}
      />,
    );
    const row = screen.getByTestId("entry-row-e-42");
    expect(row.getAttribute("data-entry-type")).toBe("me");
  });

  it("left-aligns the bubble when currentUserId does not match", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ id: "e-43", createdBy: "user-1" })}
        currentUserId="user-99"
        onReprocess={vi.fn()}
      />,
    );
    const row = screen.getByTestId("entry-row-e-43");
    expect(row.getAttribute("data-entry-type")).toBe("human");
  });

  it("does not render a Reply button", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry()} onReprocess={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /reply/i })).not.toBeInTheDocument();
  });

  it("does not render an Annotate button", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry()} onReprocess={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /annotate/i })).not.toBeInTheDocument();
  });
});

describe("EntryRow — delivered navigational-ref chips (Phase 7B)", () => {
  const refs = [
    { v: 2 as const, kind: "task" as const, id: "issue-9", title: "Ship viewer", action: "created" as const },
    { v: 2 as const, kind: "artifact" as const, id: "art-3", title: "Design brief", action: "referenced" as const },
  ];

  it("renders delivered-ref chips when entry.outputRefs is non-empty and a handler is threaded", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "scout",
          authorAgentName: "Scout",
          outputRefs: refs,
        })}
        onReprocess={vi.fn()}
        onOpenRef={vi.fn()}
      />,
    );
    const chips = screen.getByTestId("output-ref-chips");
    expect(within(chips).getByText("Ship viewer")).toBeInTheDocument();
    expect(within(chips).getByText("Design brief")).toBeInTheDocument();
  });

  it("invokes onOpenRef with the clicked ref", async () => {
    const onOpenRef = vi.fn();
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "scout",
          authorAgentName: "Scout",
          outputRefs: refs,
        })}
        onReprocess={vi.fn()}
        onOpenRef={onOpenRef}
      />,
    );
    await userEvent.click(screen.getByText("Ship viewer"));
    expect(onOpenRef).toHaveBeenCalledWith(refs[0]);
  });

  it("renders no chips when no handler is threaded (optional prop)", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ outputRefs: refs })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("output-ref-chips")).not.toBeInTheDocument();
  });

  it("renders no chips when outputRefs is empty", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ outputRefs: [] })}
        onReprocess={vi.fn()}
        onOpenRef={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("output-ref-chips")).not.toBeInTheDocument();
  });
});

describe("EntryRow — system notices", () => {
  function makeSystemNoticeEntry(overrides: Partial<DiscussionEntry> = {}): DiscussionEntry {
    return makeEntry({
      sourceInfo: { systemNotice: true },
      rawContent: "This is a system notice message.",
      ...overrides,
    });
  }

  it("renders with data-testid entry-system-notice when sourceInfo.systemNotice is true", () => {
    renderWithProviders(
      <EntryRow
        entry={makeSystemNoticeEntry()}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("entry-system-notice")).toBeInTheDocument();
  });

  it("does not render a Reply button for system notices", () => {
    renderWithProviders(
      <EntryRow
        entry={makeSystemNoticeEntry()}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /reply/i })).not.toBeInTheDocument();
  });

  it("renders the content without a collapse toggle for system notices", () => {
    renderWithProviders(
      <EntryRow
        entry={makeSystemNoticeEntry({ rawContent: "System-level event occurred." })}
        onReprocess={vi.fn()}
      />,
    );
    // Content is always visible — no toggle button needed
    expect(screen.getByText("System-level event occurred.")).toBeInTheDocument();
    // No aria-expanded toggle button should be present
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
  });

  it("renders a System notice label", () => {
    renderWithProviders(
      <EntryRow
        entry={makeSystemNoticeEntry()}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByText("System notice")).toBeInTheDocument();
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Phase E2 — attribution, attachments, reply count
   ════════════════════════════════════════════════════════════════════════ */

describe("EntryRow — bubble alignment + system-notice layout", () => {
  it("RC2: the me-bubble's bubble+avatar row is justified to the right (justify-end)", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ id: "e-me", createdBy: "user-1" })}
        currentUserId="user-1"
        onReprocess={vi.fn()}
      />,
    );
    const row = screen.getByTestId("entry-row-e-me");
    // The inner flex row that holds the bubble + avatar must justify-end so the
    // bubble sits flush against the right edge (no dead space on the right).
    const justified = row.querySelector(".justify-end");
    expect(justified).not.toBeNull();
    expect(justified?.className).toContain("items-end");
  });

  it("RC1b: the system-notice text span wraps (no whitespace-nowrap, has break-words + a width cap)", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          sourceInfo: { systemNotice: true },
          rawContent:
            "This is an unusually long system notice that should wrap onto multiple lines instead of overflowing the thread horizontally.",
        })}
        onReprocess={vi.fn()}
      />,
    );
    const notice = screen.getByTestId("entry-system-notice");
    const span = within(notice).getByText(/unusually long system notice/);
    expect(span.className).not.toMatch(/whitespace-nowrap/);
    expect(span.className).toMatch(/break-words/);
    expect(span.className).toMatch(/max-w-\[70%\]/);
  });
});

describe("EntryRow — Phase E2 attribution", () => {
  it("renders the agent attribution badge when authorAgentId + authorAgentName are present", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "agent-7",
          authorAgentName: "Scribe",
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("entry-agent-attribution")).toBeInTheDocument();
  });

  it("renders the agent avatar image when authorAgentAvatar is provided", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "agent",
          authorAgentId: "agent-7",
          authorAgentName: "Scribe",
          authorAgentAvatar: "https://example.com/scribe.png",
        })}
        onReprocess={vi.fn()}
      />,
    );
    const avatar = screen.getByTestId("entry-agent-avatar") as HTMLImageElement;
    expect(avatar).toBeInTheDocument();
    expect(avatar.src).toBe("https://example.com/scribe.png");
  });

  it("does NOT render the agent attribution badge for a human-authored entry", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ createdBy: "jane-doe" })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("entry-agent-attribution")).not.toBeInTheDocument();
  });
});

describe("EntryRow — Phase E2 attachments", () => {
  it("renders an InlineArtifactCard when attachments[] is present", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({ attachments: [makeAttachment()] })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("inline-artifact-card")).toBeInTheDocument();
    expect(screen.getByText("Onboarding plan")).toBeInTheDocument();
  });

  it("does not render an InlineArtifactCard when attachments[] is empty / undefined", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry()} onReprocess={vi.fn()} />,
    );
    expect(screen.queryByTestId("inline-artifact-card")).not.toBeInTheDocument();
  });
});

describe("EntryRow — Phase E2 reply count", () => {
  it("renders 'N replies' when replyCount > 1", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry({ replyCount: 3 })} onReprocess={vi.fn()} />,
    );
    expect(screen.getByTestId("entry-reply-count")).toHaveTextContent("3 replies");
  });

  it("renders '1 reply' (singular) when replyCount is 1", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry({ replyCount: 1 })} onReprocess={vi.fn()} />,
    );
    expect(screen.getByTestId("entry-reply-count")).toHaveTextContent("1 reply");
  });

  it("does not render the reply count when replyCount is 0 or absent", () => {
    renderWithProviders(
      <EntryRow entry={makeEntry({ replyCount: 0 })} onReprocess={vi.fn()} />,
    );
    expect(screen.queryByTestId("entry-reply-count")).not.toBeInTheDocument();
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Phase E3 — entry card routing
   ════════════════════════════════════════════════════════════════════════ */

describe("EntryRow — Phase E3 entry cards", () => {
  it("renders ScopeProposalCard for scope_proposal entries", () => {
    const payload = {
      summary: "Ship onboarding redesign",
      proposedTasks: [
        { title: "Wireframe", description: null, suggestedAssigneeAgentId: null, suggestedDepartmentId: null },
      ],
      autoAdvanceAt: null,
    };
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "scope_proposal",
          rawContent: JSON.stringify(payload),
        })}
        scopeProposalActive
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-proposal-card")).toBeInTheDocument();
    expect(screen.getByTestId("scope-proposal-active-badge")).toBeInTheDocument();
  });

  it("routes 'system' entries with a spinOffSuggestion payload to SpinOffSuggestionCard", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "system",
          rawContent: "Spin off?",
          sourceInfo: {
            spinOffSuggestion: {
              topicSummary: "Auth provider rotation",
              rationale: "Off-topic from onboarding",
            },
          },
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("spinoff-suggestion-card")).toBeInTheDocument();
  });

  it("routes 'system' entries without a spinOffSuggestion to SystemEntryCard", () => {
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "system",
          rawContent: "Adjutant timed out",
          sourceInfo: null,
        })}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.getByTestId("system-entry-card")).toBeInTheDocument();
  });

  it("fires onScopeProposalApprove when 'Start Scoping' is clicked", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const payload = {
      summary: "Ship redesign",
      proposedTasks: [
        { title: "A", description: null, suggestedAssigneeAgentId: null, suggestedDepartmentId: null },
      ],
      autoAdvanceAt: null,
    };
    const entry = makeEntry({
      id: "scope-entry-1",
      inputType: "scope_proposal",
      rawContent: JSON.stringify(payload),
    });
    renderWithProviders(
      <EntryRow
        entry={entry}
        onReprocess={vi.fn()}
        scopeProposalActive
        onScopeProposalApprove={onApprove}
      />,
    );
    await user.click(screen.getByTestId("scope-proposal-approve"));
    expect(onApprove).toHaveBeenCalledWith(entry);
  });

  it("shows 'Scoped' badge and hides action buttons when hasScopeDraft=true", () => {
    const payload = {
      summary: "Ship onboarding redesign",
      proposedTasks: [
        { title: "Wireframe", description: null, suggestedAssigneeAgentId: null, suggestedDepartmentId: null },
      ],
      autoAdvanceAt: null,
    };
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "scope_proposal",
          rawContent: JSON.stringify(payload),
        })}
        scopeProposalActive
        hasScopeDraft
        onReprocess={vi.fn()}
      />,
    );
    // The "Scoped" badge must be visible
    expect(screen.getByTestId("scope-proposal-scoped-badge")).toBeInTheDocument();
    // Action buttons must be hidden when scoped
    expect(screen.queryByTestId("scope-proposal-approve")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-proposal-reject")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-proposal-edit")).not.toBeInTheDocument();
    // Task list and summary must remain visible (audit trail)
    expect(screen.getByText("Ship onboarding redesign")).toBeInTheDocument();
    expect(screen.getByTestId("scope-proposal-tasks")).toBeInTheDocument();
  });

  it("still shows action buttons when hasScopeDraft=false", () => {
    const payload = {
      summary: "Ship onboarding redesign",
      proposedTasks: [
        { title: "Wireframe", description: null, suggestedAssigneeAgentId: null, suggestedDepartmentId: null },
      ],
      autoAdvanceAt: null,
    };
    renderWithProviders(
      <EntryRow
        entry={makeEntry({
          inputType: "scope_proposal",
          rawContent: JSON.stringify(payload),
        })}
        scopeProposalActive
        hasScopeDraft={false}
        onReprocess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("scope-proposal-scoped-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("scope-proposal-approve")).toBeInTheDocument();
  });
});
