import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SecondarySidebar, type SecondarySidebarSection } from "../SecondarySidebar";

const SECTIONS: SecondarySidebarSection[] = [
  {
    title: "Layers",
    items: [
      { id: "id", label: "Identity", count: 3 },
      { id: "dm", label: "Domain", count: 12, active: true },
      { id: "ac", label: "Active Context", count: 8 },
      { id: "wk", label: "Working", count: 3 },
    ],
  },
  {
    title: "View",
    items: [
      { id: "approved", label: "Approved", count: 26 },
      { id: "archived", label: "Archived", count: 112 },
    ],
  },
];

describe("SecondarySidebar", () => {
  it("renders section titles when expanded", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    expect(container.textContent).toContain("Layers");
    expect(container.textContent).toContain("View");
  });

  it("renders all items with labels and counts when expanded", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("Domain");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("3");
  });

  it("active item has data-active=true and inset border", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    const active = container.querySelector("button[data-active='true']");
    expect(active).toBeInTheDocument();
    expect(active?.textContent).toContain("Domain");
  });

  it("hides section titles when collapsed", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} collapsed />);
    expect(container.textContent).not.toContain("Layers");
    expect(container.textContent).not.toContain("View");
  });

  it("collapsed state applies w-12 width", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} collapsed />);
    const root = container.querySelector("[role='navigation']");
    expect(root?.className).toContain("w-12");
    expect(root?.getAttribute("data-collapsed")).toBe("true");
  });

  it("expanded state applies w-[200px] width", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    const root = container.querySelector("[role='navigation']");
    expect(root?.className).toContain("w-[200px]");
    expect(root?.getAttribute("data-collapsed")).toBe("false");
  });

  it("collapsed items show first letter when no icon", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} collapsed />);
    // Items in collapsed state: Identity → "I", Domain → "D", Active Context → "A", Working → "W"
    const buttons = container.querySelectorAll("button[type='button']");
    // Find the first item buttons (not the collapse toggle)
    const itemButtons = Array.from(buttons).filter(
      (b) => !b.getAttribute("aria-label")?.match(/sidebar/i)
    );
    expect(itemButtons[0].textContent).toContain("I");
    expect(itemButtons[1].textContent).toContain("D");
  });

  it("clicking an item fires onClick", () => {
    const onClick = vi.fn();
    const sections: SecondarySidebarSection[] = [
      { items: [{ id: "x", label: "X", onClick }] },
    ];
    const { container } = render(<SecondarySidebar sections={sections} />);
    const button = container.querySelector("button[type='button']");
    fireEvent.click(button!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders collapse toggle when onToggleCollapse provided", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <SecondarySidebar sections={SECTIONS} onToggleCollapse={onToggle} />
    );
    const toggle = container.querySelector("button[aria-label='Collapse sidebar']");
    expect(toggle).toBeInTheDocument();
  });

  it("toggle aria-label flips based on collapsed state", () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <SecondarySidebar sections={SECTIONS} onToggleCollapse={onToggle} />
    );
    expect(container.querySelector("button[aria-label='Collapse sidebar']")).toBeInTheDocument();

    rerender(<SecondarySidebar sections={SECTIONS} onToggleCollapse={onToggle} collapsed />);
    expect(container.querySelector("button[aria-label='Expand sidebar']")).toBeInTheDocument();
  });

  it("toggle fires onToggleCollapse", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <SecondarySidebar sections={SECTIONS} onToggleCollapse={onToggle} />
    );
    const toggle = container.querySelector("button[aria-label='Collapse sidebar']");
    fireEvent.click(toggle!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not render toggle when onToggleCollapse not provided", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    expect(container.querySelector("button[aria-label*='sidebar']")).toBeNull();
  });

  it("headerless: collapse toggle is anchored to the top-right corner", () => {
    const { container } = render(
      <SecondarySidebar sections={SECTIONS} onToggleCollapse={vi.fn()} />
    );
    const toggle = container.querySelector("button[aria-label='Collapse sidebar']")!;
    const wrapper = toggle.parentElement!;
    expect(wrapper.className).toContain("absolute");
    expect(wrapper.className).toContain("right-2");
    expect(wrapper.className).toContain("top-3");
  });

  it("renders a panel header with the title and hosts the collapse toggle in it", () => {
    const { container } = render(
      <SecondarySidebar sections={SECTIONS} title="Marketplace" onToggleCollapse={vi.fn()} />
    );
    const header = container.querySelector("h2");
    expect(header?.textContent).toBe("Marketplace");
    // Panel-header size convention (14px semibold).
    expect(header?.className).toContain("text-[14px]");
    expect(header?.className).toContain("font-semibold");
    // With a header, there is no legacy top gap and no floating toggle wrapper.
    expect(container.querySelector("[role='navigation']")?.className).not.toContain("pt-16");
    const toggle = container.querySelector("button[aria-label='Collapse sidebar']")!;
    expect(toggle.parentElement?.className).not.toContain("absolute");
  });

  it("custom className merges through", () => {
    const { container } = render(
      <SecondarySidebar sections={SECTIONS} className="custom-sidebar" />
    );
    expect(container.querySelector("[role='navigation']")?.className).toContain("custom-sidebar");
  });

  it("default (non-floating) keeps the flush right border and no rounding", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} />);
    const root = container.querySelector("[role='navigation']")!;
    expect(root.className).toContain("border-r");
    expect(root.className).not.toContain("rounded-2xl");
  });

  it("floating variant is a rounded island with an all-sides border", () => {
    const { container } = render(<SecondarySidebar sections={SECTIONS} floating />);
    const root = container.querySelector("[role='navigation']")!;
    expect(root.className).toContain("rounded-2xl");
    expect(root.className).not.toContain("border-r");
  });
});
