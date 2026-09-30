import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryFolderRail } from "../MemoryFolderRail";

const zeroCounts = {
  pinned: 0, pending: 0, recent: 0, archived: 0,
  identity: 0, domain: 0, active_context: 0, working: 0,
};

describe("MemoryFolderRail", () => {
  it("renders 5 shortcuts + 4 layer = 9 buttons total", () => {
    const { container } = render(
      <MemoryFolderRail
        counts={{ pinned: 7, pending: 3, recent: 22, archived: 36, identity: 12, domain: 24, active_context: 8, working: 2 }}
        activeKind={null}
        onSelect={() => {}}
      />
    );
    expect(container.querySelectorAll("button")).toHaveLength(9);
  });

  it("renders pending badge with brand tone when count > 0", () => {
    const { container } = render(
      <MemoryFolderRail
        counts={{ ...zeroCounts, pending: 3 }}
        activeKind={null}
        onSelect={() => {}}
      />
    );
    expect(container.querySelector("[data-badge='pending']")).toHaveTextContent("3");
  });

  it("does not render a badge when count is 0", () => {
    const { container } = render(
      <MemoryFolderRail counts={zeroCounts} activeKind={null} onSelect={() => {}} />
    );
    expect(container.querySelector("[data-badge='pending']")).toBeNull();
  });

  it("calls onSelect with correct kind when a shortcut is clicked", () => {
    const onSelect = vi.fn();
    const { getByTitle } = render(
      <MemoryFolderRail counts={zeroCounts} activeKind={null} onSelect={onSelect} />
    );
    fireEvent.click(getByTitle("Pending Review"));
    expect(onSelect).toHaveBeenCalledWith("pending");
  });
});
