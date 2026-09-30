import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import {
  ReportsToSelect,
  flattenOrgTree,
  type UnifiedOrgNode,
} from "../components/team/ReportsToSelect";

function makeOrgNode(overrides: Partial<UnifiedOrgNode> = {}): UnifiedOrgNode {
  return {
    id: "node-1",
    name: "Test Node",
    role: "engineer",
    status: "active",
    nodeType: "agent",
    children: [],
    ...overrides,
  };
}

const sampleTree: UnifiedOrgNode[] = [
  makeOrgNode({
    id: "agent-1",
    name: "Claude",
    role: "cxo",
    nodeType: "agent",
    adapterType: "claude_local",
    children: [
      makeOrgNode({
        id: "agent-2",
        name: "Gemini",
        role: "engineer",
        nodeType: "agent",
        adapterType: "gemini_local",
      }),
    ],
  }),
  makeOrgNode({
    id: "user-1",
    name: "Alice",
    role: "founder",
    nodeType: "user",
    userRole: "founder",
    children: [
      makeOrgNode({
        id: "user-2",
        name: "Bob",
        role: "team_lead",
        nodeType: "user",
        userRole: "team_lead",
      }),
    ],
  }),
];

// --- Pure function tests (no DOM needed) ---

describe("flattenOrgTree", () => {
  it("flattens a nested tree into a flat list", () => {
    const flat = flattenOrgTree(sampleTree);
    expect(flat).toHaveLength(4);
    expect(flat.map((n) => n.id)).toEqual([
      "agent-1",
      "agent-2",
      "user-1",
      "user-2",
    ]);
  });

  it("returns empty array for empty tree", () => {
    expect(flattenOrgTree([])).toEqual([]);
  });

  it("handles single node with no children", () => {
    const flat = flattenOrgTree([makeOrgNode({ id: "solo" })]);
    expect(flat).toHaveLength(1);
    expect(flat[0].id).toBe("solo");
  });

  it("handles deeply nested tree", () => {
    const deep: UnifiedOrgNode = makeOrgNode({
      id: "level-0",
      children: [
        makeOrgNode({
          id: "level-1",
          children: [
            makeOrgNode({
              id: "level-2",
              children: [makeOrgNode({ id: "level-3" })],
            }),
          ],
        }),
      ],
    });
    const flat = flattenOrgTree([deep]);
    expect(flat).toHaveLength(4);
    expect(flat.map((n) => n.id)).toEqual([
      "level-0",
      "level-1",
      "level-2",
      "level-3",
    ]);
  });
});

// --- Component tests ---

describe("ReportsToSelect", () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  it("renders with placeholder when value is empty", () => {
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("None (root)")).toBeInTheDocument();
  });

  it("shows agents and team members when dropdown is opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(await screen.findByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Team Members")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("excludes self from options (agent)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-1"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByText("Agents");

    // agent-1 ("Claude") should be excluded
    // agent-2 ("Gemini") should still appear
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    // Only one item in the Agents group
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
  });

  it("excludes self from options (user)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="user-1"
        currentEntityType="user"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByText("Team Members");

    expect(screen.getByText("Bob")).toBeInTheDocument();
    // user-1 ("Alice") should be excluded
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("filters to users only when filterToType='user'", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="user-2"
        currentEntityType="user"
        value=""
        onChange={mockOnChange}
        filterToType="user"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByText("Team Members");

    expect(screen.getByText("Alice")).toBeInTheDocument();
    // No agents group should appear
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.queryByText("Gemini")).not.toBeInTheDocument();
  });

  it("filters to agents only when filterToType='agent'", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
        filterToType="agent"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByText("Agents");

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("Team Members")).not.toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("calls onChange with empty string when None is selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value="agent:agent-1"
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    // Click the "None (root)" option in the dropdown
    const noneOptions = await screen.findAllByText("None (root)");
    // The second one is the dropdown item (first is the displayed value)
    await user.click(noneOptions[noneOptions.length - 1]);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith("");
    });
  });

  it("calls onChange with composite value when an option is selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("Alice"));

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith("user:user-1");
    });
  });

  it("renders only None option for empty org tree", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={[]}
        currentEntityId="agent-1"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    // Only "None (root)" should be available
    const noneOptions = await screen.findAllByText("None (root)");
    expect(noneOptions.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
    expect(screen.queryByText("Team Members")).not.toBeInTheDocument();
  });

  it("shows detail text for agents and users", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByText("Claude");

    // Agent detail text shows adapterType
    expect(screen.getByText("claude_local")).toBeInTheDocument();
    // User detail text shows role label
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(screen.getByText("Team Lead")).toBeInTheDocument();
  });

  it("respects disabled prop", () => {
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-1"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
        disabled
      />,
    );

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("renders terminated label and amber chip when currentValue points to terminated node", () => {
    const tree: UnifiedOrgNode[] = [
      makeOrgNode({
        id: "agent-term",
        name: "Old Agent",
        nodeType: "agent",
        status: "terminated",
      }),
      makeOrgNode({
        id: "agent-active",
        name: "Active Agent",
        nodeType: "agent",
        status: "active",
      }),
    ];
    renderWithProviders(
      <ReportsToSelect
        orgTree={tree}
        currentEntityId="agent-active"
        currentEntityType="agent"
        value="agent:agent-term"
        onChange={mockOnChange}
      />,
    );

    expect(screen.getByText(/Old Agent\s*\(terminated\)/)).toBeInTheDocument();
    const trigger = screen.getByRole("combobox");
    expect(trigger.className).toMatch(/amber/);
  });

  it("renders 'Unknown manager' fallback when currentValue points to non-existent node", () => {
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value="agent:ghost-id"
        onChange={mockOnChange}
      />,
    );

    expect(screen.getByText(/Unknown manager/i)).toBeInTheDocument();
  });

  it("renders custom chooseLabel prop when provided and value is empty", () => {
    renderWithProviders(
      <ReportsToSelect
        orgTree={sampleTree}
        currentEntityId="agent-2"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
        chooseLabel="Pick a manager"
      />,
    );

    expect(screen.getByText("Pick a manager")).toBeInTheDocument();
  });

  it("renders disabledEmptyLabel prop when disabled with empty orgTree", () => {
    renderWithProviders(
      <ReportsToSelect
        orgTree={[]}
        currentEntityId="agent-1"
        currentEntityType="agent"
        value=""
        onChange={mockOnChange}
        disabled
        disabledEmptyLabel="No managers yet"
      />,
    );

    expect(screen.getByText("No managers yet")).toBeInTheDocument();
  });
});
