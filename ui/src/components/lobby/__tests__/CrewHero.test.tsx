import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CrewHero } from "../CrewHero";

describe("CrewHero", () => {
  it("renders 5 avatars (founder + 4 crew), each with one icon", () => {
    const { container } = render(<CrewHero />);
    expect(container.querySelectorAll("svg").length).toBe(5);
  });

  it("is decorative — the cluster is aria-hidden", () => {
    const { container } = render(<CrewHero />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("merges a passed className onto the cluster root", () => {
    const { container } = render(<CrewHero className="mt-2" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("mt-2");
  });
});
