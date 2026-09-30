// ui/src/components/skills/__tests__/SkillLibraryRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SkillLibraryRow } from "../SkillLibraryRow";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

const baseProps = {
  skillId: "s1",
  to: "/skills/s1",
  name: "my-skill",
  badge: "local" as const,
  sourceLabel: null,
  active: false,
  onSelect: vi.fn(),
};

function renderRow(
  props: Partial<typeof baseProps> & { hideSourceIcon?: boolean; indent?: number; chip?: string } = {},
) {
  return render(
    <MemoryRouter>
      <SkillLibraryRow {...baseProps} {...props} />
    </MemoryRouter>,
  );
}

describe("SkillLibraryRow", () => {
  it("renders the skill name", () => {
    const { getByText } = renderRow();
    expect(getByText("my-skill")).toBeInTheDocument();
  });

  it("applies brand-wash class when active", () => {
    const { container } = renderRow({ active: true });
    const link = container.querySelector("a");
    expect(link?.getAttribute("class") ?? "").toMatch(/bg-brand\/10/);
  });

  it("renders source icon for standalone rows (hideSourceIcon=false)", () => {
    const { container } = renderRow();
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("hides source icon when hideSourceIcon=true (member-of-package layout)", () => {
    const { container } = renderRow({ hideSourceIcon: true });
    // Only the FileText fallback icon should remain
    const icons = container.querySelectorAll("svg");
    expect(icons.length).toBe(1);
  });

  it("applies indent style when indent is set", () => {
    const { container } = renderRow({ indent: 36 });
    const link = container.querySelector("a");
    expect(link?.getAttribute("style") ?? "").toMatch(/padding-left:\s*36px/);
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    const { container } = renderRow({ onSelect });
    fireEvent.click(container.querySelector("a")!);
    expect(onSelect).toHaveBeenCalledWith("s1");
  });
});
