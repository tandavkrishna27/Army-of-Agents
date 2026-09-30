import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Avatar, AvatarFallback } from "../avatar";
import { avatarColorFor, initialsFor } from "@/lib/avatar-color";

const PALETTE = [
  "var(--data-teal)",
  "var(--data-indigo)",
  "var(--data-green)",
  "var(--data-amber)",
  "var(--data-magenta)",
  "var(--data-slate)",
];

describe("avatarColorFor", () => {
  it("is deterministic for the same seed", () => {
    expect(avatarColorFor("research-lead")).toBe(avatarColorFor("research-lead"));
    expect(avatarColorFor("agent-42")).toBe(avatarColorFor("agent-42"));
  });

  it("returns one of the 6 data-palette colors", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f", "longer-seed-string", "x".repeat(100)]) {
      expect(PALETTE).toContain(avatarColorFor(seed));
    }
  });

  it("returns a string for the empty seed (does not crash)", () => {
    expect(typeof avatarColorFor("")).toBe("string");
    expect(PALETTE).toContain(avatarColorFor(""));
  });

  it("distributes across multiple buckets", () => {
    // sanity: 50 different seeds should hit at least 2 distinct palette entries
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(avatarColorFor(`seed-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("initialsFor", () => {
  it("returns first two letters for a single-word name", () => {
    expect(initialsFor("Commander")).toBe("CO");
  });

  it("uses first letter of first + last word for multi-word", () => {
    expect(initialsFor("Research Lead")).toBe("RL");
    expect(initialsFor("Jane Doe")).toBe("JD");
  });

  it("handles 3+ words by taking first + last", () => {
    expect(initialsFor("Quality Assurance Runner")).toBe("QR");
  });

  it("collapses extra whitespace", () => {
    expect(initialsFor("  Research   Lead  ")).toBe("RL");
    expect(initialsFor("Jane\tDoe")).toBe("JD");
  });

  it("returns ? for empty / whitespace-only input", () => {
    expect(initialsFor("")).toBe("?");
    expect(initialsFor("   ")).toBe("?");
    expect(initialsFor("\t\n")).toBe("?");
  });

  it("uppercases lowercase input", () => {
    expect(initialsFor("research lead")).toBe("RL");
    expect(initialsFor("commander")).toBe("CO");
  });
});

describe("Avatar", () => {
  it("renders children when no helper props (legacy children-mode API)", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(container.textContent).toContain("JD");
  });

  it("auto-derives initials when name + seed provided (helper-mode API)", () => {
    const { container } = render(<Avatar name="Research Lead" seed="research-lead" />);
    expect(container.textContent).toContain("RL");
  });

  it("applies the xl size class", () => {
    const { container } = render(<Avatar size="xl" name="Test User" seed="test" />);
    const root = container.querySelector("[data-slot='avatar']");
    expect(root?.className).toContain("size-14");
  });

  it("applies the xs size class", () => {
    const { container } = render(<Avatar size="xs" name="Test" seed="test" />);
    const root = container.querySelector("[data-slot='avatar']");
    expect(root?.className).toContain("size-[18px]");
  });

  it("treats default as md (legacy alias)", () => {
    const { container } = render(
      <Avatar size="default">
        <AvatarFallback>X</AvatarFallback>
      </Avatar>
    );
    const root = container.querySelector("[data-slot='avatar']");
    expect(root?.className).toContain("size-8");
    // data-size is normalized to "md" so AvatarBadge group selectors hit it.
    expect(root?.getAttribute("data-size")).toBe("md");
  });

  it("custom className merges through (helper mode)", () => {
    const { container } = render(<Avatar name="X" seed="x" className="custom-avatar" />);
    const root = container.querySelector("[data-slot='avatar']");
    expect(root?.className).toContain("custom-avatar");
  });

  it("custom className merges through (children mode)", () => {
    const { container } = render(
      <Avatar className="legacy-class">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const root = container.querySelector("[data-slot='avatar']");
    expect(root?.className).toContain("legacy-class");
  });

  it("falls back to slate when no seed is provided in helper mode", () => {
    const { container } = render(<Avatar name="Anon" />);
    const fallback = container.querySelector("[data-slot='avatar-fallback']") as HTMLElement | null;
    expect(fallback?.style.backgroundColor).toBe("var(--data-slate)");
  });

  it("renders ? in helper mode when name is missing", () => {
    const { container } = render(<Avatar seed="some-id" />);
    expect(container.textContent).toContain("?");
  });
});
