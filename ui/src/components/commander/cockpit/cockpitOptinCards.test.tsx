/**
 * Task 4: Component tests for the 3 opt-in cockpit cards.
 *
 * Mirrors cockpitCards.test.tsx style.
 * Cards are purely presentational — no query mocking needed.
 *
 * Also covers:
 *   - mountableCards opt-in behaviour (enabled param)
 *   - backward-compat: no-arg / empty-enabled calls don't crash, exclude opt-in cards
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type {
  CockpitGoalsAtRiskItem,
  CockpitBudgetPulseItem,
  CockpitDoneTodayItem,
} from "@armyofagents/shared";

import { CockpitGoalsAtRiskCard } from "./CockpitGoalsAtRiskCard";
import { CockpitBudgetPulseCard } from "./CockpitBudgetPulseCard";
import { CockpitDoneTodayCard } from "./CockpitDoneTodayCard";
import { mountableCards, type CockpitCardDef } from "./cockpitCardModel";

// ── Data factories ─────────────────────────────────────────────────────────

function makeGoalAtRisk(overrides?: Partial<CockpitGoalsAtRiskItem>): CockpitGoalsAtRiskItem {
  return {
    id: "goal-1",
    title: "Launch v1",
    level: "company",
    ownerAgentId: null,
    ...overrides,
  };
}

function makePulse(overrides?: Partial<CockpitBudgetPulseItem>): CockpitBudgetPulseItem {
  return {
    limitCents: 10000,
    spentCents: 5000,
    percentUsed: 50,
    openIncidentCount: 0,
    ...overrides,
  };
}

function makeDoneToday(overrides?: Partial<CockpitDoneTodayItem>): CockpitDoneTodayItem {
  return {
    id: "task-1",
    identifier: "ACME-1",
    title: "Ship the feature",
    ...overrides,
  };
}

// ── CockpitGoalsAtRiskCard ─────────────────────────────────────────────────

describe("CockpitGoalsAtRiskCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitGoalsAtRiskCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-goalsAtRisk' when items present", () => {
    render(<CockpitGoalsAtRiskCard items={[makeGoalAtRisk()]} />);
    expect(screen.getByTestId("cockpit-card-goalsAtRisk")).toBeInTheDocument();
  });

  it("shows goal title", () => {
    render(<CockpitGoalsAtRiskCard items={[makeGoalAtRisk({ title: "Launch v1" })]} />);
    expect(screen.getByText("Launch v1")).toBeInTheDocument();
  });

  it("shows 'at risk' chip on each row", () => {
    render(
      <CockpitGoalsAtRiskCard
        items={[
          makeGoalAtRisk({ id: "g1", title: "Alpha" }),
          makeGoalAtRisk({ id: "g2", title: "Beta" }),
        ]}
      />,
    );
    const chips = screen.getAllByText("at risk");
    expect(chips).toHaveLength(2);
  });

  it("row click calls onOpenFullPage('/goals/' + id)", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitGoalsAtRiskCard
        items={[makeGoalAtRisk({ id: "goal-99", title: "Launch v1" })]}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    fireEvent.click(screen.getByText("Launch v1"));
    expect(onOpenFullPage).toHaveBeenCalledWith("/goals/goal-99");
  });

  it("no crash when onOpenFullPage is not provided", () => {
    render(<CockpitGoalsAtRiskCard items={[makeGoalAtRisk({ title: "No click" })]} />);
    expect(() => fireEvent.click(screen.getByText("No click"))).not.toThrow();
  });

  it("renders all items when multiple present (count lives in CockpitSection trigger, not card header)", () => {
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    render(
      <CockpitGoalsAtRiskCard
        items={[
          makeGoalAtRisk({ id: "g1", title: "Alpha" }),
          makeGoalAtRisk({ id: "g2", title: "Beta" }),
        ]}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});

// ── CockpitBudgetPulseCard ─────────────────────────────────────────────────

describe("CockpitBudgetPulseCard", () => {
  it("renders null when pulse is null", () => {
    const { container } = render(<CockpitBudgetPulseCard pulse={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-budgetPulse' when pulse present", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse()} />);
    expect(screen.getByTestId("cockpit-card-budgetPulse")).toBeInTheDocument();
  });

  it("shows spent / limit in dollars", () => {
    render(
      <CockpitBudgetPulseCard
        pulse={makePulse({ limitCents: 10000, spentCents: 5000 })}
      />,
    );
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("/ $100.00")).toBeInTheDocument();
  });

  it("shows sub-dollar spend without rounding to $0 (formatCents)", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ spentCents: 49, limitCents: 100000 })} />);
    expect(screen.getByText("$0.49")).toBeInTheDocument();
  });

  it("shows percent used", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 75 })} />);
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("shows open incidents when openIncidentCount > 0", () => {
    render(
      <CockpitBudgetPulseCard
        pulse={makePulse({ openIncidentCount: 3 })}
      />,
    );
    expect(screen.getByText("3 open incidents")).toBeInTheDocument();
  });

  it("singular 'incident' for openIncidentCount === 1", () => {
    render(
      <CockpitBudgetPulseCard
        pulse={makePulse({ openIncidentCount: 1 })}
      />,
    );
    expect(screen.getByText("1 open incident")).toBeInTheDocument();
  });

  it("does not show incident text when openIncidentCount === 0", () => {
    render(
      <CockpitBudgetPulseCard
        pulse={makePulse({ openIncidentCount: 0 })}
      />,
    );
    expect(screen.queryByText(/open incident/i)).not.toBeInTheDocument();
  });

  it("percent bar aria-label reflects percentUsed", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 42 })} />);
    expect(screen.getByLabelText(/42% of budget used/i)).toBeInTheDocument();
  });

  it("caps percent bar at 100% when percentUsed > 100", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 150 })} />);
    // Shows 150% text but bar is capped — the aria-label should show 150
    expect(screen.getByLabelText(/150% of budget used/i)).toBeInTheDocument();
  });

  it("bar is brand color below the 80% warning threshold", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 79 })} />);
    expect(screen.getByLabelText(/79% of budget used/i).className).toContain("bg-brand");
  });

  it("bar turns amber at exactly 80%", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 80 })} />);
    expect(screen.getByLabelText(/80% of budget used/i).className).toContain("bg-amber-500");
  });

  it("bar turns red at exactly 100%", () => {
    render(<CockpitBudgetPulseCard pulse={makePulse({ percentUsed: 100 })} />);
    expect(screen.getByLabelText(/100% of budget used/i).className).toContain("bg-red-500");
  });
});

// ── CockpitDoneTodayCard ───────────────────────────────────────────────────

describe("CockpitDoneTodayCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitDoneTodayCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("has data-testid='cockpit-card-doneToday' when items present", () => {
    render(<CockpitDoneTodayCard items={[makeDoneToday()]} />);
    expect(screen.getByTestId("cockpit-card-doneToday")).toBeInTheDocument();
  });

  it("shows task title", () => {
    render(
      <CockpitDoneTodayCard items={[makeDoneToday({ title: "Ship the feature" })]} />,
    );
    expect(screen.getByText("Ship the feature")).toBeInTheDocument();
  });

  it("shows identifier when present", () => {
    render(
      <CockpitDoneTodayCard items={[makeDoneToday({ identifier: "ACME-42" })]} />,
    );
    expect(screen.getByText("ACME-42")).toBeInTheDocument();
  });

  it("omits identifier span when identifier is null", () => {
    render(
      <CockpitDoneTodayCard items={[makeDoneToday({ identifier: null, title: "No ID task" })]} />,
    );
    // title still present, no identifier
    expect(screen.getByText("No ID task")).toBeInTheDocument();
  });

  it("row click calls onOpenTask(id, title)", () => {
    const onOpenTask = vi.fn();
    render(
      <CockpitDoneTodayCard
        items={[makeDoneToday({ id: "task-99", title: "Ship the feature" })]}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("Ship the feature"));
    expect(onOpenTask).toHaveBeenCalledWith("task-99", "Ship the feature");
  });

  it("no crash when onOpenTask is not provided", () => {
    render(<CockpitDoneTodayCard items={[makeDoneToday({ title: "No click" })]} />);
    expect(() => fireEvent.click(screen.getByText("No click"))).not.toThrow();
  });

  it("renders all items when multiple present (count lives in CockpitSection trigger, not card header)", () => {
    // Phase 5B: internal header removed; count now lives in the CockpitSection trigger.
    render(
      <CockpitDoneTodayCard
        items={[
          makeDoneToday({ id: "t1", title: "Task A" }),
          makeDoneToday({ id: "t2", title: "Task B" }),
        ]}
      />,
    );
    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
  });
});

// ── mountableCards — opt-in / enabled param behaviour ──────────────────────

describe("mountableCards — opt-in card enabled param", () => {
  // A minimal registry with one defaultOn card + one opt-in card.
  const registry: CockpitCardDef[] = [
    { id: "running", title: "Running now", defaultOn: true, sectionId: "watch" },
    { id: "goalsAtRisk", title: "Goals at risk", defaultOn: false, sectionId: "watch" },
  ];

  it("opt-in card is EXCLUDED when enabled is [] (default)", () => {
    const result = mountableCards(registry, [], []);
    expect(result.map((c) => c.id)).toEqual(["running"]);
  });

  it("opt-in card IS included when its id is in enabled", () => {
    const result = mountableCards(registry, [], [], ["goalsAtRisk"]);
    expect(result.map((c) => c.id)).toContain("goalsAtRisk");
  });

  it("defaultOn card is still included even when enabled is []", () => {
    const result = mountableCards(registry, [], [], []);
    expect(result.map((c) => c.id)).toContain("running");
  });

  it("calling with no enabled arg (3-arg form) doesn't crash and excludes opt-in", () => {
    // 3-arg backward-compat call (enabled defaults to [])
    const result = mountableCards(registry, [], []);
    expect(result).toBeDefined();
    expect(result.map((c) => c.id)).not.toContain("goalsAtRisk");
  });

  it("opt-in card excluded even when enabled=[] but it would be hidden too", () => {
    const result = mountableCards(registry, ["goalsAtRisk"], [], ["goalsAtRisk"]);
    // hidden wins — even if enabled, hidden removes it
    expect(result.map((c) => c.id)).not.toContain("goalsAtRisk");
  });
});
