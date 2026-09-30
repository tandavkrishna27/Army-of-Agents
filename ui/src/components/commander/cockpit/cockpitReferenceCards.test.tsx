import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CockpitData } from "@armyofagents/shared";
import {
  COMMANDER_INPUT_REF_DRAG_MIME,
  parseCommanderInputRefDragPayload,
} from "@armyofagents/shared";
import { CockpitDiscussionsCard } from "./CockpitDiscussionsCard";
import { CockpitInboxCard } from "./CockpitInboxCard";
import { CockpitReviewCard } from "./CockpitReviewCard";
import { CockpitStickyNotesCard } from "./CockpitStickyNotesCard";

type TaskItem = CockpitData["review"][0];
type DiscussionItem = CockpitData["discussions"][0];
type NoteItem = CockpitData["stickyNotes"][0];
type InboxItem = CockpitData["inbox"][0];

function makeTask(overrides?: Partial<TaskItem>): TaskItem {
  return {
    id: "task-1",
    identifier: "ACME-1",
    title: "Fix the login flow",
    status: "in_review",
    assigneeUserId: "u1",
    assigneeAgentId: null,
    dueDate: null,
    ...overrides,
  };
}

function makeDiscussion(overrides?: Partial<DiscussionItem>): DiscussionItem {
  return { id: "disc-1", title: "Sprint planning", pendingItemCount: 3, reason: "pending_items", ...overrides };
}

function makeNote(overrides?: Partial<NoteItem>): NoteItem {
  return {
    id: "note-1",
    title: "Hiring",
    body: "Ask Priya about design contractor availability",
    color: "yellow",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInboxItem(overrides?: Partial<InboxItem>): InboxItem {
  return {
    id: "hub-1",
    lane: "waiting_on_you",
    priority: "high",
    title: "Approve launch budget",
    summary: "Budget change needs review",
    sourceType: "approval",
    sourceId: "approval-1",
    relatedEntityType: "task",
    relatedEntityId: "task-1",
    unread: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Cockpit reference actions", () => {
  it("adds a task reference from review rows", () => {
    const onReference = vi.fn();
    render(
      <CockpitReviewCard
        items={[makeTask({ id: "task-ref-1" })]}
        onAsk={vi.fn()}
        onReference={onReference}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /ask commander about this/i }));
    expect(onReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "task", id: "task-ref-1", label: "ACME-1 Fix the login flow" }),
      expect.stringContaining("ACME-1"),
    );
  });

  it("adds an inbox reference from inbox rows", () => {
    const onReference = vi.fn();
    render(<CockpitInboxCard items={[makeInboxItem()]} onAsk={vi.fn()} onReference={onReference} />);

    fireEvent.click(screen.getByLabelText("Ask Commander about this inbox item"));
    expect(onReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbox", id: "hub-1", route: "/inbox/waiting/hub-1" }),
      expect.stringContaining("Approve launch budget"),
    );
  });

  it("opens inbox rows through the reference viewer callback when available", () => {
    const onOpenReference = vi.fn();
    const onOpenFullPage = vi.fn();
    render(
      <CockpitInboxCard
        items={[makeInboxItem()]}
        onOpenReference={onOpenReference}
        onOpenFullPage={onOpenFullPage}
      />,
    );

    fireEvent.click(screen.getByText("Approve launch budget"));
    expect(onOpenReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbox", id: "hub-1", route: "/inbox/waiting/hub-1" }),
    );
    expect(onOpenFullPage).not.toHaveBeenCalled();

  });

  it("writes an inbox reference drag payload from inbox rows", () => {
    const setData = vi.fn();
    render(<CockpitInboxCard items={[makeInboxItem()]} onAsk={vi.fn()} />);

    const row = screen.getByText("Approve launch budget").closest("li");
    expect(row).toHaveAttribute("draggable", "true");
    expect(row).toHaveClass("cursor-grab");
    expect(row?.className).toContain("hover:translate-x-0.5");

    fireEvent.dragStart(row!, {
      dataTransfer: {
        effectAllowed: "",
        setData,
      },
    });

    expect(setData).toHaveBeenCalledWith(COMMANDER_INPUT_REF_DRAG_MIME, expect.any(String));
    const payload = parseCommanderInputRefDragPayload(setData.mock.calls[0][1]);
    expect(payload).toEqual({
      ref: expect.objectContaining({ kind: "inbox", id: "hub-1" }),
      prompt: expect.stringContaining("Approve launch budget"),
    });
  });

  it("adds a discussion reference from discussion rows", () => {
    const onReference = vi.fn();
    render(<CockpitDiscussionsCard items={[makeDiscussion()]} onAsk={vi.fn()} onReference={onReference} />);

    fireEvent.click(screen.getByRole("button", { name: /ask commander about this/i }));
    expect(onReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discussion", id: "disc-1", route: "/discussions/disc-1" }),
      expect.stringContaining("Sprint planning"),
    );
  });

  it("opens discussion rows through the reference viewer callback when available", () => {
    const onOpenReference = vi.fn();
    const onOpenFullPage = vi.fn();
    render(
      <CockpitDiscussionsCard
        items={[makeDiscussion()]}
        onOpenReference={onOpenReference}
        onOpenFullPage={onOpenFullPage}
      />,
    );

    fireEvent.click(screen.getByText("Sprint planning"));
    expect(onOpenReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discussion", id: "disc-1", route: "/discussions/disc-1" }),
    );
    expect(onOpenFullPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Sprint planning full page" }));
    expect(onOpenFullPage).toHaveBeenCalledWith("/discussions/disc-1");
  });

  it("adds a note reference from sticky notes", () => {
    const onReference = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CockpitStickyNotesCard
          companyId="comp-1"
          items={[makeNote()]}
          onAsk={vi.fn()}
          onReference={onReference}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText("Ask Commander about this note"));
    expect(onReference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "note", id: "note-1", label: "Hiring" }),
      expect.stringContaining("Hiring"),
    );
  });
});
