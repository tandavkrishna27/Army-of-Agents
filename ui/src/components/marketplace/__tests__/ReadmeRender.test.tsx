import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadmeRender } from "../ReadmeRender";

describe("ReadmeRender", () => {
  it("renders headings, paragraphs, lists", () => {
    const md = `# Title\n\nA paragraph.\n\n- one\n- two`;
    render(<ReadmeRender source={md} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("A paragraph.")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  it("renders GFM tables (remark-gfm enabled)", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |`;
    render(<ReadmeRender source={md} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("does NOT render raw HTML (XSS-safe)", () => {
    const md = `<script>alert('xss')</script>some text`;
    const { container } = render(<ReadmeRender source={md} />);
    expect(container.querySelector("script")).toBeNull();
  });
});
