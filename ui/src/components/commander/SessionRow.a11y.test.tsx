import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionRow } from "./SessionRow";

const mockConv = {
  id: "conv-1",
  title: "Test Chat",
  updatedAt: new Date().toISOString(),
  pinned: false,
  archivedAt: null,
  sortOrder: null,
};

it("SessionRow root element does NOT independently set role=button or tabIndex", () => {
  const { container } = render(
    <SessionRow
      conversation={mockConv as any}
      isActive={false}
      onSelect={vi.fn()}
      onPin={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
    />
  );

  // The root div should NOT have role="button" — that belongs to the dnd-kit wrapper
  const root = container.firstElementChild!;
  expect(root.getAttribute("role")).not.toBe("button");
  expect(root.getAttribute("tabindex")).toBeNull();
});
