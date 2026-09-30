import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryItemCardGrid } from "../MemoryItemCardGrid";
import type { MemoryItemCardData } from "../MemoryItemCard";

const rows: MemoryItemCardData[] = [
  {
    kind: "memory_item",
    id: "m1",
    title: "README",
    modifiedAt: new Date().toISOString(),
    content: "Body",
  },
  {
    kind: "asset",
    id: "a1",
    title: "logo.png",
    mimeType: "image/png",
    modifiedAt: new Date().toISOString(),
  },
];

describe("MemoryItemCardGrid", () => {
  it("renders one card per row", () => {
    const { getByText } = render(
      <MemoryItemCardGrid rows={rows} activeId={null} onSelect={() => {}} />,
    );
    expect(getByText("README")).toBeInTheDocument();
    expect(getByText("logo.png")).toBeInTheDocument();
  });

  it("forwards onSelect with id + kind from the clicked card", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <MemoryItemCardGrid rows={rows} activeId={null} onSelect={onSelect} />,
    );
    fireEvent.click(getByText("logo.png"));
    expect(onSelect).toHaveBeenCalledWith("a1", "asset");
  });

  it("marks the activeId row as active", () => {
    const { container } = render(
      <MemoryItemCardGrid rows={rows} activeId="m1" onSelect={() => {}} />,
    );
    // The active card carries the brand glow dot.
    expect(container.querySelector(".bg-brand.rounded-full")).toBeInTheDocument();
  });
});
