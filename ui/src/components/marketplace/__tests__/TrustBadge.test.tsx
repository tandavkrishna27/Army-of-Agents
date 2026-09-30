import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrustBadge } from "../TrustBadge";

describe("TrustBadge", () => {
  it("renders verified tier with green styling and label", () => {
    render(<TrustBadge tier="verified" />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    const badge = screen.getByText("Verified").closest("span");
    expect(badge?.className).toMatch(/green/);
  });

  it("renders community tier with blue styling", () => {
    render(<TrustBadge tier="community" />);
    expect(screen.getByText("Community")).toBeInTheDocument();
    const badge = screen.getByText("Community").closest("span");
    expect(badge?.className).toMatch(/blue/);
  });

  it("renders unverified tier with gray styling", () => {
    render(<TrustBadge tier="unverified" />);
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    const badge = screen.getByText("Unverified").closest("span");
    expect(badge?.className).toMatch(/gray/);
  });

  it("includes screen-reader label describing trust tier meaning", () => {
    render(<TrustBadge tier="verified" />);
    const srLabel = screen.getByText(/Reviewed and signed off by AoA team/);
    expect(srLabel.className).toContain("sr-only");
  });
});
