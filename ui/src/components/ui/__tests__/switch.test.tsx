import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Switch } from "../switch";

describe("Switch", () => {
  it("renders without crashing", () => {
    const { container } = render(<Switch />);
    const root = container.querySelector("[role='switch']");
    expect(root).toBeInTheDocument();
  });

  it("applies size + brand classes by default", () => {
    const { container } = render(<Switch />);
    const root = container.querySelector("[role='switch']");
    expect(root?.className).toContain("h-[18px]");
    expect(root?.className).toContain("w-8");
    expect(root?.className).toContain("rounded-full");
  });

  it("custom className merges through", () => {
    const { container } = render(<Switch className="custom-class" />);
    const root = container.querySelector("[role='switch']");
    expect(root?.className).toContain("custom-class");
  });

  it("respects defaultChecked prop", () => {
    const { container } = render(<Switch defaultChecked />);
    const root = container.querySelector("[role='switch']");
    expect(root?.getAttribute("data-state")).toBe("checked");
  });
});
