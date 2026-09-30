import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OutputRefChips } from "./OutputRefChips";
import type { CommanderOutputRef } from "@armyofagents/shared";

const refs: CommanderOutputRef[] = [
  { v: 1, kind: "artifact", id: "a1", versionId: "v1", versionNumber: 2, title: "GTM Plan", action: "created" },
  { v: 1, kind: "artifact", id: "abcdef123456", versionId: null, versionNumber: null, title: null, action: "referenced" },
];

describe("OutputRefChips", () => {
  it("renders a chip per ref with title, fallback label, and version badge", () => {
    render(<OutputRefChips refs={refs} onOpen={() => {}} />);
    expect(screen.getByText("GTM Plan")).toBeTruthy();
    expect(screen.getByText("artifact abcdef12")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
  });

  it("click calls onOpen with the ref", () => {
    const onOpen = vi.fn();
    render(<OutputRefChips refs={refs} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("GTM Plan"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("created chips get the accent style", () => {
    render(<OutputRefChips refs={refs} onOpen={() => {}} />);
    const created = screen.getByText("GTM Plan").closest("button")!;
    const referenced = screen.getByText("artifact abcdef12").closest("button")!;
    expect(created.className).toContain("border-primary");
    expect(created.className).not.toBe(referenced.className);
  });
});
