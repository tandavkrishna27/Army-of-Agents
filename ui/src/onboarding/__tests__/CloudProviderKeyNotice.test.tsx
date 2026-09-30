import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CloudProviderKeyNotice } from "../CloudProviderKeyNotice";

describe("CloudProviderKeyNotice", () => {
  it("routes to Settings -> Providers on cloud_auth", () => {
    render(<CloudProviderKeyNotice deploymentMode="cloud_auth" />);
    const link = screen.getByRole("link", { name: /providers/i });
    expect(link.getAttribute("href")).toBe("/settings?tab=providers");
    const text = screen.getByTestId("cloud-provider-key-notice").textContent ?? "";
    // Guidance is non-blocking / advisory.
    expect(text).toMatch(/isn't required|not required/i);
    // Provider keys power agents/Commander/embeddings, NOT extraction — extraction
    // is CLI-only (Decision #104 / CLAUDE.md Rule #11) and never reads a provider
    // key. The notice must not claim a provider key enables extraction.
    expect(text).not.toMatch(/extraction/i);
  });

  it("renders nothing on self-hosted (local_trusted)", () => {
    const { container } = render(<CloudProviderKeyNotice deploymentMode="local_trusted" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when deploymentMode is undefined (legacy/self-hosted)", () => {
    const { container } = render(<CloudProviderKeyNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
