// ui/src/components/skills/__tests__/SkillViewerHeader.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CompanySkillDetail, CompanySkillUpdateStatus } from "@armyofagents/shared";
import { SkillViewerHeader } from "../SkillViewerHeader";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

function makeDetail(over: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "s1",
    companyId: "c1",
    key: "k1",
    slug: "my-skill",
    name: "My Skill",
    description: "Does a thing",
    markdown: "# hi",
    sourceType: "github",
    sourceLocator: null,
    sourceRef: "abc1234",
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: false,
    editableReason: "GitHub-managed skills can only be updated via install-update",
    sourceLabel: "owner/repo",
    sourceBadge: "github",
    sourcePath: null,
    ...over,
  };
}

const baseProps = {
  detail: makeDetail(),
  updateStatus: null as CompanySkillUpdateStatus | null,
  editing: false,
  onToggleEdit: vi.fn(),
  onDelete: vi.fn(),
  onCheckUpdates: vi.fn(),
  onInstallUpdate: vi.fn(),
  checkUpdatesPending: false,
  installUpdatePending: false,
};

function renderHeader(over: Partial<typeof baseProps> = {}) {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <SkillViewerHeader {...baseProps} {...over} />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("SkillViewerHeader", () => {
  it("renders the skill name and description", () => {
    const { getByText } = renderHeader();
    expect(getByText("My Skill")).toBeInTheDocument();
    expect(getByText("Does a thing")).toBeInTheDocument();
  });

  it("renders Read-only chip (not Edit button) for non-editable skills", () => {
    const { getByText, queryByRole } = renderHeader();
    expect(getByText(/read only/i)).toBeInTheDocument();
    expect(queryByRole("button", { name: /^edit$/i })).toBeNull();
  });

  it("renders Edit button for editable skills", () => {
    const detail = makeDetail({ editable: true, editableReason: null, sourceBadge: "local" });
    const { getByRole, queryByText } = renderHeader({ detail });
    expect(getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(queryByText(/read only/i)).toBeNull();
  });

  it("calls onToggleEdit when Edit button is clicked", () => {
    const detail = makeDetail({ editable: true });
    const onToggleEdit = vi.fn();
    const { getByRole } = renderHeader({ detail, onToggleEdit });
    fireEvent.click(getByRole("button", { name: /edit/i }));
    expect(onToggleEdit).toHaveBeenCalled();
  });

  it("calls onDelete when delete button is clicked", () => {
    const onDelete = vi.fn();
    const { getByRole } = renderHeader({ onDelete });
    fireEvent.click(getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("renders Install update button when updateStatus.hasUpdate", () => {
    const updateStatus: CompanySkillUpdateStatus = {
      supported: true,
      hasUpdate: true,
      currentRef: "abc",
      latestRef: "def5678",
      trackingRef: "main",
      reason: null,
    };
    const { getByRole } = renderHeader({ updateStatus });
    expect(getByRole("button", { name: /install update/i })).toBeInTheDocument();
  });

  it("renders 'editing' eyebrow suffix when editing=true", () => {
    const detail = makeDetail({ editable: true });
    const { getAllByText } = renderHeader({ detail, editing: true });
    // "· editing" appears in the eyebrow; "Stop editing" in the button — both match /editing/
    expect(getAllByText(/editing/i).length).toBeGreaterThanOrEqual(1);
  });
});
