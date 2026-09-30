// ui/src/components/skills/__tests__/SkillPackageOverview.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { SkillPackageOverview } from "../SkillPackageOverview";
import type { SkillPackage } from "@/lib/skillPackages";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

function member(over: Partial<CompanySkillListItem> & { id: string }): CompanySkillListItem {
  return {
    id: over.id,
    companyId: "c1",
    key: `k-${over.id}`,
    slug: over.id,
    name: `/${over.id}`,
    description: `${over.id} desc`,
    sourceType: "github",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    editable: false,
    editableReason: null,
    sourceLabel: "owner/repo",
    sourceBadge: "github",
    sourcePath: null,
    ...over,
  } as CompanySkillListItem;
}

const pkg: SkillPackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberSkillIds: ["a", "b", "c"],
  count: 3,
  explicit: false,
};

const members = [member({ id: "a" }), member({ id: "b" }), member({ id: "c" })];

const baseProps = {
  pkg,
  members,
  membersWithUpdate: new Set<string>(),
  totalUsedByAgents: 12,
  onUpdateAll: vi.fn(),
  onRemovePackage: vi.fn(),
  updateAllPending: false,
  removePending: false,
};

function renderOverview(over: Partial<typeof baseProps> = {}) {
  return render(
    <MemoryRouter>
      <SkillPackageOverview {...baseProps} {...over} />
    </MemoryRouter>,
  );
}

describe("SkillPackageOverview", () => {
  it("renders the package name + count", () => {
    const { getByRole, getByText } = renderOverview();
    expect(getByRole("heading", { name: "gstack" })).toBeInTheDocument();
    expect(getByText(/3 skills/)).toBeInTheDocument();
  });

  it("renders provider logo when package metadata includes one", () => {
    const { getByRole } = renderOverview({
      pkg: {
        ...pkg,
        provider: {
          id: "angular",
          name: "Angular",
          logoUrl: "https://github.com/angular.png",
          fallbackInitials: "NG",
        },
      },
    });
    expect(getByRole("img", { name: "Angular logo" })).toBeInTheDocument();
  });

  it("renders one card per member", () => {
    const { getAllByText } = renderOverview();
    expect(getAllByText(/^\/[abc]$/).length).toBe(3);
  });

  it("hides Update all when no member has a pending update", () => {
    const { queryByRole } = renderOverview();
    expect(queryByRole("button", { name: /update all/i })).toBeNull();
  });

  it("shows Update all when ≥1 member has a pending update", () => {
    const { getByRole } = renderOverview({ membersWithUpdate: new Set(["a"]) });
    expect(getByRole("button", { name: /update all/i })).toBeInTheDocument();
  });

  it("calls onUpdateAll when Update all is clicked", () => {
    const onUpdateAll = vi.fn();
    const { getByRole } = renderOverview({
      membersWithUpdate: new Set(["a"]),
      onUpdateAll,
    });
    fireEvent.click(getByRole("button", { name: /update all/i }));
    expect(onUpdateAll).toHaveBeenCalled();
  });

  it("calls onRemovePackage when Remove package is clicked", () => {
    const onRemovePackage = vi.fn();
    const { getByRole } = renderOverview({ onRemovePackage });
    fireEvent.click(getByRole("button", { name: /remove package/i }));
    expect(onRemovePackage).toHaveBeenCalled();
  });

  it("highlights members with pending updates", () => {
    const { getAllByTitle } = renderOverview({ membersWithUpdate: new Set(["b"]) });
    expect(getAllByTitle(/update available/i).length).toBeGreaterThan(0);
  });
});
