import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LoadingDots } from "../LoadingDots";

describe("LoadingDots", () => {
  it("reflects state in the wrapper class", () => {
    const { container, rerender } = render(<LoadingDots state="loading" />);
    expect(container.querySelector(".dots.loading")).toBeTruthy();
    rerender(<LoadingDots state="done" />);
    expect(container.querySelector(".dots.done")).toBeTruthy();
  });

  it("renders idle state", () => {
    const { container } = render(<LoadingDots state="idle" />);
    expect(container.querySelector(".dots.idle")).toBeTruthy();
  });

  it("is decorative (aria-hidden)", () => {
    const { container } = render(<LoadingDots state="loading" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
