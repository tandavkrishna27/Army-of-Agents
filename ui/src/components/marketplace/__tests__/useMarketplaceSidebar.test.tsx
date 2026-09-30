import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import { useMarketplaceSidebar } from "../useMarketplaceSidebar";

const CATALOG = {
  items: [
    {
      id: "1",
      type: "skill",
      name: "a",
      description: "",
      source: { url: "https://github.com/garrytan/x" },
    },
    {
      id: "team:aoa-curated/default-crew",
      type: "team",
      name: "Default Crew",
      description: "",
      source: { url: "https://github.com/aoa-curated/y" },
      requires: [{ type: "agent", id: "agent:aoa-curated/steward" }],
    },
    {
      id: "agent:aoa-curated/steward",
      type: "agent",
      name: "Steward",
      description: "",
      source: { url: "https://github.com/aoa-curated/y" },
    },
    {
      id: "agent:aoa-curated/senior-engineer",
      type: "agent",
      name: "Senior Engineer",
      description: "",
      source: { url: "https://github.com/aoa-curated/y" },
    },
    {
      id: "plugin:aoa-curated/slack",
      type: "plugin",
      name: "Slack",
      description: "",
      source: { url: "https://github.com/aoa-curated/y" },
    },
    {
      id: "skill:aoa-curated/a",
      type: "skill",
      name: "AoA Skill",
      description: "",
      source: { url: "https://github.com/MeteoriteLabs/aoa-marketplace" },
    },
  ],
};
const PACKAGES = [
  {
    id: "MeteoriteLabs/aoa-marketplace",
    memberItemIds: ["skill:aoa-curated/a"],
  },
];
const { mockUsePackages } = vi.hoisted(() => ({
  mockUsePackages: vi.fn(),
}));
vi.mock("@/hooks/useCatalog", () => ({
  useCatalog: () => ({ data: CATALOG }),
}));
vi.mock("@/hooks/usePackages", () => ({
  usePackages: mockUsePackages,
}));
// @/lib/router useNavigate calls useCompany — stub CompanyContext.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
}));

function Harness({ activeKey }: { activeKey: any }) {
  const { pillItems } = useMarketplaceSidebar(activeKey);
  return (
    <div data-testid="pills">
      {pillItems.map((p) => `${p.id}:${p.count}:${p.active ? 1 : 0}`).join(",")}
    </div>
  );
}

function renderHook(activeKey: any) {
  let captured: ReactNode = null;
  render(
    <MemoryRouter initialEntries={["/marketplace"]}>
      <Routes>
        <Route
          element={
            <Outlet context={{ setSecondarySidebar: (n: ReactNode) => { captured = n; } }} />
          }
        >
          <Route path="/marketplace" element={<Harness activeKey={activeKey} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { getCaptured: () => captured };
}

describe("useMarketplaceSidebar", () => {
  beforeEach(() => {
    mockUsePackages.mockReturnValue({ data: PACKAGES, error: null });
  });

  it("counts relationship-derived AoA cards without swallowing standalone first-party items", () => {
    renderHook("home");
    const t = screen.getByTestId("pills").textContent!;
    expect(t).toContain("home:3"); // community skill + standalone agent + plugin
    expect(t).toContain("skill:1");
    expect(t).toContain("agent:1");
    expect(t).toContain("plugin:1");
    expect(t).toContain("team:0");
    expect(t).toContain("aoa:3"); // package + Default Crew + Steward
  });

  it("omits counts while package placement is unresolved", () => {
    mockUsePackages.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    renderHook("home");

    const text = screen.getByTestId("pills").textContent!;
    expect(text).toContain("home:undefined");
    expect(text).toContain("skill:undefined");
    expect(text).toContain("aoa:undefined");
    expect(text).not.toContain("home:4");
  });

  it("marks the active key", () => {
    renderHook("skill");
    expect(screen.getByTestId("pills").textContent).toContain("skill:1:1");
  });

  it("pushes a SecondarySidebar node to the outlet context", () => {
    const { getCaptured } = renderHook("aoa");
    expect(getCaptured()).not.toBeNull();
  });
});
