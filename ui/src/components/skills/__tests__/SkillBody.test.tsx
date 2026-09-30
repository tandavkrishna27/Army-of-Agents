// ui/src/components/skills/__tests__/SkillBody.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { CompanySkillFileDetail } from "@armyofagents/shared";
import { SkillBody } from "../SkillBody";

// Mock complex deps that would need full provider trees
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

const mdFile: CompanySkillFileDetail = {
  skillId: "s1",
  path: "SKILL.md",
  kind: "skill",
  content: "---\nname: x\n---\n\n# Hello\n",
  language: "markdown",
  markdown: true,
  editable: true,
};

describe("SkillBody", () => {
  it("renders markdown preview when not editing and viewMode=preview", () => {
    const { container } = render(
      <SkillBody
        file={mdFile}
        editing={false}
        viewMode="preview"
        draft=""
        onDraftChange={vi.fn()}
      />,
    );
    // MarkdownBody mock renders h1 from "# Hello"
    expect(container.querySelector("h1")?.textContent).toMatch(/hello/i);
  });

  it("renders raw code in pre when viewMode=code", () => {
    const { container } = render(
      <SkillBody
        file={mdFile}
        editing={false}
        viewMode="code"
        draft=""
        onDraftChange={vi.fn()}
      />,
    );
    expect(container.querySelector("pre")?.textContent).toMatch(/# Hello/);
  });

  it("renders MarkdownEditor when editing && file.markdown", () => {
    const { container } = render(
      <SkillBody
        file={mdFile}
        editing={true}
        viewMode="preview"
        draft="# Draft"
        onDraftChange={vi.fn()}
      />,
    );
    // MarkdownEditor mock renders draft value
    const editor = container.querySelector("[data-testid='markdown-editor']");
    expect(editor?.textContent).toMatch(/Draft/);
  });

  it("renders View-on-GitHub fallback for non-SKILL.md with empty content", () => {
    const file: CompanySkillFileDetail = {
      ...mdFile,
      path: "references/foo.md",
      content: "",
      markdown: true,
    };
    const { getByRole } = render(
      <SkillBody
        file={file}
        editing={false}
        viewMode="preview"
        draft=""
        onDraftChange={vi.fn()}
        externalUrl="https://github.com/owner/repo/blob/main/references/foo.md"
      />,
    );
    expect(getByRole("link", { name: /view on github/i })).toBeInTheDocument();
  });

  it("renders an empty-message when file is null", () => {
    const { getByText } = render(
      <SkillBody
        file={null}
        editing={false}
        viewMode="preview"
        draft=""
        onDraftChange={vi.fn()}
      />,
    );
    expect(getByText(/select a file/i)).toBeInTheDocument();
  });
});
