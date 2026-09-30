import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { BrowserViewer } from "./BrowserViewer";

afterEach(cleanup);

describe("BrowserViewer scheme safety", () => {
  it("never renders a dangerous initialUrl as the iframe src", () => {
    const { queryByTestId } = render(<BrowserViewer initialUrl="javascript:alert(1)" />);
    const iframe = queryByTestId("thread-browser-iframe") as HTMLIFrameElement | null;
    expect(iframe?.getAttribute("src") ?? "about:blank").not.toContain("javascript:");
  });
  it("renders a safe initialUrl as the iframe src", () => {
    const { getByTestId } = render(<BrowserViewer initialUrl="https://example.com" />);
    expect(getByTestId("thread-browser-iframe").getAttribute("src")).toBe("https://example.com");
  });
  it("gates a javascript: URL typed in the URL bar (iframe src and external link both neutralized)", () => {
    const { getByTestId, getByLabelText } = render(<BrowserViewer initialUrl="about:blank" />);
    const input = getByTestId("thread-browser-url-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "javascript://alert(1)" } });
    fireEvent.submit(input.closest("form")!);
    expect(getByTestId("thread-browser-iframe").getAttribute("src")).toBe("about:blank");
    expect(getByLabelText("Open browser preview externally").getAttribute("href")).toBe("about:blank");
  });
});
