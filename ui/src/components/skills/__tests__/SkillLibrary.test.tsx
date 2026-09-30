// ui/src/components/skills/__tests__/SkillLibrary.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { SkillLibrary } from "../SkillLibrary";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

function skill(id: string, over: Partial<CompanySkillListItem> = {}): CompanySkillListItem {
  return {
    id,
    companyId: "c1",
    key: `k-${id}`,
    slug: id,
    name: `/${id}`,
    description: null,
    sourceType: "github",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: { owner: "garrytan", repo: "gstack" },
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    editable: false,
    editableReason: null,
    sourceLabel: "garrytan/gstack",
    sourceBadge: "github",
    sourcePath: null,
    ...over,
  } as CompanySkillListItem;
}

const skills = [
  skill("a"),
  skill("b"),
  skill("c"),
  skill("solo", {
    sourceType: "local_path",
    sourceBadge: "local",
    metadata: null,
    sourceLabel: "Local",
    name: "my-deploy-helper",
  }),
];

const baseProps = {
  skills,
  filter: "",
  selectedSkillId: null,
  selectedPackageId: null,
  homeActive: false,
  expandedPackageIds: new Set<string>(),
  packagesWithUpdate: new Set<string>(),
  onTogglePackage: vi.fn(),
};

function renderLib(over: Partial<typeof baseProps> = {}) {
  return render(
    <MemoryRouter>
      <SkillLibrary {...baseProps} {...over} />
    </MemoryRouter>,
  );
}

describe("SkillLibrary", () => {
  it("renders a Home row before library sections", () => {
    const { getByRole, getByText } = renderLib();
    const home = getByRole("link", { name: /home/i });
    expect(home).toHaveAttribute("href", "/ACME/skills");
    expect(home.compareDocumentPosition(getByText(/Standalone/))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("marks Home as current when the skills home route is active", () => {
    const { getByRole } = renderLib({ homeActive: true });
    expect(getByRole("link", { name: /home/i })).toHaveAttribute("aria-current", "page");
  });

  it("renders the Packages section with the gstack package", () => {
    const { getByText } = renderLib();
    expect(getByText("gstack")).toBeInTheDocument();
    expect(getByText(/Packages · 1/)).toBeInTheDocument();
  });

  it("keeps the Packages section header text-only", () => {
    const { getByText } = renderLib();
    const packagesHeader = getByText(/Packages/).closest("div");
    expect(packagesHeader?.querySelector("svg")).toBeNull();
  });

  it("separates Home from the package section with a divider", () => {
    const { getByRole, getByText } = renderLib();
    const home = getByRole("link", { name: /home/i });
    const packagesHeader = getByText(/Packages/).closest("div");
    expect(home.nextElementSibling?.className ?? "").toMatch(/border-t/);
    expect(home.nextElementSibling?.compareDocumentPosition(packagesHeader as Element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders the Standalone section with my-deploy-helper", () => {
    const { getByText } = renderLib();
    expect(getByText("my-deploy-helper")).toBeInTheDocument();
    expect(getByText(/Standalone · 1/)).toBeInTheDocument();
  });

  it("hides member skills when package is collapsed", () => {
    const { queryByText } = renderLib();
    expect(queryByText("/a")).toBeNull();
  });

  it("shows member skills when package is expanded", () => {
    const { getByText } = renderLib({
      expandedPackageIds: new Set(["garrytan/gstack"]),
    });
    expect(getByText("/a")).toBeInTheDocument();
    expect(getByText("/b")).toBeInTheDocument();
    expect(getByText("/c")).toBeInTheDocument();
  });

  it("calls onTogglePackage when chevron is clicked", () => {
    const onTogglePackage = vi.fn();
    const { getByLabelText } = renderLib({ onTogglePackage });
    fireEvent.click(getByLabelText(/expand gstack/i));
    expect(onTogglePackage).toHaveBeenCalledWith("garrytan/gstack");
  });

  it("filters skills by name (case-insensitive)", () => {
    const { queryByText, getByText } = renderLib({ filter: "deploy" });
    expect(getByText("my-deploy-helper")).toBeInTheDocument();
    // "gstack" package members /a /b /c shouldn't match "deploy"
    expect(queryByText("gstack")).toBeNull();
  });

  it("renders empty filter message when filter matches nothing", () => {
    const { getByText } = renderLib({ filter: "zzzzzz" });
    expect(getByText(/no skills match this filter/i)).toBeInTheDocument();
  });

  it("renders empty library message when there are no skills at all", () => {
    const { getByText } = renderLib({ skills: [] });
    expect(getByText(/no custom skills yet/i)).toBeInTheDocument();
  });

  it("highlights the active package row", () => {
    const { getByText } = renderLib({ selectedPackageId: "garrytan/gstack" });
    const pkgRow = getByText("gstack").closest("div");
    expect(pkgRow?.className ?? "").toMatch(/bg-accent/);
  });
});
