import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PageHeader } from "../PageHeader";

describe("PageHeader", () => {
  it("renders title", () => {
    const { container } = render(<PageHeader title="Tasks" />);
    expect(container.textContent).toContain("Tasks");
    expect(container.querySelector("h1")).toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    const { container } = render(<PageHeader title="X" subtitle="38 active" />);
    expect(container.textContent).toContain("38 active");
  });

  it("renders breadcrumb above title", () => {
    const { container } = render(<PageHeader title="X" breadcrumb="Engineering · Tasks" />);
    expect(container.textContent).toContain("Engineering · Tasks");
    expect(container.textContent).toContain("X");
  });

  it("renders action row with primary action", () => {
    const { container } = render(
      <PageHeader title="X" primaryAction={<button>+ New</button>} />
    );
    expect(container.querySelector("button")?.textContent).toBe("+ New");
  });

  it("renders filters + search + actions all together", () => {
    const { container } = render(
      <PageHeader
        title="X"
        filters={<div data-testid="filters">filter pills</div>}
        search={<input data-testid="search" />}
        secondaryAction={<button data-testid="secondary">Mark read</button>}
        primaryAction={<button data-testid="primary">+ New</button>}
      />
    );
    expect(container.querySelector("[data-testid='filters']")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='search']")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='secondary']")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='primary']")).toBeInTheDocument();
  });

  it("does not render action row when no actions/filters/search", () => {
    const { container } = render(<PageHeader title="X" subtitle="just a header" />);
    // The flex-1 spacer would only exist if hasActionRow is true
    expect(container.querySelector(".flex-1")).toBeNull();
  });

  it("renders title element with brand styling classes", () => {
    const { container } = render(<PageHeader title="X" />);
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("font-bold");
    expect(h1?.className).toContain("tracking-[-0.025em]");
  });

  it("custom className merges through", () => {
    const { container } = render(<PageHeader title="X" className="custom-header" />);
    const root = container.firstChild as HTMLElement;
    expect(root?.className).toContain("custom-header");
  });
});
