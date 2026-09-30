import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceSubfilterChips } from "../MarketplaceSubfilterChips";

const SORT_OPTIONS = [
  { key: "all", label: "All" },
  { key: "featured", label: "Featured" },
  { key: "recent", label: "Recently added" },
  { key: "az", label: "A–Z" },
] as const;

describe("MarketplaceSubfilterChips", () => {
  it("renders all options", () => {
    render(<MarketplaceSubfilterChips value="all" onChange={vi.fn()} options={SORT_OPTIONS} />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /featured/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recently added/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a–z/i })).toBeInTheDocument();
  });

  it("highlights the selected option", () => {
    render(<MarketplaceSubfilterChips value="featured" onChange={vi.fn()} options={SORT_OPTIONS} />);
    expect(screen.getByRole("button", { name: /featured/i }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: /^all$/i }).getAttribute("data-active")).toBeNull();
  });

  it("calls onChange with the option key when clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MarketplaceSubfilterChips value="all" onChange={onChange} options={SORT_OPTIONS} />);
    await user.click(screen.getByRole("button", { name: /featured/i }));
    expect(onChange).toHaveBeenCalledWith("featured");
  });

  it("renders an optional count next to a label", () => {
    const opts = [
      { key: "all", label: "All", count: 50 },
      { key: "x", label: "X", count: 6 },
    ] as const;
    render(<MarketplaceSubfilterChips value="all" onChange={vi.fn()} options={opts} />);
    expect(screen.getByRole("button", { name: /^all/i }).textContent).toMatch(/50/);
    expect(screen.getByRole("button", { name: /^x/i }).textContent).toMatch(/6/);
  });
});
