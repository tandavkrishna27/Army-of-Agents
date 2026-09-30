import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useOutletContext } from "react-router-dom";
import { LobbyLayout, type LobbyOutletContext } from "../LobbyLayout";

// Mock the sidebar (its useNavigate needs company context we don't care about here).
vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: ({ activeItem }: any) => (
    <aside data-testid="lobby-sidebar" data-active={activeItem} />
  ),
}));
// LobbyLayout uses @/lib/router's useNavigate (C13), which reads useCompany.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
}));

function Child() {
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  return (
    <button type="button" onClick={() => setSecondarySidebar(<div data-testid="secondary" />)}>
      set
    </button>
  );
}

function renderAt(path: string, child: React.ReactNode = <div>content</div>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<LobbyLayout />}>
          <Route path="*" element={child} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("LobbyLayout", () => {
  it("renders a LobbySidebar with activeItem derived from the route", () => {
    renderAt("/marketplace");
    const bars = screen.getAllByTestId("lobby-sidebar");
    expect(bars.some((b) => b.getAttribute("data-active") === "marketplace")).toBe(true);
  });

  it("derives settings activeItem for /instance/settings", () => {
    renderAt("/instance/settings");
    const bars = screen.getAllByTestId("lobby-sidebar");
    expect(bars.some((b) => b.getAttribute("data-active") === "settings")).toBe(true);
  });

  it("lets a child fill the secondary-sidebar slot via outlet context", async () => {
    const user = userEvent.setup();
    renderAt("/instance/settings", <Child />);
    expect(screen.queryByTestId("secondary")).toBeNull();
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(screen.getByTestId("secondary")).toBeInTheDocument();
  });
});
