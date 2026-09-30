import { describe, it, expect, vi } from "vitest";
import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Notification } from "@armyofagents/shared";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => vi.fn() };
});

import {
  ThreadNotificationItem,
  isThreadNotification,
  THREAD_NOTIFICATION_TYPES,
} from "../ThreadNotificationItem";

vi.mock("../../../lib/timeAgo", () => ({
  timeAgo: () => "just now",
}));

function makeNotif(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    companyId: "comp-1",
    userId: "user-1",
    type: "thread.scope_proposal_posted",
    title: "Scope proposal ready",
    message: "Dispatcher posted 3 proposed tasks",
    relatedEntityType: "discussion",
    relatedEntityId: "thread-A",
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderItem(notification: Notification, onClick?: any) {
  return render(
    <MemoryRouter>
      <ThreadNotificationItem
        notification={notification}
        onClick={onClick}
      />
    </MemoryRouter>,
  );
}

describe("ThreadNotificationItem", () => {
  it("isThreadNotification recognizes all 5 Phase 1 types", () => {
    for (const type of THREAD_NOTIFICATION_TYPES) {
      expect(isThreadNotification(makeNotif({ type }))).toBe(true);
    }
    expect(isThreadNotification(makeNotif({ type: "thread.mention" }))).toBe(
      false,
    );
    expect(
      isThreadNotification(makeNotif({ type: "marketplace.install_completed" })),
    ).toBe(false);
  });

  it("renders scope_proposal_posted with title + discussion link", () => {
    renderItem(makeNotif({ type: "thread.scope_proposal_posted" }));
    expect(
      screen.getByTestId("thread-notification-thread.scope_proposal_posted"),
    ).toHaveAttribute("href", "/discussions/thread-A");
    expect(screen.getByText("Scope proposal ready")).toBeInTheDocument();
    expect(screen.getByText("Scope proposal")).toBeInTheDocument();
  });

  it("renders artifact_needs_review with title", () => {
    renderItem(
      makeNotif({
        type: "thread.artifact_needs_review",
        title: "Artifact ready: Design doc",
      }),
    );
    expect(screen.getByText("Artifact ready: Design doc")).toBeInTheDocument();
    expect(screen.getByText("Artifact ready")).toBeInTheDocument();
    expect(
      screen.getByTestId("thread-notification-thread.artifact_needs_review"),
    ).toHaveAttribute("href", "/discussions/thread-A");
  });

  it("renders crew_failed with agent name + error message", () => {
    renderItem(
      makeNotif({
        type: "thread.crew_failed",
        title: "Adjutant encountered an issue",
        message: "Anthropic API timeout",
      }),
    );
    expect(
      screen.getByText("Adjutant encountered an issue"),
    ).toBeInTheDocument();
    expect(screen.getByText("Anthropic API timeout")).toBeInTheDocument();
    expect(screen.getByText("Crew failed")).toBeInTheDocument();
  });

  it("renders spinoff_suggested with topic summary in message", () => {
    renderItem(
      makeNotif({
        type: "thread.spinoff_suggested",
        title: "Adjutant suggests a new thread",
        message: "Pricing-page A/B test discussion is wandering",
      }),
    );
    expect(
      screen.getByText("Adjutant suggests a new thread"),
    ).toBeInTheDocument();
    expect(screen.getByText("Spinoff suggested")).toBeInTheDocument();
    expect(
      screen.getByText("Pricing-page A/B test discussion is wandering"),
    ).toBeInTheDocument();
  });

  it("renders human_input_needed with title", () => {
    renderItem(
      makeNotif({
        type: "thread.human_input_needed",
        title: "Roadmap planning needs your input",
        message: "Strategic decision required",
      }),
    );
    // The title appears once; the badge label ("Input needed") appears separately.
    expect(
      screen.getByText("Roadmap planning needs your input"),
    ).toBeInTheDocument();
    expect(screen.getByText("Input needed")).toBeInTheDocument();
    expect(screen.getByText("Strategic decision required")).toBeInTheDocument();
  });

  it("falls back to /inbox when relatedEntityType is not 'discussion'", () => {
    renderItem(
      makeNotif({
        relatedEntityType: null,
        relatedEntityId: null,
      }),
    );
    expect(
      screen.getByTestId("thread-notification-thread.scope_proposal_posted"),
    ).toHaveAttribute("href", "/inbox");
  });

  it("fires the onClick handler with the notification when the link is clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderItem(makeNotif(), onClick);
    await user.click(
      screen.getByTestId("thread-notification-thread.scope_proposal_posted"),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0].id).toBe("n-1");
  });
});
