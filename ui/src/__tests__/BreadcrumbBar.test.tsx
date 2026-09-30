import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Neutralize the company-prefixed Link/useNavigate so the test doesn't need a CompanyProvider.
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
  };
});

import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";

vi.mock("@/context/BreadcrumbContext", async () => {
  const actual = await vi.importActual<typeof import("@/context/BreadcrumbContext")>("@/context/BreadcrumbContext");
  return {
    ...actual,
    useBreadcrumbs: () => ({
      breadcrumbs: [
        { label: "Q4 launch", href: "/P4/projects/q4-launch" },
        { label: "Tasks" },
      ],
      subtitle: undefined,
      entityColor: undefined,
      setBreadcrumbs: vi.fn(),
    }),
  };
});

function renderBar() {
  return render(
    <MemoryRouter>
      <BreadcrumbProvider>
        <SidebarProvider>
          <ThemeProvider>
            <BreadcrumbBar />
          </ThemeProvider>
        </SidebarProvider>
      </BreadcrumbProvider>
    </MemoryRouter>,
  );
}

describe("BreadcrumbBar — Phase G slim", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders just the search button on the right (no theme toggle, no Commander button)", () => {
    renderBar();
    expect(screen.getByLabelText(/search/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/dark mode|light mode|switch to/i)).toBeNull();
    expect(screen.queryByLabelText(/commander/i)).toBeNull();
  });

  it("renders last-2-breadcrumbs as a slim trail with middot separator", () => {
    renderBar();
    expect(screen.getByText("Q4 launch")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    const container = screen.getByText("Tasks").parentElement;
    expect(container?.textContent).toContain("·");
  });

  it("hamburger is gated md:hidden (desktop hides it via CSS)", () => {
    renderBar();
    const menuButton = screen.queryByLabelText(/open sidebar|toggle sidebar/i);
    if (menuButton) {
      expect(menuButton.className).toContain("md:hidden");
    }
  });
});
