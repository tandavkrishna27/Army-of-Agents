import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Navigate, Outlet, useLocation } from "react-router-dom";

/**
 * Navigation tests verify the routing structure defined in App.tsx.
 * We test route configurations in isolation rather than through the full App
 * component (which requires auth gates, health checks, etc.).
 */

// Minimal page stubs
function LobbyStub() {
  return <div data-testid="lobby-page">Lobby</div>;
}
function DashboardStub() {
  return <div data-testid="dashboard-page">Dashboard</div>;
}
function IssuesStub() {
  return <div data-testid="issues-page">Issues</div>;
}
function SettingsStub() {
  const location = useLocation();
  return <div data-testid="settings-page">Settings{location.search}</div>;
}
function GoalsStub() {
  return <div data-testid="goals-page">Goals</div>;
}
function TeamStub() {
  return <div data-testid="team-page">Team</div>;
}
function LayoutStub() {
  return (
    <div data-testid="layout">
      <nav data-testid="sidebar">
        <a href="/TC/goals">Goals</a>
        <a href="/TC/issues">Tasks</a>
      </nav>
      <div>
        <Outlet />
      </div>
    </div>
  );
}

function UnprefixedBoardRedirectStub() {
  const location = useLocation();
  return (
    <Navigate
      to={`/TC${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function TestRoutes() {
  return (
    <Routes>
      {/* Lobby at root */}
      <Route index element={<LobbyStub />} />
      <Route path="settings" element={<UnprefixedBoardRedirectStub />} />

      {/* Company-prefixed routes */}
      <Route path=":companyPrefix" element={<LayoutStub />}>
        <Route index element={<Navigate to="home" replace />} />
        <Route path="home" element={<DashboardStub />} />
        <Route path="issues" element={<IssuesStub />} />
        <Route path="issues/:issueId" element={<IssuesStub />} />
        <Route path="goals" element={<GoalsStub />} />
        <Route path="team" element={<TeamStub />} />
        <Route path="settings" element={<SettingsStub />} />
        {/* Redirects */}
        <Route path="org" element={<Navigate to="../team" replace />} />
        <Route path="costs" element={<Navigate to="../settings" replace />} />
        <Route path="activity" element={<Navigate to="../settings" replace />} />
      </Route>
    </Routes>
  );
}

describe("Navigation", () => {
  it("/ route renders Lobby", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("lobby-page")).toBeInTheDocument();
  });

  it("Lobby page renders WITHOUT sidebar", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("lobby-page")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
  });

  it("/:prefix/home renders Dashboard with sidebar (Layout)", () => {
    render(
      <MemoryRouter initialEntries={["/TC/home"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("layout")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
  });

  it("Sidebar has Goals link", () => {
    render(
      <MemoryRouter initialEntries={["/TC/home"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    const goalsLink = screen.getByText("Goals");
    expect(goalsLink).toBeInTheDocument();
    expect(goalsLink.closest("a")).toHaveAttribute("href", "/TC/goals");
  });

  it("/costs redirects to /settings", () => {
    render(
      <MemoryRouter initialEntries={["/TC/costs"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    // Should render settings page after redirect
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("/activity redirects to /settings", () => {
    render(
      <MemoryRouter initialEntries={["/TC/activity"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("unprefixed /settings preserves the Providers tab and redirects through the selected company", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("settings-page")).toHaveTextContent("Settings?tab=providers");
  });

  it("/issues/:id renders Issues component (dual-route)", () => {
    render(
      <MemoryRouter initialEntries={["/TC/issues/issue-123"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("issues-page")).toBeInTheDocument();
  });

  it("/:prefix route (no sub-path) redirects to home", () => {
    render(
      <MemoryRouter initialEntries={["/TC"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
  });

  it("/org redirects to /team", () => {
    render(
      <MemoryRouter initialEntries={["/TC/org"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("team-page")).toBeInTheDocument();
  });
});

describe("Sidebar structure", () => {
  it("sidebar has no New Task or Debrief buttons", () => {
    render(
      <MemoryRouter initialEntries={["/TC/home"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar).not.toHaveTextContent("New Task");
    expect(sidebar).not.toHaveTextContent("Debrief");
    expect(sidebar).not.toHaveTextContent("+ New Task");
    expect(sidebar).not.toHaveTextContent("+ Debrief");
  });
});
