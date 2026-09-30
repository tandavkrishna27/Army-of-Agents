// ui/src/components/skills/__tests__/SkillsHomeEmpty.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { SkillsHomeEmpty } from "../SkillsHomeEmpty";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

function skill(id: string, name: string): CompanySkillListItem {
  return {
    id,
    companyId: "c1",
    key: `k-${id}`,
    slug: id,
    name,
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
  } as CompanySkillListItem;
}

const baseProps = {
  skills: [skill("a", "alpha"), skill("b", "beta")],
  recent: [
    { skillId: "a", openedAt: Date.now() - 1000 },
    { skillId: "missing", openedAt: Date.now() - 2000 }, // dropped from list
  ],
  onAddSkill: vi.fn(),
  onScanSkills: vi.fn(),
  scanPending: false,
};

function renderHome(props: Partial<typeof baseProps> = {}) {
  return render(
    <MemoryRouter>
      <SkillsHomeEmpty {...baseProps} {...props} />
    </MemoryRouter>,
  );
}

describe("SkillsHomeEmpty", () => {
  it("renders the skill library home overview", () => {
    const { getByText, getAllByText, queryByRole } = renderHome();
    expect(getByText("Library home")).toBeInTheDocument();
    expect(queryByRole("heading", { name: /skill library/i })).toBeNull();
    const totalCard = getByText("Total skills").closest("[class*='rounded-lg']");
    expect(totalCard).not.toBeNull();
    expect(within(totalCard as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(getAllByText("Standalone").length).toBeGreaterThanOrEqual(1);
    expect(getByText("Local skills")).toBeInTheDocument();
    expect(getByText("Recently opened")).toBeInTheDocument();
  });

  it("renders Add skill, Scan, and Browse marketplace buttons", () => {
    const { getByRole } = renderHome();
    expect(getByRole("button", { name: /add skill/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /scan/i })).toBeInTheDocument();
    expect(getByRole("link", { name: /browse marketplace/i })).toBeInTheDocument();
  });

  it("orders home actions as marketplace, scan, then add skill", () => {
    const { getByRole } = renderHome();
    const browse = getByRole("link", { name: /browse marketplace/i });
    const scan = getByRole("button", { name: /scan/i });
    const add = getByRole("button", { name: /add skill/i });

    expect(browse.compareDocumentPosition(scan)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(scan.compareDocumentPosition(add)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("calls onAddSkill when Add skill is clicked", () => {
    const onAddSkill = vi.fn();
    const { getByRole } = renderHome({ onAddSkill });
    fireEvent.click(getByRole("button", { name: /add skill/i }));
    expect(onAddSkill).toHaveBeenCalled();
  });

  it("calls onScanSkills when Scan is clicked", () => {
    const onScanSkills = vi.fn();
    const { getByRole } = renderHome({ onScanSkills });
    fireEvent.click(getByRole("button", { name: /scan/i }));
    expect(onScanSkills).toHaveBeenCalled();
  });

  it("disables Scan while scanning", () => {
    const { getByRole } = renderHome({ scanPending: true });
    expect(getByRole("button", { name: /scan/i })).toBeDisabled();
  });

  it("renders only resolvable recent skills (drops unknown ids)", () => {
    const { getByText, queryByText } = renderHome();
    const recentPanel = getByText("Recently opened").closest("[class*='rounded-lg']");
    expect(recentPanel).not.toBeNull();
    expect(within(recentPanel as HTMLElement).getByText("alpha")).toBeInTheDocument();
    expect(queryByText("missing")).toBeNull();
  });

  it("hides Recently opened section when there are no resolvable recents", () => {
    const { queryByText } = renderHome({ recent: [] });
    expect(queryByText(/recently opened/i)).toBeNull();
  });
});
