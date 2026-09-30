// ui/src/components/skills/__tests__/SkillViewer.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillUpdateStatus,
} from "@armyofagents/shared";
import { SkillViewer } from "../SkillViewer";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

vi.mock("../../MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => {
    // Render the first # heading as h1 so tests can assert on it
    const h1 = /^#\s+(.+)$/m.exec(children);
    if (h1) return <h1>{h1[1]}</h1>;
    return <div>{children}</div>;
  },
}));

vi.mock("../../MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <div data-testid="markdown-editor">{value}</div>
  ),
}));

function makeDetail(over: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "s1",
    companyId: "c1",
    key: "k1",
    slug: "my-skill",
    name: "My Skill",
    description: "A test skill",
    markdown: "# hi",
    sourceType: "local_path",
    sourceLocator: "/tmp/my-skill",
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [
      { path: "SKILL.md", kind: "skill" },
      { path: "references/notes.md", kind: "reference" },
    ],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: "/tmp/my-skill",
    ...over,
  };
}

const mdFile: CompanySkillFileDetail = {
  skillId: "s1",
  path: "SKILL.md",
  kind: "skill",
  content: "# Hello",
  language: "markdown",
  markdown: true,
  editable: true,
};

const baseProps = {
  detail: makeDetail(),
  file: mdFile,
  fileLoading: false,
  selectedPath: "SKILL.md",
  updateStatus: null as CompanySkillUpdateStatus | null,
  onSelectPath: vi.fn(),
  onCheckUpdates: vi.fn(),
  onInstallUpdate: vi.fn(),
  checkUpdatesPending: false,
  installUpdatePending: false,
  onSave: vi.fn(),
  savePending: false,
  onDelete: vi.fn(),
};

function renderViewer(over: Partial<typeof baseProps> = {}) {
  return render(
    <MemoryRouter>
      <SkillViewer {...baseProps} {...over} />
    </MemoryRouter>,
  );
}

describe("SkillViewer", () => {
  it("renders the skill header and body", () => {
    const { getByText } = renderViewer();
    expect(getByText("My Skill")).toBeInTheDocument();
    expect(getByText("Hello")).toBeInTheDocument();
  });

  it("does not show file tree by default for multi-file skill", () => {
    const { queryByText } = renderViewer();
    expect(queryByText("references")).toBeNull();
  });

  it("toggles file tree when chevron clicked", () => {
    const { getByLabelText, getByText } = renderViewer();
    fireEvent.click(getByLabelText(/toggle file tree/i));
    expect(getByText("references")).toBeInTheDocument();
  });

  it("clicking another file calls onSelectPath and auto-collapses tree", () => {
    const onSelectPath = vi.fn();
    const { getByLabelText, getByText } = renderViewer({ onSelectPath });
    fireEvent.click(getByLabelText(/toggle file tree/i));
    fireEvent.click(getByText("references"));
    fireEvent.click(getByText("notes.md"));
    expect(onSelectPath).toHaveBeenCalledWith("references/notes.md");
  });

  it("entering edit mode swaps the path strip to Save/Cancel", () => {
    const { getByRole, queryByRole } = renderViewer();
    fireEvent.click(getByRole("button", { name: /edit/i }));
    expect(getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(queryByRole("button", { name: /^view$/i })).toBeNull();
  });

  it("calls onSave with the draft when Save is clicked", () => {
    const onSave = vi.fn();
    const { getByRole } = renderViewer({ onSave });
    fireEvent.click(getByRole("button", { name: /edit/i }));
    fireEvent.click(getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it("auto-exits edit mode when selectedPath changes", () => {
    const { getByRole, queryByRole, rerender } = renderViewer();
    fireEvent.click(getByRole("button", { name: /edit/i }));
    expect(getByRole("button", { name: /save/i })).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <SkillViewer
          {...baseProps}
          selectedPath="references/notes.md"
          file={{ ...mdFile, path: "references/notes.md" }}
        />
      </MemoryRouter>,
    );
    expect(queryByRole("button", { name: /save/i })).toBeNull();
  });
});
