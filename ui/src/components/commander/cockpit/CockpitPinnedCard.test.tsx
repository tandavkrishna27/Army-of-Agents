/**
 * CockpitPinnedCard tests — Phase 3d.
 *
 * Verifies:
 *   - Renders a task / artifact / goal pinned item (title + type chip visible).
 *   - Clicking a task row calls onOpenTask(entityId, title).
 *   - Clicking an artifact row calls onOpenArtifact(entityId, title).
 *   - Clicking a goal row calls onOpenFullPage('/goals/' + entityId).
 *   - Clicking the Unpin button calls onUnpin(entityType, entityId).
 *   - Empty items → renders null (data-testid absent).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CockpitPinnedItem } from "@armyofagents/shared";
import { CockpitPinnedCard } from "./CockpitPinnedCard";

// ── Data factories ─────────────────────────────────────────────────────────

function makeItem(overrides?: Partial<CockpitPinnedItem>): CockpitPinnedItem {
  return {
    entityType: "task",
    entityId: "task-1",
    title: "Fix the login bug",
    status: "in_review",
    identifier: "ACME-42",
    ...overrides,
  };
}

// ── Tests: empty state ─────────────────────────────────────────────────────

describe("CockpitPinnedCard — empty", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitPinnedCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("data-testid is absent when items is empty", () => {
    render(<CockpitPinnedCard items={[]} />);
    expect(screen.queryByTestId("cockpit-card-pinned")).not.toBeInTheDocument();
  });
});

// ── Tests: rendering ───────────────────────────────────────────────────────

describe("CockpitPinnedCard — render", () => {
  it("has data-testid='cockpit-card-pinned' when items present", () => {
    render(<CockpitPinnedCard items={[makeItem()]} />);
    expect(screen.getByTestId("cockpit-card-pinned")).toBeInTheDocument();
  });

  it("renders a task item with title and Task chip", () => {
    render(<CockpitPinnedCard items={[makeItem({ entityType: "task", title: "Fix the login bug" })]} />);
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
  });

  it("renders an artifact item with title and Artifact chip", () => {
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "artifact", entityId: "art-1", title: "Design spec v2", status: "active", identifier: null })]}
      />,
    );
    expect(screen.getByText("Design spec v2")).toBeInTheDocument();
    expect(screen.getByText("Artifact")).toBeInTheDocument();
  });

  it("renders a goal item with title and Goal chip", () => {
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "goal", entityId: "goal-1", title: "Launch v1", status: "active", identifier: null })]}
      />,
    );
    expect(screen.getByText("Launch v1")).toBeInTheDocument();
    expect(screen.getByText("Goal")).toBeInTheDocument();
  });

  it("renders the humanized status alongside the item", () => {
    render(<CockpitPinnedCard items={[makeItem({ status: "in_review" })]} />);
    expect(screen.getByText("In review")).toBeInTheDocument();
  });

  it("renders the identifier when present", () => {
    render(<CockpitPinnedCard items={[makeItem({ identifier: "ACME-42" })]} />);
    expect(screen.getByText("ACME-42")).toBeInTheDocument();
  });

  it("renders all items when multiple present (count lives in CockpitSection trigger, not card header)", () => {
    render(
      <CockpitPinnedCard
        items={[
          makeItem({ entityId: "t1", title: "Task A" }),
          makeItem({ entityId: "t2", title: "Task B" }),
        ]}
      />,
    );
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    // Verify both items render.
    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
  });
});

// ── Tests: row click navigation ────────────────────────────────────────────

describe("CockpitPinnedCard — row click", () => {
  it("clicking a task row calls onOpenTask(entityId, title)", () => {
    const onOpenTask = vi.fn();
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "task", entityId: "task-99", title: "Fix the login bug" })]}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("Fix the login bug"));
    expect(onOpenTask).toHaveBeenCalledWith("task-99", "Fix the login bug");
  });

  it("clicking an artifact row calls onOpenArtifact(entityId, title)", () => {
    const onOpenArtifact = vi.fn();
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "artifact", entityId: "art-7", title: "Design spec v2", status: "active", identifier: null })]}
        onOpenArtifact={onOpenArtifact}
      />,
    );
    fireEvent.click(screen.getByText("Design spec v2"));
    expect(onOpenArtifact).toHaveBeenCalledWith("art-7", "Design spec v2");
  });

  it("clicking a goal row calls onOpenFullPage('/goals/' + entityId)", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "goal", entityId: "goal-5", title: "Launch v1", status: "active", identifier: null })]}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    fireEvent.click(screen.getByText("Launch v1"));
    expect(onOpenFullPage).toHaveBeenCalledWith("/goals/goal-5");
  });
});

// ── Tests: Unpin button ────────────────────────────────────────────────────

describe("CockpitPinnedCard — Unpin", () => {
  it("clicking Unpin button calls onUnpin(entityType, entityId)", () => {
    const onUnpin = vi.fn();
    render(
      <CockpitPinnedCard
        items={[makeItem({ entityType: "task", entityId: "task-99", title: "Fix the login bug" })]}
        onUnpin={onUnpin}
      />,
    );
    const unpinBtn = screen.getByRole("button", { name: /unpin/i });
    fireEvent.click(unpinBtn);
    expect(onUnpin).toHaveBeenCalledWith("task", "task-99");
  });

  it("Unpin button is not rendered when onUnpin is not provided", () => {
    render(<CockpitPinnedCard items={[makeItem()]} />);
    expect(screen.queryByRole("button", { name: /unpin/i })).not.toBeInTheDocument();
  });
});
