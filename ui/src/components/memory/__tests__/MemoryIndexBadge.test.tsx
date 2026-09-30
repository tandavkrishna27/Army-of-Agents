import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryIndexBadge } from "../MemoryIndexBadge";

describe("MemoryIndexBadge", () => {
  it("renders 'Indexed' with icon for indexed status", () => {
    const { getByTestId, getByText } = render(
      <MemoryIndexBadge status="indexed" />,
    );
    expect(getByTestId("memory-index-status")).toBeInTheDocument();
    expect(getByText("Indexed")).toBeInTheDocument();
  });

  it("renders 'Indexing…' with spinner for pending status", () => {
    const { getByTestId, getByText } = render(
      <MemoryIndexBadge status="pending" />,
    );
    expect(getByTestId("memory-index-status")).toBeInTheDocument();
    expect(getByText("Indexing…")).toBeInTheDocument();
  });

  it("renders 'Not indexed' with icon for not_indexed status", () => {
    const { getByTestId, getByText } = render(
      <MemoryIndexBadge status="not_indexed" />,
    );
    expect(getByTestId("memory-index-status")).toBeInTheDocument();
    expect(getByText("Not indexed")).toBeInTheDocument();
  });

  it("renders 'Failed' with icon for failed status", () => {
    const { getByTestId, getByText } = render(
      <MemoryIndexBadge status="failed" />,
    );
    expect(getByTestId("memory-index-status")).toBeInTheDocument();
    expect(getByText("Failed")).toBeInTheDocument();
  });

  it("does NOT show Re-index button when onReindex is not provided", () => {
    const { queryByTestId } = render(
      <MemoryIndexBadge status="failed" />,
    );
    expect(queryByTestId("memory-reindex-button")).toBeNull();
  });

  it("shows Re-index button when status=failed and onReindex is provided", () => {
    const { getByTestId } = render(
      <MemoryIndexBadge status="failed" onReindex={() => {}} />,
    );
    expect(getByTestId("memory-reindex-button")).toBeInTheDocument();
  });

  it("calls onReindex when Re-index button is clicked", () => {
    const onReindex = vi.fn();
    const { getByTestId } = render(
      <MemoryIndexBadge status="failed" onReindex={onReindex} />,
    );
    fireEvent.click(getByTestId("memory-reindex-button"));
    expect(onReindex).toHaveBeenCalledTimes(1);
  });

  it("does NOT show Re-index button for indexed status even with onReindex", () => {
    const { queryByTestId } = render(
      <MemoryIndexBadge status="indexed" onReindex={() => {}} />,
    );
    expect(queryByTestId("memory-reindex-button")).toBeNull();
  });

  it("does NOT show Re-index button for pending status even with onReindex", () => {
    const { queryByTestId } = render(
      <MemoryIndexBadge status="pending" onReindex={() => {}} />,
    );
    expect(queryByTestId("memory-reindex-button")).toBeNull();
  });

  it("does NOT show Re-index button for not_indexed status even with onReindex", () => {
    const { queryByTestId } = render(
      <MemoryIndexBadge status="not_indexed" onReindex={() => {}} />,
    );
    expect(queryByTestId("memory-reindex-button")).toBeNull();
  });
});
