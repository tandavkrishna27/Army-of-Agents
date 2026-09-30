import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryItemRow, type MemoryItemRowData } from "../MemoryItemRow";

const baseItem: MemoryItemRowData = {
  kind: "memory_item",
  id: "i1",
  title: "README.md",
  category: "decision",
  status: "approved",
  modifiedAt: new Date().toISOString(),
  content: "Always pair a new agent with an existing trusted agent for the first three tasks.",
};

const baseAsset: MemoryItemRowData = {
  kind: "asset",
  id: "a1",
  title: "logo.png",
  mimeType: "image/png",
  modifiedAt: new Date().toISOString(),
};

describe("MemoryItemRow", () => {
  it("renders title and snippet for a memory item", () => {
    const { getByText, getByRole } = render(
      <MemoryItemRow row={baseItem} active={false} onSelect={() => {}} />,
    );
    expect(getByRole("button")).toBeInTheDocument();
    expect(getByText("README.md")).toBeInTheDocument();
    expect(getByText(/Always pair a new agent/)).toBeInTheDocument();
  });

  it("renders status + category chips for a memory item", () => {
    const { getByText } = render(
      <MemoryItemRow row={baseItem} active={false} onSelect={() => {}} />,
    );
    expect(getByText("decision")).toBeInTheDocument();
    expect(getByText("approved")).toBeInTheDocument();
  });

  it("renders mime type chip for an asset", () => {
    const { getByText } = render(
      <MemoryItemRow row={baseAsset} active={false} onSelect={() => {}} />,
    );
    expect(getByText("logo.png")).toBeInTheDocument();
    expect(getByText("image/png")).toBeInTheDocument();
  });

  it("calls onSelect with id and kind when clicked", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <MemoryItemRow row={baseItem} active={false} onSelect={onSelect} />,
    );
    fireEvent.click(getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("i1", "memory_item");
  });

  it("applies brand-active background and glow dot when active=true", () => {
    const { getByRole, container } = render(
      <MemoryItemRow row={baseItem} active={true} onSelect={() => {}} />,
    );
    expect(getByRole("button").className).toContain("bg-brand/[0.08]");
    expect(container.querySelector(".bg-brand.rounded-full")).toBeInTheDocument();
  });

  it("does not render the glow dot when active=false", () => {
    const { container } = render(
      <MemoryItemRow row={baseItem} active={false} onSelect={() => {}} />,
    );
    expect(container.querySelector(".bg-brand.rounded-full")).toBeNull();
  });

  it("omits snippet line when content is empty", () => {
    const { container } = render(
      <MemoryItemRow row={{ ...baseItem, content: "" }} active={false} onSelect={() => {}} />,
    );
    expect(container.querySelector(".line-clamp-2")).toBeNull();
  });

  it("shows a pending item's destination folder", () => {
    const pendingItem: MemoryItemRowData = {
      ...baseItem,
      status: "pending",
      folderPath: "engineering/Decisions",
    };
    const { getByText } = render(
      <MemoryItemRow row={pendingItem} active={false} onSelect={() => {}} />,
    );
    expect(getByText(/engineering\/Decisions/)).toBeInTheDocument();
  });

  it("shows 'unfiled' for a pending item with no folderPath", () => {
    const pendingItem: MemoryItemRowData = {
      ...baseItem,
      status: "pending",
      folderPath: null,
    };
    const { getByText } = render(
      <MemoryItemRow row={pendingItem} active={false} onSelect={() => {}} />,
    );
    expect(getByText(/unfiled/i)).toBeInTheDocument();
  });

  it("marks a pending item with a stable data-pending hook", () => {
    const pendingItem: MemoryItemRowData = {
      ...baseItem,
      title: "We ship on Fridays",
      status: "pending",
      folderPath: "engineering/Decisions",
    };
    const { getByText } = render(
      <MemoryItemRow row={pendingItem} active={false} onSelect={() => {}} />,
    );
    const el = getByText(/We ship on Fridays/);
    expect(el.closest("[data-pending='true']")).toBeTruthy();
  });

  it("does not show the destination label or pending hook for an approved item", () => {
    const { queryByText, getByRole } = render(
      <MemoryItemRow row={baseItem} active={false} onSelect={() => {}} />,
    );
    expect(queryByText(/unfiled/i)).toBeNull();
    expect(getByRole("button").getAttribute("data-pending")).toBeNull();
  });
});
