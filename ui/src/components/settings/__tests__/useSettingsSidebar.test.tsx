import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import { useSettingsSidebar } from "../useSettingsSidebar";

const mockNavigate = vi.fn();
const mockGetHealth = vi.hoisted(() => vi.fn());
vi.mock("@/api/health", () => ({
  healthApi: { get: (...args: unknown[]) => mockGetHealth(...args) },
}));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function Harness({ activeKey }: { activeKey: any }) {
  const { pillItems } = useSettingsSidebar(activeKey);
  return (
    <div>
      {pillItems.map((p) => (
        <button
          key={p.id}
          data-testid={`pill-${p.id}`}
          data-active={p.active ? "1" : "0"}
          onClick={p.onClick}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function renderHook(activeKey: any) {
  let captured: ReactNode = null;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/instance/settings"]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{
                  setSecondarySidebar: (n: ReactNode) => {
                    captured = n;
                  },
                }}
              />
            }
          >
            <Route path="/instance/settings" element={<Harness activeKey={activeKey} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { getCaptured: () => captured };
}

describe("useSettingsSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
    });
  });

  it("renders all 8 settings sections with the active one flagged", async () => {
    renderHook("backups");
    for (const key of [
      "general",
      "health",
      "privacy",
      "backups",
      "heartbeats",
      "experimental",
      "plugins",
      "access",
    ]) {
      expect(await screen.findByTestId(`pill-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("pill-backups").getAttribute("data-active")).toBe("1");
    expect(screen.getByTestId("pill-general").getAttribute("data-active")).toBe("0");
  });

  it("navigates non-access sections to ?tab=<key>", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderHook("general");
    await user.click(await screen.findByTestId("pill-health"));
    expect(mockNavigate).toHaveBeenCalledWith("/instance/settings?tab=health");
  });

  it("navigates the Access section to /instance/access", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderHook("general");
    await user.click(await screen.findByTestId("pill-access"));
    expect(mockNavigate).toHaveBeenCalledWith("/instance/access");
  });

  it("pushes a SecondarySidebar node to the outlet context", () => {
    const { getCaptured } = renderHook("access");
    expect(getCaptured()).not.toBeNull();
  });

  it("hides tenant-sensitive sections in cloud mode", async () => {
    mockGetHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "cloud_auth",
    });
    renderHook("general");

    expect(await screen.findByTestId("pill-general")).toBeInTheDocument();
    expect(screen.queryByTestId("pill-heartbeats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pill-access")).not.toBeInTheDocument();
  });

  it("keeps tenant-sensitive sections hidden until deployment mode resolves", async () => {
    let resolveHealth!: (value: { status: string; deploymentMode: string }) => void;
    mockGetHealth.mockReturnValue(
      new Promise((resolve) => {
        resolveHealth = resolve;
      }),
    );
    renderHook("general");

    expect(screen.getByTestId("pill-general")).toBeInTheDocument();
    expect(screen.queryByTestId("pill-heartbeats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pill-access")).not.toBeInTheDocument();

    await act(async () => {
      resolveHealth({ status: "ok", deploymentMode: "authenticated" });
    });
    expect(await screen.findByTestId("pill-heartbeats")).toBeInTheDocument();
    expect(screen.getByTestId("pill-access")).toBeInTheDocument();
  });

  it("keeps tenant-sensitive sections hidden when health fails", async () => {
    mockGetHealth.mockRejectedValue(new Error("health unavailable"));
    renderHook("general");

    expect(await screen.findByTestId("pill-general")).toBeInTheDocument();
    expect(screen.queryByTestId("pill-heartbeats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pill-access")).not.toBeInTheDocument();
  });
});
