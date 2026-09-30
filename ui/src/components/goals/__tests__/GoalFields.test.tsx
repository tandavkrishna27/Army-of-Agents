import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { GoalFields, isCompatibleParent } from "../GoalFields";
import { goalsApi } from "../../../api/goals";
import { projectsApi } from "../../../api/projects";

vi.mock("../../../api/goals", () => ({ goalsApi: { list: vi.fn() } }));
vi.mock("../../../api/projects", () => ({ projectsApi: { list: vi.fn() } }));

const sampleProjects = [
  { id: "p-eng", name: "Engineering", type: "department" },
  { id: "p-mkt", name: "Marketing", type: "department" },
];

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
    companyId: "co1",
    title: "Goal",
    description: null,
    level: "task",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    projects: [],
    projectIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (projectsApi.list as unknown as Mock).mockResolvedValue(sampleProjects);
  (goalsApi.list as unknown as Mock).mockResolvedValue([]);
});

describe("isCompatibleParent", () => {
  it("company-wide parent allows any child", () => {
    expect(isCompatibleParent(["p1"], [])).toBe(true);
    expect(isCompatibleParent([], [])).toBe(true);
  });

  it("company-wide child cannot nest under a scoped parent", () => {
    expect(isCompatibleParent([], ["p1"])).toBe(false);
  });

  it("requires child scope ⊆ parent scope", () => {
    expect(isCompatibleParent(["p1"], ["p1", "p2"])).toBe(true);
    expect(isCompatibleParent(["p1", "p3"], ["p1", "p2"])).toBe(false);
  });
});

describe("GoalFields", () => {
  function setup(props: Record<string, unknown> = {}) {
    const onStatusChange = vi.fn();
    const onScopeChange = vi.fn();
    const onParentsChange = vi.fn();
    renderWithProviders(
      <GoalFields
        companyId="co1"
        status="planned"
        onStatusChange={onStatusChange}
        scope={{ mode: "company", projectIds: [] }}
        parentIds={[]}
        onScopeChange={onScopeChange}
        onParentsChange={onParentsChange}
        {...props}
      />,
    );
    return { onStatusChange, onScopeChange, onParentsChange };
  }

  it("renders a pill for every goal status", () => {
    setup();
    for (const s of ["planned", "active", "at_risk", "achieved", "cancelled"]) {
      expect(screen.getByTestId(`goal-status-${s}`)).toBeInTheDocument();
    }
  });

  it("status pill calls onStatusChange", async () => {
    const user = userEvent.setup();
    const { onStatusChange } = setup();
    await user.click(screen.getByTestId("goal-status-active"));
    expect(onStatusChange).toHaveBeenCalledWith("active");
  });

  it("is company-wide by default (no project picker shown)", () => {
    setup();
    expect(screen.queryByTestId("goal-project-p-eng")).not.toBeInTheDocument();
  });

  it("switching to Specific reports a specific scope", async () => {
    const user = userEvent.setup();
    const { onScopeChange } = setup();
    await user.click(screen.getByTestId("goal-scope-specific"));
    expect(onScopeChange).toHaveBeenCalledWith({
      mode: "specific",
      projectIds: [],
    });
  });

  it("selecting a project (in specific mode) reports the project id", async () => {
    const user = userEvent.setup();
    const { onScopeChange } = setup({
      scope: { mode: "specific", projectIds: [] },
    });
    await user.click(await screen.findByTestId("goal-project-p-eng"));
    expect(onScopeChange).toHaveBeenCalledWith({
      mode: "specific",
      projectIds: ["p-eng"],
    });
  });

  it("filters parent candidates to scope-compatible goals", async () => {
    (goalsApi.list as unknown as Mock).mockResolvedValue([
      goal({ id: "g-co", title: "Company Goal", projectIds: [] }),
      goal({ id: "g-eng", title: "Eng Goal", projectIds: ["p-eng"] }),
    ]);
    // A company-wide child can only nest under company-wide parents.
    setup({ scope: { mode: "company", projectIds: [] } });
    expect(await screen.findByTestId("goal-parent-g-co")).toBeInTheDocument();
    expect(screen.queryByTestId("goal-parent-g-eng")).not.toBeInTheDocument();
  });

  it("selecting a parent reports the id", async () => {
    (goalsApi.list as unknown as Mock).mockResolvedValue([
      goal({ id: "g-co", title: "Company Goal", projectIds: [] }),
    ]);
    const user = userEvent.setup();
    const { onParentsChange } = setup();
    await user.click(await screen.findByTestId("goal-parent-g-co"));
    expect(onParentsChange).toHaveBeenCalledWith(["g-co"]);
  });
});
