// ui/src/components/skills/__tests__/SkillFilePathStrip.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SkillFilePathStrip } from "../SkillFilePathStrip";

const baseProps = {
  filePath: "SKILL.md",
  fileCount: 1,
  treeExpanded: false,
  viewMode: "preview" as const,
  editing: false,
  hasUnsavedChanges: false,
  savePending: false,
  onToggleTree: vi.fn(),
  onViewMode: vi.fn(),
  onSave: vi.fn(),
  onCancel: vi.fn(),
};

describe("SkillFilePathStrip", () => {
  it("renders the file path and count", () => {
    const { getByText } = render(<SkillFilePathStrip {...baseProps} fileCount={5} />);
    expect(getByText("SKILL.md")).toBeInTheDocument();
    expect(getByText(/5 files in this skill/)).toBeInTheDocument();
  });

  it("shows View/Code toggle in non-editing mode", () => {
    const { getByRole } = render(<SkillFilePathStrip {...baseProps} />);
    expect(getByRole("button", { name: /view/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /code/i })).toBeInTheDocument();
  });

  it("shows Cancel and Save in editing mode", () => {
    const { getByRole, queryByRole } = render(
      <SkillFilePathStrip {...baseProps} editing={true} />,
    );
    expect(getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(queryByRole("button", { name: /^view$/i })).toBeNull();
  });

  it("shows the unsaved-dot text when hasUnsavedChanges=true", () => {
    const { getByText } = render(
      <SkillFilePathStrip {...baseProps} editing={true} hasUnsavedChanges={true} />,
    );
    expect(getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it("calls onToggleTree when the file tree toggle button is clicked (multi-file)", () => {
    const onToggleTree = vi.fn();
    const { getByRole } = render(
      <SkillFilePathStrip {...baseProps} fileCount={3} onToggleTree={onToggleTree} />,
    );
    fireEvent.click(getByRole("button", { name: /toggle file tree/i }));
    expect(onToggleTree).toHaveBeenCalled();
  });

  it("does not render tree toggle button when fileCount=1", () => {
    const onToggleTree = vi.fn();
    const { queryByRole } = render(
      <SkillFilePathStrip {...baseProps} fileCount={1} onToggleTree={onToggleTree} />,
    );
    expect(queryByRole("button", { name: /toggle file tree/i })).toBeNull();
  });
});
