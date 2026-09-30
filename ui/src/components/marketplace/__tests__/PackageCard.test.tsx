import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { MarketplacePackage } from "@armyofagents/shared";
import { PackageCard } from "../PackageCard";

function makePkg(overrides: Partial<MarketplacePackage> = {}): MarketplacePackage {
  return {
    id: "garrytan/gstack",
    name: "gstack",
    sourceUrl: "https://github.com/garrytan/gstack",
    memberItemIds: [
      "skill:github-skills/garrytan/gstack/office-hours",
      "skill:github-skills/garrytan/gstack/qa",
    ],
    count: 2,
    verified: true,
    explicit: false,
    ...overrides,
  };
}

function renderCard(pkg: MarketplacePackage, onInstallAll?: (pkg: MarketplacePackage) => void) {
  return render(
    <MemoryRouter>
      <PackageCard pkg={pkg} onInstallAll={onInstallAll} />
    </MemoryRouter>
  );
}

describe("PackageCard", () => {
  it("renders the package name and numeric item count", () => {
    renderCard(makePkg({ name: "gstack", count: 50 }));
    expect(screen.getByText("gstack")).toBeInTheDocument();
    expect(screen.getByLabelText(/50 items/i)).toHaveTextContent("50");
  });

  it("renders the PACKAGE type chip in the corner", () => {
    renderCard(makePkg());
    expect(screen.getByText("PACKAGE")).toBeInTheDocument();
  });

  it("groups the package label and item count in the corner badge", () => {
    const { container } = renderCard(makePkg({ name: "very-long-package-name", count: 50 }));
    const badge = container.querySelector('[data-testid="package-type-badge"]');
    const titleRow = container.querySelector('[data-testid="package-title-row"]');

    expect(badge).toHaveTextContent(/PACKAGE/i);
    expect(badge).toHaveTextContent("50");
    expect(titleRow).toHaveTextContent("very-long-package-name");
    expect(titleRow).not.toHaveTextContent("50");
  });

  it("uses StackedIcon with amber tone (3 layers)", () => {
    const { container } = renderCard(makePkg());
    expect(container.querySelectorAll('[data-stacked-layer]').length).toBe(3);
  });

  it("shows the provider logo instead of the stacked package icon when provider metadata exists", () => {
    const { container } = renderCard(makePkg({
      provider: {
        id: "gstack",
        name: "Garry Tan",
        logoUrl: "https://github.com/garrytan.png",
        fallbackInitials: "GT",
      },
    }));

    expect(screen.getByRole("img", { name: "Garry Tan logo" })).toHaveClass("size-12");
    expect(screen.queryByTestId("package-stacked-avatar")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-stacked-layer]').length).toBe(0);
    expect(screen.getByText(/by Garry Tan/)).toBeInTheDocument();
  });

  it("shows the verified-blue checkmark when pkg.verified is true", () => {
    const { container } = renderCard(makePkg({ verified: true }));
    expect(container.querySelector('[data-testid="package-verified"]')).toBeTruthy();
  });

  it("does NOT show the verified checkmark when pkg.verified is false", () => {
    const { container } = renderCard(makePkg({ verified: false }));
    expect(container.querySelector('[data-testid="package-verified"]')).toBeNull();
  });

  it("renders the github source as 'owner/repo'", () => {
    renderCard(makePkg({ sourceUrl: "https://github.com/garrytan/gstack" }));
    expect(screen.getByText("garrytan/gstack")).toBeInTheDocument();
  });

  it("renders the by-line with the owner extracted from sourceUrl", () => {
    renderCard(makePkg({ sourceUrl: "https://github.com/garrytan/gstack" }));
    expect(screen.getByText(/by garrytan/)).toBeInTheDocument();
  });

  it("links the whole card to /marketplace/package/{id}", () => {
    renderCard(makePkg({ id: "garrytan/gstack" }));
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/marketplace/package/garrytan/gstack");
  });

  it("renders an 'Install all' button on the footer", () => {
    renderCard(makePkg());
    expect(screen.getByRole("button", { name: /install all/i })).toBeInTheDocument();
  });

  it("clicking 'Install all' does not navigate (preventDefault)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(makePkg());
    const link = container.querySelector("a") as HTMLAnchorElement;
    const linkClickSpy = vi.fn();
    link.addEventListener("click", linkClickSpy);
    await user.click(screen.getByRole("button", { name: /install all/i }));
    const lastCall = linkClickSpy.mock.calls.at(-1);
    expect(lastCall?.[0]?.defaultPrevented).toBe(true);
  });

  it("calls onInstallAll when Install all is clicked", async () => {
    const user = userEvent.setup();
    const pkg = makePkg();
    const onInstallAll = vi.fn();
    renderCard(pkg, onInstallAll);

    await user.click(screen.getByRole("button", { name: /install all/i }));

    expect(onInstallAll).toHaveBeenCalledWith(pkg);
  });
});
