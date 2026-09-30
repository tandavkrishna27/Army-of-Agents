import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryItemCard, type MemoryItemCardData } from "../MemoryItemCard";

const markdown: MemoryItemCardData = {
  kind: "memory_item",
  id: "m1",
  title: "Operating principles",
  category: "policy",
  status: "approved",
  modifiedAt: new Date().toISOString(),
  content: "Identity layer changes require founder approval. Domain layer changes can be approved by team leads.",
};

const image: MemoryItemCardData = {
  kind: "asset",
  id: "img1",
  title: "logo.png",
  mimeType: "image/png",
  modifiedAt: new Date().toISOString(),
};

const pdf: MemoryItemCardData = {
  kind: "asset",
  id: "p1",
  title: "deck.pdf",
  mimeType: "application/pdf",
  modifiedAt: new Date().toISOString(),
  extractedText: "Acme Robotics — building AI-native operating tools for solo founders. Q2 2026 raise.",
  pageCount: 12,
  chunkCount: 12,
};

const generic: MemoryItemCardData = {
  kind: "asset",
  id: "g1",
  title: "weights.bin",
  mimeType: "application/octet-stream",
  modifiedAt: new Date().toISOString(),
};

describe("MemoryItemCard", () => {
  it("renders the markdown variant: title + snippet + chips, no thumbnail", () => {
    const { getByText, container } = render(
      <MemoryItemCard row={markdown} active={false} onSelect={() => {}} />,
    );
    expect(getByText("Operating principles")).toBeInTheDocument();
    expect(getByText(/Identity layer changes/)).toBeInTheDocument();
    expect(container.querySelector("[data-card-thumb]")).toBeNull();
  });

  it("renders the image variant: gradient thumb + title + mime chip", () => {
    const { getByText, container } = render(
      <MemoryItemCard row={image} active={false} onSelect={() => {}} />,
    );
    expect(getByText("logo.png")).toBeInTheDocument();
    expect(getByText("image/png")).toBeInTheDocument();
    expect(container.querySelector('[data-card-thumb="image"]')).toBeInTheDocument();
  });

  it("renders the pdf variant: page-of-N header + extracted text + chunk count chip", () => {
    const { getByText, container } = render(
      <MemoryItemCard row={pdf} active={false} onSelect={() => {}} />,
    );
    expect(getByText("deck.pdf")).toBeInTheDocument();
    expect(getByText(/page 1 of 12/)).toBeInTheDocument();
    expect(getByText(/Acme Robotics/)).toBeInTheDocument();
    expect(getByText(/12 chunks/)).toBeInTheDocument();
    expect(container.querySelector('[data-card-thumb="pdf"]')).toBeInTheDocument();
  });

  it("renders the generic variant: file thumb + mime chip", () => {
    const { getByText, container } = render(
      <MemoryItemCard row={generic} active={false} onSelect={() => {}} />,
    );
    expect(getByText("weights.bin")).toBeInTheDocument();
    expect(container.querySelector('[data-card-thumb="generic"]')).toBeInTheDocument();
  });

  it("calls onSelect with id and kind when clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <MemoryItemCard row={markdown} active={false} onSelect={onSelect} />,
    );
    fireEvent.click(getByText("Operating principles"));
    expect(onSelect).toHaveBeenCalledWith("m1", "memory_item");
  });

  it("applies brand-active border + glow dot when active=true", () => {
    const { container } = render(
      <MemoryItemCard row={markdown} active={true} onSelect={() => {}} />,
    );
    const card = container.querySelector('[role="button"]');
    expect(card?.className).toContain("border-brand");
    expect(card?.className).toContain("bg-brand/[0.08]");
    expect(container.querySelector(".bg-brand.rounded-full")).toBeInTheDocument();
  });

  it("does not render the glow dot when active=false", () => {
    const { container } = render(
      <MemoryItemCard row={markdown} active={false} onSelect={() => {}} />,
    );
    expect(container.querySelector(".bg-brand.rounded-full")).toBeNull();
  });
});
