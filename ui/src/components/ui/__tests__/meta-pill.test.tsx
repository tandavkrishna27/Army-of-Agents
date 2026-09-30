import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MetaPill, MetaPillRow } from "../meta-pill";

describe("MetaPill", () => {
  it("renders children", () => {
    const { container } = render(<MetaPill>running</MetaPill>);
    expect(container.textContent).toContain("running");
  });

  it("applies pill styling", () => {
    const { container } = render(<MetaPill>x</MetaPill>);
    const el = container.querySelector("span");
    expect(el?.className).toContain("rounded");
    expect(el?.className).toContain("border");
  });

  it("mono prop adds font-mono", () => {
    const { container } = render(<MetaPill mono>$0.42</MetaPill>);
    expect(container.querySelector("span")?.className).toContain("font-mono");
  });

  it("custom className merges through", () => {
    const { container } = render(<MetaPill className="custom-pill">x</MetaPill>);
    expect(container.querySelector("span")).toHaveClass("custom-pill");
  });
});

describe("MetaPillRow", () => {
  it("renders children in flex container", () => {
    const { container } = render(
      <MetaPillRow>
        <MetaPill>a</MetaPill>
        <MetaPill>b</MetaPill>
      </MetaPillRow>
    );
    const row = container.querySelector("div");
    expect(row?.className).toContain("flex");
    expect(row?.querySelectorAll("span")).toHaveLength(2);
  });

  it("custom className merges", () => {
    const { container } = render(<MetaPillRow className="custom-row" />);
    expect(container.querySelector("div")).toHaveClass("custom-row");
  });
});
