// ui/src/components/skills/__tests__/SkillsPageHeader.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SkillsPageHeader } from "../SkillsPageHeader";

const baseProps = {
  skillCount: 51,
  packageCount: 3,
  standaloneCount: 4,
  pendingUpdateCount: 0,
  unsavedCount: 0,
  filter: "",
  onFilterChange: vi.fn(),
  onScan: vi.fn(),
  onAddSkill: vi.fn(),
  scanPending: false,
};

describe("SkillsPageHeader", () => {
  it("renders the count summary", () => {
    const { getByText } = render(<SkillsPageHeader {...baseProps} />);
    expect(getByText(/51 across 3 packages.*4 standalone/)).toBeInTheDocument();
  });

  it("hides the updates chip when pendingUpdateCount=0", () => {
    const { queryByText } = render(<SkillsPageHeader {...baseProps} />);
    expect(queryByText(/\d+ updates?$/)).toBeNull();
  });

  it("shows the updates chip when pendingUpdateCount>0", () => {
    const { getByText } = render(
      <SkillsPageHeader {...baseProps} pendingUpdateCount={2} />,
    );
    expect(getByText(/2 updates/)).toBeInTheDocument();
  });

  it("shows the unsaved chip when unsavedCount>0", () => {
    const { getByText } = render(<SkillsPageHeader {...baseProps} unsavedCount={1} />);
    expect(getByText(/1 unsaved/)).toBeInTheDocument();
  });

  it("calls onFilterChange when the input changes", () => {
    const onFilterChange = vi.fn();
    const { getByPlaceholderText } = render(
      <SkillsPageHeader {...baseProps} onFilterChange={onFilterChange} />,
    );
    fireEvent.change(getByPlaceholderText(/filter/i), { target: { value: "design" } });
    expect(onFilterChange).toHaveBeenCalledWith("design");
  });

  it("disables the Scan button while scanPending", () => {
    const { getByRole } = render(<SkillsPageHeader {...baseProps} scanPending={true} />);
    expect(getByRole("button", { name: /scan/i })).toBeDisabled();
  });

  it("calls onAddSkill when the Add button is clicked", () => {
    const onAddSkill = vi.fn();
    const { getByRole } = render(
      <SkillsPageHeader {...baseProps} onAddSkill={onAddSkill} />,
    );
    fireEvent.click(getByRole("button", { name: /add skill/i }));
    expect(onAddSkill).toHaveBeenCalled();
  });
});
