import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HubItemListRow } from "@/api/hub-items";
import { HubActionBar } from "../HubActionBar";

function row(overrides: Partial<HubItemListRow> = {}): HubItemListRow {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "run_failed",
    lane: "notifications",
    status: "open",
    priority: "normal",
    title: "Run failed",
    summary: null,
    sourceType: "heartbeat_run",
    sourceId: "run-1",
    relatedEntityId: null,
    relatedEntityType: null,
    ownerUserId: null,
    ownerPool: null,
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  };
}

function renderBar(overrides: Partial<React.ComponentProps<typeof HubActionBar>> = {}) {
  const props = {
    item: row(),
    onDismiss: vi.fn(),
    onSnooze: vi.fn(),
    onLifecycleAction: vi.fn(),
    ...overrides,
  };
  render(<HubActionBar {...props} />);
  return props;
}

describe("HubActionBar", () => {
  it("shows Dismiss/Snooze/Resolve/Archive for a non-mirrored open item and fires them", async () => {
    const user = userEvent.setup();
    const props = renderBar();

    await user.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(props.onDismiss).toHaveBeenCalledWith("hub-1");

    await user.click(screen.getByRole("button", { name: /^snooze$/i }));
    expect(props.onSnooze).toHaveBeenCalledWith("hub-1");

    await user.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(props.onLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hub-1" }),
      "resolve",
    );
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
  });

  it("hides Resolve/Archive for an OPEN mirrored type but keeps Dismiss/Snooze", () => {
    renderBar({ item: row({ semanticType: "approval_request", sourceType: "approval" }) });

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
  });

  it("hides Resolve/Archive/Claim/Release for a runtime decision", () => {
    renderBar({
      item: row({
        semanticType: "agent_runtime_decision",
        sourceType: "runtime_decision",
        ownerPool: "board",
      }),
    });

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^claim$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^release$/i })).not.toBeInTheDocument();
  });

  it("offers Claim for an unclaimed board-pool item and Release for a claimed one", () => {
    const { rerender } = render(
      <HubActionBar
        item={row({ ownerPool: "board", claimedByUserId: null })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^claim$/i })).toBeInTheDocument();

    rerender(
      <HubActionBar
        item={row({ ownerPool: "board", claimedByUserId: "user-9" })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^release$/i })).toBeInTheDocument();
  });

  it("renders disabled Route/Delegate and Ask-Commander stubs with a coming-soon aria-label", () => {
    renderBar();
    const route = screen.getByRole("button", { name: /route or delegate \(coming soon\)/i });
    const ask = screen.getByRole("button", { name: /ask commander to weigh in \(coming soon\)/i });
    expect(route).toBeDisabled();
    expect(ask).toBeDisabled();
  });

  it("renders a left-edge undo banner and fires onUndo when an undo action is present", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(
      <HubActionBar
        item={row()}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
        undoAction={{ label: "dismiss", onUndo }}
      />,
    );

    const undo = screen.getByRole("button", { name: /undo dismiss/i });
    await user.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("hub-action-bar")).toHaveLength(1);
  });

  it("offers Mark unread for an already-read item", async () => {
    const user = userEvent.setup();
    const onMarkUnread = vi.fn();
    render(
      <HubActionBar
        item={row({ readAt: "2026-07-01T00:00:00Z" })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
        onMarkUnread={onMarkUnread}
      />,
    );
    await user.click(screen.getByRole("button", { name: /mark unread/i }));
    expect(onMarkUnread).toHaveBeenCalledWith("hub-1");
  });
});
