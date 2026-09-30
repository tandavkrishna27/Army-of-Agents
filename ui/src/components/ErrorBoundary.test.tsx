import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function CrashingChild(): never {
  throw new Error("render exploded");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/onboarding");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("renders a dark, focusable onboarding recovery surface with a support ID", () => {
    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(alert.parentElement).toHaveStyle({
      background: "#0a0a0a",
      color: "#eeeeee",
      colorScheme: "dark",
    });
    expect(screen.getByText("Support ID")).toBeVisible();
    expect(screen.getByText(/^ui-/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
  });

  it("releases the inline dark bootstrap only after the boundary commits", () => {
    document.documentElement.setAttribute("data-aoa-onboarding-boot", "dark");
    render(
      <ErrorBoundary>
        <div>ready</div>
      </ErrorBoundary>,
    );
    expect(document.documentElement).not.toHaveAttribute("data-aoa-onboarding-boot");
  });

  it("copies only the support ID", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    );

    const supportId = screen.getByText(/^ui-/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Copy support ID" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(supportId));
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  });
});
