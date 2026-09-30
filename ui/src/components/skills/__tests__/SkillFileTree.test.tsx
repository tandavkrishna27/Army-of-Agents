// ui/src/components/skills/__tests__/SkillFileTree.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { CompanySkillFileInventoryEntry } from "@armyofagents/shared";
import { SkillFileTree } from "../SkillFileTree";

const inventory: CompanySkillFileInventoryEntry[] = [
  { path: "SKILL.md", kind: "skill" },
  { path: "references/runbook.md", kind: "reference" },
  { path: "references/rollback-checklist.md", kind: "reference" },
  { path: "scripts/deploy.sh", kind: "script" },
];

describe("SkillFileTree", () => {
  it("renders SKILL.md at the root", () => {
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set()}
        onToggleDir={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("SKILL.md")).toBeInTheDocument();
  });

  it("renders directory rows for references and scripts", () => {
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set()}
        onToggleDir={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("references")).toBeInTheDocument();
    expect(getByText("scripts")).toBeInTheDocument();
  });

  it("hides children when their dir is collapsed", () => {
    const { queryByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set()}
        onToggleDir={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(queryByText("runbook.md")).toBeNull();
  });

  it("shows children when their dir is expanded", () => {
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set(["references"])}
        onToggleDir={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("runbook.md")).toBeInTheDocument();
    expect(getByText("rollback-checklist.md")).toBeInTheDocument();
  });

  it("calls onSelect with the file path when a file is clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set(["references"])}
        onToggleDir={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText("runbook.md"));
    expect(onSelect).toHaveBeenCalledWith("references/runbook.md");
  });

  it("calls onToggleDir when a directory is clicked", () => {
    const onToggleDir = vi.fn();
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="SKILL.md"
        expandedDirs={new Set()}
        onToggleDir={onToggleDir}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(getByText("references"));
    expect(onToggleDir).toHaveBeenCalledWith("references");
  });

  it("highlights the selected path with brand wash", () => {
    const { getByText } = render(
      <SkillFileTree
        inventory={inventory}
        selectedPath="references/runbook.md"
        expandedDirs={new Set(["references"])}
        onToggleDir={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const row = getByText("runbook.md").closest("button, a, div");
    expect(row?.className ?? "").toMatch(/bg-brand\/10/);
  });
});
