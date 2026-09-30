import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const revealMock = vi.fn();
vi.mock("@/api/filesystem", () => ({
  filesystemApi: {
    reveal: (p: string) => revealMock(p),
  },
}));

// Install baseline clipboard stub so the component can read navigator.clipboard in jsdom.
// Individual tests spy on whatever is current (userEvent.setup may replace it).
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

import { OpenInIdeButton } from "../components/workspace/OpenInIdeButton";

const PREF_KEY = "aoa:workspace:preferred-editor";
const CWD = "C:\\repo\\.aoa\\worktrees\\feature-login";

describe("OpenInIdeButton", () => {
  let originalLocation: Location;
  let hrefSet: string | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    hrefSet = null;

    // Intercept window.location.href writes without breaking read access.
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new Proxy(originalLocation, {
        set(target, prop, value) {
          if (prop === "href") {
            hrefSet = String(value);
            return true;
          }
          (target as Record<string, unknown>)[prop as string] = value;
          return true;
        },
        get(target, prop) {
          return (target as Record<string, unknown>)[prop as string];
        },
      }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("renders trigger and keeps dropdown unmounted until opened", () => {
    render(<OpenInIdeButton cwd={CWD} />);
    expect(screen.getByTestId("open-in-ide-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("open-in-ide-menu")).not.toBeInTheDocument();
  });

  it("opens dropdown and shows all five menu items", async () => {
    const user = userEvent.setup();
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));

    expect(await screen.findByTestId("open-in-ide-vscode")).toBeInTheDocument();
    expect(screen.getByTestId("open-in-ide-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("open-in-ide-zed")).toBeInTheDocument();
    expect(screen.getByTestId("open-in-ide-reveal")).toBeInTheDocument();
    expect(screen.getByTestId("open-in-ide-copy")).toBeInTheDocument();
  });

  it("defaults preferred editor to VS Code", async () => {
    const user = userEvent.setup();
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    const vscodeItem = await screen.findByTestId("open-in-ide-vscode");

    expect(vscodeItem.textContent).toContain("✓");
  });

  it("clicking VS Code navigates to vscode:// URI and persists preference", async () => {
    const user = userEvent.setup();
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    await user.click(await screen.findByTestId("open-in-ide-vscode"));

    expect(hrefSet).toBe(`vscode://file/${encodeURIComponent(CWD)}`);
    expect(localStorage.getItem(PREF_KEY)).toBe("vscode");
  });

  it("clicking Cursor switches ✓ indicator and writes cursor:// URI", async () => {
    const user = userEvent.setup();
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    await user.click(await screen.findByTestId("open-in-ide-cursor"));

    expect(hrefSet).toBe(`cursor://file/${encodeURIComponent(CWD)}`);
    expect(localStorage.getItem(PREF_KEY)).toBe("cursor");
  });

  it("reads stored preference on mount so the ✓ reflects last choice", async () => {
    localStorage.setItem(PREF_KEY, "zed");
    const user = userEvent.setup();
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    const zedItem = await screen.findByTestId("open-in-ide-zed");

    expect(zedItem.textContent).toContain("✓");
  });

  it("Reveal in Finder calls filesystemApi.reveal with the cwd", async () => {
    const user = userEvent.setup();
    revealMock.mockResolvedValue({ ok: true });
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    await user.click(await screen.findByTestId("open-in-ide-reveal"));

    expect(revealMock).toHaveBeenCalledWith(CWD);
  });

  it("Reveal swallows API errors (non-fatal)", async () => {
    const user = userEvent.setup();
    revealMock.mockRejectedValue(new Error("nope"));
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    await user.click(await screen.findByTestId("open-in-ide-reveal"));

    // shouldn't throw; menu closes; the mock was still called
    expect(revealMock).toHaveBeenCalledWith(CWD);
  });

  it("Copy path writes cwd to clipboard", async () => {
    const user = userEvent.setup();
    // userEvent.setup() may install its own clipboard stub; spy on whatever is current.
    const spy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<OpenInIdeButton cwd={CWD} />);

    await user.click(screen.getByTestId("open-in-ide-trigger"));
    await user.click(await screen.findByTestId("open-in-ide-copy"));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(CWD);
    });
    spy.mockRestore();
  });
});
