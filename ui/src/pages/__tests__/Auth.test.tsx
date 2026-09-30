import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { AuthPage } from "../Auth";

const mockNavigate = vi.fn();
const routerState = vi.hoisted(() => ({ searchParams: new URLSearchParams("next=/onboarding") }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [routerState.searchParams],
}));

const getSession = vi.hoisted(() => vi.fn());
const signInSocial = vi.hoisted(() =>
  vi.fn(async () => ({ url: "https://accounts.google.com" })),
);
vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: (...a: unknown[]) => getSession(...a),
    signInSocial: (...a: unknown[]) => signInSocial(...a),
  },
}));

// The splash's constellation/typewriter sequence runs on real timers this
// suite doesn't drive — stub it out so gating tests can assert on whether it
// mounted at all, without waiting out its animation.
const splashOnDone = vi.hoisted(() => vi.fn());
vi.mock("@/onboarding/SplashScreen", () => ({
  SplashScreen: ({ onDone }: { onDone: () => void }) => {
    splashOnDone.mockImplementation(onDone);
    return <div data-testid="splash-screen" />;
  },
}));

const SPLASH_SEEN_KEY = "aoa.splashSeen";

describe("AuthPage", () => {
  const reloadSpy = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    routerState.searchParams = new URLSearchParams("next=/onboarding");
    getSession.mockResolvedValue(null);
    localStorage.clear();
    // Default to "already seen" so the pre-existing auth-flow assertions
    // below exercise the auth card directly; the splash-gating tests further
    // down clear/override this explicitly.
    localStorage.setItem(SPLASH_SEEN_KEY, "true");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "http://localhost/auth", assign: vi.fn(), reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    localStorage.clear();
  });

  function firePageShow(persisted: boolean) {
    const ev = new Event("pageshow");
    Object.defineProperty(ev, "persisted", { value: persisted });
    window.dispatchEvent(ev);
  }

  it("reloads on a bfcache restore so a stale 'Redirecting…' can't persist (live-QA)", async () => {
    renderWithProviders(<AuthPage />);
    await screen.findByText("Continue with Google");
    firePageShow(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a normal (non-bfcache) pageshow", async () => {
    renderWithProviders(<AuthPage />);
    await screen.findByText("Continue with Google");
    firePageShow(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("bounces an already-signed-in user to the next path", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    renderWithProviders(<AuthPage />);
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/onboarding", { replace: true }),
    );
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example/phish",
    String.raw`\\evil.example\phish`,
    "javascript:alert(1)",
  ])("does not redirect an existing session to an unsafe next target: %s", async (next) => {
    routerState.searchParams = new URLSearchParams({ next });
    getSession.mockResolvedValue({ user: { id: "u1" } });

    renderWithProviders(<AuthPage />);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("does not send an unsafe next target to the OAuth callback", async () => {
    routerState.searchParams = new URLSearchParams({ next: "https://evil.example/phish" });

    renderWithProviders(<AuthPage />);
    await screen.findByText("Continue with Google");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(signInSocial).toHaveBeenCalledWith("google", "/"));
  });

  it("renders a single centered 'Continue with Google' button — no split layout", async () => {
    renderWithProviders(<AuthPage />);
    await screen.findByText("Continue with Google");
    expect(screen.getAllByRole("button", { name: "Continue with Google" })).toHaveLength(1);
  });

  it("clicking Continue with Google still starts the OAuth flow with a safe next path", async () => {
    renderWithProviders(<AuthPage />);
    await screen.findByText("Continue with Google");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(signInSocial).toHaveBeenCalledWith("google", "/onboarding"));
  });

  describe("boot splash gating", () => {
    it("shows the splash on a first visit (no aoa.splashSeen) and reveals the auth card once it completes", async () => {
      localStorage.clear();
      renderWithProviders(<AuthPage />);

      await screen.findByTestId("splash-screen");
      expect(screen.queryByText("Continue with Google")).toBeNull();
      expect(localStorage.getItem(SPLASH_SEEN_KEY)).toBeNull();

      act(() => {
        splashOnDone();
      });

      await screen.findByText("Continue with Google");
      expect(screen.queryByTestId("splash-screen")).toBeNull();
      expect(localStorage.getItem(SPLASH_SEEN_KEY)).toBe("true");
    });

    it("does not show the splash when aoa.splashSeen is already set", async () => {
      localStorage.setItem(SPLASH_SEEN_KEY, "true");
      renderWithProviders(<AuthPage />);

      await screen.findByText("Continue with Google");
      expect(screen.queryByTestId("splash-screen")).toBeNull();
    });

    it("skips the splash under prefers-reduced-motion, even on a first visit", async () => {
      localStorage.clear();
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;

      try {
        renderWithProviders(<AuthPage />);
        await screen.findByText("Continue with Google");
        expect(screen.queryByTestId("splash-screen")).toBeNull();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it("does not show the splash when an already-signed-in session is redirecting away", async () => {
      localStorage.clear();
      getSession.mockResolvedValue({ user: { id: "u1" } });

      renderWithProviders(<AuthPage />);

      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith("/onboarding", { replace: true }),
      );
      expect(screen.queryByTestId("splash-screen")).toBeNull();
    });
  });
});
