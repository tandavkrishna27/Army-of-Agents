import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryItemTable, type MemoryItemTableRowData } from "../MemoryItemTable";

const rows: MemoryItemTableRowData[] = [
  {
    kind: "memory_item",
    id: "i1",
    title: "README.md",
    layer: "identity",
    status: "approved",
    modifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
    usedCount: 14,
    tokenEstimate: 310,
  },
  {
    kind: "asset",
    id: "a1",
    title: "logo.png",
    layer: "identity",
    mimeType: "image/png",
    modifiedAt: new Date(Date.now() - 11 * 86_400_000).toISOString(),
    usedCount: 4,
    sizeBytes: 142 * 1024,
  },
];

const baseProps = {
  rows,
  activeId: null,
  onSelect: () => {},
  sortBy: "modifiedAt" as const,
  sortDir: "desc" as const,
  onSortChange: () => {},
};

describe("MemoryItemTable", () => {
  it("renders all six column headers", () => {
    const { getByText } = render(<MemoryItemTable {...baseProps} />);
    expect(getByText("Name")).toBeInTheDocument();
    expect(getByText("Layer")).toBeInTheDocument();
    expect(getByText("Status")).toBeInTheDocument();
    expect(getByText("Modified")).toBeInTheDocument();
    expect(getByText("Used")).toBeInTheDocument();
    expect(getByText("Tokens")).toBeInTheDocument();
  });

  it("renders one row per item with title and used count", () => {
    const { getByText } = render(<MemoryItemTable {...baseProps} />);
    expect(getByText("README.md")).toBeInTheDocument();
    expect(getByText("logo.png")).toBeInTheDocument();
    expect(getByText("14×")).toBeInTheDocument();
    expect(getByText("4×")).toBeInTheDocument();
  });

  it("renders the file size label for asset rows in the Tokens column", () => {
    const { getByText } = render(<MemoryItemTable {...baseProps} />);
    // 142 KB
    expect(getByText(/142.*kB|142.*KB/)).toBeInTheDocument();
  });

  it("calls onSelect with id and kind when a row is clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <MemoryItemTable {...baseProps} onSelect={onSelect} />,
    );
    fireEvent.click(getByText("README.md"));
    expect(onSelect).toHaveBeenCalledWith("i1", "memory_item");
  });

  it("calls onSortChange when a sortable header is clicked", () => {
    const onSortChange = vi.fn();
    const { getByText } = render(
      <MemoryItemTable {...baseProps} onSortChange={onSortChange} />,
    );
    fireEvent.click(getByText("Name"));
    expect(onSortChange).toHaveBeenCalledWith("title");
  });

  it("highlights the active row with brand-active classes", () => {
    const { container } = render(
      <MemoryItemTable {...baseProps} activeId="i1" />,
    );
    const activeTr = container.querySelector('tr[data-active="true"]');
    expect(activeTr).toBeInTheDocument();
    expect(activeTr?.className).toContain("bg-brand/[0.08]");
  });
});
