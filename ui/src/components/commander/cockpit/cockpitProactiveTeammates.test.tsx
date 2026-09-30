/**
 * Task 4: Component tests for CockpitProactiveFindingsCard + CockpitTeammatesActivityCard
 * and the extracted activityFormat.ts helpers.
 *
 * Mirrors cockpitOptinCards.test.tsx style — cards are purely presentational,
 * no query mocking needed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CockpitProactiveItem, CockpitTeammatesActivityItem } from "@armyofagents/shared";

import { CockpitProactiveFindingsCard } from "./CockpitProactiveFindingsCard";
import { CockpitTeammatesActivityCard } from "./CockpitTeammatesActivityCard";
import { activityVerb, entityLink } from "../../../lib/activityFormat";

// ── Data factories ─────────────────────────────────────────────────────────

function makeProactiveItem(overrides?: Partial<CockpitProactiveItem>): CockpitProactiveItem {
  return {
    id: "notif-1",
    title: "Blocked task detected",
    relatedEntityType: "issue",
    relatedEntityId: "issue-42",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTeammatesItem(overrides?: Partial<CockpitTeammatesActivityItem>): CockpitTeammatesActivityItem {
  return {
    id: "act-1",
    actorId: "user-99",
    actorType: "user",
    action: "issue.created",
    entityType: "issue",
    entityId: "issue-7",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── activityFormat.ts unit tests ───────────────────────────────────────────

describe("activityFormat — activityVerb", () => {
  it("maps a known action to a human verb", () => {
    expect(activityVerb("issue.created")).toBe("created");
  });

  it("maps issue.commented correctly", () => {
    expect(activityVerb("issue.commented")).toBe("commented on");
  });

  it("maps approval.approved correctly", () => {
    expect(activityVerb("approval.approved")).toBe("approved");
  });

  it("falls back gracefully for unknown actions", () => {
    // unknown actions get normalized (dots/underscores → spaces, 'issue' → 'task')
    const result = activityVerb("issue.frobnicated");
    expect(result).toBe("task frobnicated");
  });

  it("falls back for completely unknown actions", () => {
    const result = activityVerb("custom.action_here");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("activityFormat — entityLink", () => {
  it("returns /issues/:id for entityType='issue'", () => {
    expect(entityLink("issue", "issue-7")).toBe("/issues/issue-7");
  });

  it("uses name slug when provided for issue", () => {
    expect(entityLink("issue", "issue-7", "MY-123")).toBe("/issues/MY-123");
  });

  it("returns /agents/:id for entityType='agent'", () => {
    expect(entityLink("agent", "agent-5")).toBe("/agents/agent-5");
  });

  it("returns /goals/:id for entityType='goal'", () => {
    expect(entityLink("goal", "goal-3")).toBe("/goals/goal-3");
  });

  it("returns /approvals/:id for entityType='approval'", () => {
    expect(entityLink("approval", "appr-9")).toBe("/approvals/appr-9");
  });

  it("returns null for unknown entity type", () => {
    expect(entityLink("unknown_type", "some-id")).toBeNull();
  });

  it("returns null for heartbeat_run (not in the switch)", () => {
    expect(entityLink("heartbeat_run", "run-1")).toBeNull();
  });
});

// ── CockpitProactiveFindingsCard ───────────────────────────────────────────

describe("CockpitProactiveFindingsCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitProactiveFindingsCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-proactiveFindings' when items present", () => {
    render(<CockpitProactiveFindingsCard items={[makeProactiveItem()]} />);
    expect(screen.getByTestId("cockpit-card-proactiveFindings")).toBeInTheDocument();
  });

  it("shows item title", () => {
    render(
      <CockpitProactiveFindingsCard items={[makeProactiveItem({ title: "Blocked task detected" })]} />,
    );
    expect(screen.getByText("Blocked task detected")).toBeInTheDocument();
  });

  it("renders all items when multiple present (count lives in CockpitSection trigger, not card header)", () => {
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    render(
      <CockpitProactiveFindingsCard
        items={[
          makeProactiveItem({ id: "n1", title: "Finding A" }),
          makeProactiveItem({ id: "n2", title: "Finding B" }),
        ]}
      />,
    );
    expect(screen.getByText("Finding A")).toBeInTheDocument();
    expect(screen.getByText("Finding B")).toBeInTheDocument();
  });

  it("click with relatedEntity → calls onOpenFullPage('/inbox')", () => {
    const onOpenFullPage = vi.fn();
    const onOpenTask = vi.fn();
    render(
      <CockpitProactiveFindingsCard
        items={[makeProactiveItem({ relatedEntityType: "issue", relatedEntityId: "issue-42" })]}
        onOpenFullPage={onOpenFullPage}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("Blocked task detected"));
    expect(onOpenTask).toHaveBeenCalledWith("issue-42", "Blocked task detected");
    expect(onOpenFullPage).not.toHaveBeenCalled();
  });

  it("click without relatedEntity → calls onAsk(item.title)", () => {
    const onAsk = vi.fn();
    render(
      <CockpitProactiveFindingsCard
        items={[
          makeProactiveItem({
            title: "No entity finding",
            relatedEntityType: null,
            relatedEntityId: null,
          }),
        ]}
        onAsk={onAsk}
      />,
    );
    fireEvent.click(screen.getByText("No entity finding"));
    expect(onAsk).toHaveBeenCalledWith("No entity finding");
  });

  it("click without relatedEntity does NOT call onOpenFullPage", () => {
    const onOpenFullPage = vi.fn();
    const onAsk = vi.fn();
    render(
      <CockpitProactiveFindingsCard
        items={[
          makeProactiveItem({
            title: "No entity",
            relatedEntityType: null,
            relatedEntityId: null,
          }),
        ]}
        onOpenFullPage={onOpenFullPage}
        onAsk={onAsk}
      />,
    );
    fireEvent.click(screen.getByText("No entity"));
    expect(onOpenFullPage).not.toHaveBeenCalled();
    expect(onAsk).toHaveBeenCalledWith("No entity");
  });

  it("no crash when neither callback is provided", () => {
    render(<CockpitProactiveFindingsCard items={[makeProactiveItem({ title: "Safe click" })]} />);
    expect(() => fireEvent.click(screen.getByText("Safe click"))).not.toThrow();
  });
});

// ── CockpitTeammatesActivityCard ───────────────────────────────────────────

describe("CockpitTeammatesActivityCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitTeammatesActivityCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-teammatesActivity' when items present", () => {
    render(<CockpitTeammatesActivityCard items={[makeTeammatesItem()]} />);
    expect(screen.getByTestId("cockpit-card-teammatesActivity")).toBeInTheDocument();
  });

  it("renders multiple items when present (count lives in CockpitSection trigger, not card header)", () => {
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    const { container } = render(
      <CockpitTeammatesActivityCard
        items={[
          makeTeammatesItem({ id: "a1" }),
          makeTeammatesItem({ id: "a2" }),
        ]}
      />,
    );
    // Both items render as li elements
    const listItems = container.querySelectorAll("li");
    expect(listItems).toHaveLength(2);
  });

  it("shows humanized verb for a known action", () => {
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ action: "issue.created", entityType: "issue" })]}
      />,
    );
    // "created" is the humanized verb for "issue.created"
    expect(screen.getByText(/created/)).toBeInTheDocument();
  });

  it("shows entity type", () => {
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ entityType: "goal" })]}
      />,
    );
    expect(screen.getByText("goal")).toBeInTheDocument();
  });

  it("shows relative time", () => {
    // Very recent → "just now"
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ createdAt: new Date().toISOString() })]}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("click with a known entityType → calls onOpenFullPage(entityLink(...))", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ action: "goal.created", entityType: "goal", entityId: "goal-77" })]}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    // click the button (there's one per row)
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onOpenFullPage).toHaveBeenCalledWith("/goals/goal-77");
  });

  it("click with an unknown entityType → does NOT call onOpenFullPage", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ entityType: "heartbeat_run", entityId: "run-1" })]}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onOpenFullPage).not.toHaveBeenCalled();
  });

  it("click with task activity opens the task surface", () => {
    const onOpenFullPage = vi.fn();
    const onOpenTask = vi.fn();
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ action: "issue.created", entityType: "issue", entityId: "issue-7" })]}
        onOpenFullPage={onOpenFullPage}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenTask).toHaveBeenCalledWith("issue-7", "created");
    expect(onOpenFullPage).not.toHaveBeenCalled();
  });

  it("no crash when onOpenFullPage is not provided", () => {
    render(
      <CockpitTeammatesActivityCard
        items={[makeTeammatesItem({ entityType: "issue", entityId: "issue-1" })]}
      />,
    );
    const btn = screen.getByRole("button");
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});
