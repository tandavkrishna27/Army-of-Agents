import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Building2 } from "lucide-react";
import { FolderTreeNode } from "../FolderTreeNode";

describe("FolderTreeNode active state", () => {
  it("applies brand wash classes when selected", () => {
    const { container } = render(
      <FolderTreeNode
        label="Identity"
        depth={0}
        expanded={false}
        selected={true}
        hasChildren={false}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    const row = container.querySelector('[role="treeitem"]');
    expect(row?.className).toContain("bg-brand/[0.08]");
    expect(row?.className).toContain("text-[hsl(15_60%_75%)]");
  });

  it("renders the brand glow dot when selected", () => {
    const { container } = render(
      <FolderTreeNode
        label="Identity"
        depth={0}
        expanded={false}
        selected={true}
        hasChildren={false}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector(".bg-brand.rounded-full")).toBeInTheDocument();
  });

  it("hides the glow dot when not selected", () => {
    const { container } = render(
      <FolderTreeNode
        label="Identity"
        depth={0}
        expanded={false}
        selected={false}
        hasChildren={false}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector(".bg-brand.rounded-full")).toBeNull();
  });
});

describe("FolderTreeNode count tone", () => {
  it("renders count with default muted styling when countTone omitted", () => {
    const { container } = render(
      <FolderTreeNode label="Pinned" count={7} depth={0} expanded={false}
        selected={false} hasChildren={false} onToggleExpand={() => {}} onSelect={() => {}} />,
    );
    const countSpan = container.querySelector("span.text-\\[10px\\].tabular-nums");
    expect(countSpan).toBeTruthy();
    expect(countSpan?.className).toContain("text-muted-foreground");
    expect(countSpan?.className).not.toContain("bg-brand");
  });

  it("renders count with brand-red pill when countTone='brand'", () => {
    const { container } = render(
      <FolderTreeNode label="Pending Review" count={3} countTone="brand" depth={0} expanded={false}
        selected={false} hasChildren={false} onToggleExpand={() => {}} onSelect={() => {}} />,
    );
    const countSpan = container.querySelector("span.text-\\[10px\\].tabular-nums");
    expect(countSpan).toBeTruthy();
    expect(countSpan?.className).toContain("bg-brand/[0.08]");
    expect(countSpan?.className).toContain("text-[hsl(15_60%_75%)]");
  });
});

describe("FolderTreeNode iconTone", () => {
  it("applies iconTone via inline style on the icon span", () => {
    const { container } = render(
      <FolderTreeNode
        label="Domain"
        icon={Building2}
        iconTone="var(--data-teal)"
        depth={0}
        expanded={false}
        selected={false}
        hasChildren={false}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    // The icon span carries a flex-shrink-0 class and Lucide svg child
    const iconSpan = container.querySelector("span.flex-shrink-0.text-sm");
    expect(iconSpan).toBeTruthy();
    expect((iconSpan as HTMLElement).style.color).toBe("var(--data-teal)");
  });

  it("does not set inline color on the icon span when iconTone is absent", () => {
    const { container } = render(
      <FolderTreeNode
        label="Folder"
        depth={0}
        expanded={false}
        selected={false}
        hasChildren={false}
        onToggleExpand={() => {}}
        onSelect={() => {}}
      />,
    );
    const iconSpan = container.querySelector("span.flex-shrink-0.text-sm");
    expect(iconSpan).toBeTruthy();
    expect((iconSpan as HTMLElement).style.color).toBe("");
  });
});
