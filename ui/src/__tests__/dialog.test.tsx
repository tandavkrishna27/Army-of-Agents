import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DialogBody } from "@/components/ui/dialog";

describe("DialogBody primitive", () => {
  it("renders children", () => {
    render(<DialogBody><span>hello</span></DialogBody>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("applies default px-7 py-4 padding", () => {
    const { container } = render(<DialogBody>x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.className).toContain("px-7");
    expect(body.className).toContain("py-4");
  });

  it("accepts className override that merges with defaults", () => {
    const { container } = render(<DialogBody className="bg-card-2">x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.className).toContain("px-7");
    expect(body.className).toContain("py-4");
    expect(body.className).toContain("bg-card-2");
  });

  it("has data-slot='dialog-body'", () => {
    const { container } = render(<DialogBody>x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.getAttribute("data-slot")).toBe("dialog-body");
  });
});
