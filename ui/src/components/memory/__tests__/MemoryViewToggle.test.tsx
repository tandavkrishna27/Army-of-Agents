import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryViewToggle } from "../MemoryViewToggle";

describe("MemoryViewToggle", () => {
  it("renders three buttons (List / Table / Cards)", () => {
    const { getByTitle } = render(<MemoryViewToggle mode="list" onChange={() => {}} />);
    expect(getByTitle("List view")).toBeInTheDocument();
    expect(getByTitle("Table view")).toBeInTheDocument();
    expect(getByTitle("Cards view")).toBeInTheDocument();
  });

  it("uses the radiogroup ARIA pattern with aria-checked", () => {
    const { container, getByTitle } = render(<MemoryViewToggle mode="table" onChange={() => {}} />);
    expect(container.querySelector('[role="radiogroup"]')).toBeInTheDocument();
    expect(getByTitle("Table view")).toHaveAttribute("role", "radio");
    expect(getByTitle("Table view")).toHaveAttribute("aria-checked", "true");
    expect(getByTitle("List view")).toHaveAttribute("aria-checked", "false");
    expect(getByTitle("Cards view")).toHaveAttribute("aria-checked", "false");
  });

  it("fires onChange with the new mode on click", () => {
    const onChange = vi.fn();
    const { getByTitle } = render(<MemoryViewToggle mode="list" onChange={onChange} />);
    fireEvent.click(getByTitle("Cards view"));
    expect(onChange).toHaveBeenCalledWith("cards");
    fireEvent.click(getByTitle("Table view"));
    expect(onChange).toHaveBeenCalledWith("table");
  });

  it("does not call onChange when the active mode is clicked again", () => {
    const onChange = vi.fn();
    const { getByTitle } = render(<MemoryViewToggle mode="list" onChange={onChange} />);
    fireEvent.click(getByTitle("List view"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
