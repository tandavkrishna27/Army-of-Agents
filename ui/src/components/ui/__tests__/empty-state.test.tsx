import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EmptyState } from "../empty-state";

describe("EmptyState", () => {
  it("renders with title", () => {
    const { container } = render(<EmptyState title="Nothing here yet" />);
    expect(container.textContent).toContain("Nothing here yet");
  });

  it("renders icon when provided", () => {
    const { container } = render(
      <EmptyState
        title="No tasks"
        icon={<span data-testid="my-icon">📋</span>}
      />
    );
    expect(container.querySelector("[data-testid='my-icon']")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    const { container } = render(
      <EmptyState title="X" description="Some helpful copy here" />
    );
    expect(container.textContent).toContain("Some helpful copy here");
  });

  it("renders action when provided", () => {
    const { container } = render(
      <EmptyState
        title="X"
        action={<button>Click me</button>}
      />
    );
    expect(container.querySelector("button")?.textContent).toBe("Click me");
  });

  it("first-time variant uses brand-tinted icon bg", () => {
    const { container } = render(
      <EmptyState
        title="X"
        icon={<span>i</span>}
        variant="first-time"
      />
    );
    const root = container.querySelector("[data-variant]");
    expect(root?.getAttribute("data-variant")).toBe("first-time");
    // The icon-wrapper div uses brand-wash bg + brand text
    const iconWrap = container.querySelectorAll("div")[1];
    expect(iconWrap?.className).toContain("bg-brand-wash");
  });

  it("no-results variant uses neutral icon bg", () => {
    const { container } = render(
      <EmptyState
        title="X"
        icon={<span>i</span>}
        variant="no-results"
      />
    );
    expect(container.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("no-results");
    const iconWrap = container.querySelectorAll("div")[1];
    expect(iconWrap?.className).toContain("bg-card-2");
  });

  it("custom className merges through", () => {
    const { container } = render(<EmptyState title="X" className="custom-empty" />);
    expect(container.querySelector("[data-variant]")?.className).toContain("custom-empty");
  });

  it("does not render icon block when no icon prop", () => {
    const { container } = render(<EmptyState title="X" />);
    // root div contains only the title (no icon wrap, no description, no action)
    const root = container.querySelector("[data-variant]");
    // first child should be the title div, not an icon wrap
    const firstChild = root?.firstElementChild;
    expect(firstChild?.textContent).toBe("X");
  });
});
