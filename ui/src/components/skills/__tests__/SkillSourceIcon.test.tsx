// ui/src/components/skills/__tests__/SkillSourceIcon.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SkillSourceIcon } from "../SkillSourceIcon";

describe("SkillSourceIcon", () => {
  it("renders an svg for github source", () => {
    const { container } = render(<SkillSourceIcon badge="github" sourceLabel="garrytan/gstack" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toMatch(/text-slate-/);
  });

  it("uses amber tone for skills.sh-managed github URLs", () => {
    const { container } = render(<SkillSourceIcon badge="github" sourceLabel="vercel-labs/skills" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toMatch(/text-amber-/);
  });

  it("uses teal tone for local source", () => {
    const { container } = render(<SkillSourceIcon badge="local" sourceLabel={null} />);
    expect(container.querySelector("svg")?.getAttribute("class")).toMatch(/text-teal-/);
  });

  it("respects size prop via className", () => {
    const { container } = render(
      <SkillSourceIcon badge="local" sourceLabel={null} className="size-5" />,
    );
    expect(container.querySelector("svg")?.getAttribute("class")).toMatch(/size-5/);
  });

  it("includes a screen-reader-only label", () => {
    const { getByText } = render(<SkillSourceIcon badge="local" sourceLabel={null} />);
    expect(getByText("Local skill").className).toContain("sr-only");
  });
});
