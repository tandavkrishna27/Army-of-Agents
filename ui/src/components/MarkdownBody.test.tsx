import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

// MarkdownBody calls useTheme(), so it must render inside the app's
// ThemeProvider (same approach as markdown-editor-classes.test.tsx).
function renderWithTheme(ui: ReactNode) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("MarkdownBody — external link interception", () => {
  it("intercepts external http(s) links via onLinkOpen and prevents navigation", () => {
    const onLinkOpen = vi.fn();
    renderWithTheme(
      <MarkdownBody onLinkOpen={onLinkOpen}>{"See [the site](https://example.com)."}</MarkdownBody>,
    );
    const link = screen.getByText("the site");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onLinkOpen).toHaveBeenCalledWith("https://example.com");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("without onLinkOpen, renders a plain anchor (no interception)", () => {
    renderWithTheme(<MarkdownBody>{"See [site](https://example.com)."}</MarkdownBody>);
    expect(screen.getByText("site").closest("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("keeps the href on intercepted links (middle-click / copy still work)", () => {
    renderWithTheme(
      <MarkdownBody onLinkOpen={() => {}}>{"See [the site](https://example.com)."}</MarkdownBody>,
    );
    const anchor = screen.getByText("the site").closest("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("rel")).toBe("noreferrer");
  });

  it("does not intercept non-http(s) hrefs", () => {
    const onLinkOpen = vi.fn();
    renderWithTheme(
      <MarkdownBody onLinkOpen={onLinkOpen}>{"Mail [us](mailto:hi@example.com)."}</MarkdownBody>,
    );
    const link = screen.getByText("us");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onLinkOpen).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
