import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The renderer's Link comes from @/lib/router which calls useCompany(); swap it
// out for the plain react-router-dom Link so no CompanyProvider is needed.
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, Link: actual.Link };
});
import { ToastProvider, useToast } from "../../context/ToastContext";
import { ToastViewport } from "../ToastViewport";

let push: ReturnType<typeof useToast>["pushToast"];
function Capture() {
  push = useToast().pushToast;
  return null;
}

function setup() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Capture />
        <ToastViewport />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("ToastViewport", () => {
  it("renders the full form (mono ref + action link) for entity toasts", () => {
    setup();
    act(() => {
      push({
        title: "Atlas",
        body: "Wire provider-switching seam",
        tone: "success",
        meta: { ref: "TASK-128" },
        action: { label: "View run", href: "/agents/a/runs/r" },
      });
    });
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("TASK-128")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View run/ })).toBeInTheDocument();
  });

  it("renders a compact single-line toast when there is no body or ref", () => {
    setup();
    act(() => { push({ title: "Pinned to cockpit", tone: "success" }); });
    expect(screen.getByText("Pinned to cockpit")).toBeInTheDocument();
    expect(screen.queryByText("TASK-128")).not.toBeInTheDocument();
  });

  it("renders the loading rail for a loading toast", () => {
    setup();
    act(() => { push({ title: "Installing Kitchen Sink", tone: "loading" }); });
    expect(screen.getByText("Installing Kitchen Sink")).toBeInTheDocument();
    expect(screen.getByTestId("toast-loading-rail")).toBeInTheDocument();
  });
});
