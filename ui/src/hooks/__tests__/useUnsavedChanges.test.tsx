import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Outlet, Link } from "react-router-dom";
import { UnsavedChangesProvider } from "../../context/UnsavedChangesProvider";
import { useUnsavedChanges } from "../useUnsavedChanges";

// jsdom + the repo's undici override disagree on the AbortSignal class, so the
// `new Request(url, { signal })` that react-router data routers build for a
// COMPLETING navigation throws "Expected signal to be an instance of
// AbortSignal". (Blocked navs never build a Request, which is why they're fine.)
// Provide a lenient Request that exposes the fields RR reads without validating
// the signal, so navigations complete and we can assert the no-block paths.
// Fidelity caveat: RR behaviour that depends on a real Request/AbortSignal
// (e.g. abort-on-supersede) is therefore NOT exercised here — the real
// popstate/navigation path is covered by tests/e2e/agent-unsaved-guard.spec.ts.
class TestRequest {
  url: string;
  method: string;
  headers: Headers;
  signal: unknown;
  body: unknown;
  constructor(input: unknown, init: Record<string, unknown> = {}) {
    this.url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? "");
    this.method = (init.method as string) ?? "GET";
    this.headers = new Headers((init.headers as HeadersInit) ?? {});
    this.signal = init.signal;
    this.body = init.body ?? null;
  }
  clone() {
    return new TestRequest(this.url, {
      method: this.method,
      headers: this.headers,
      signal: this.signal,
      body: this.body,
    });
  }
}
vi.stubGlobal("Request", TestRequest);

// A bare registrant — registers a dirty flag with the global guard, renders nothing.
function Registrant({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(dirty);
  return null;
}

function DirtyPage({ dirty, to = "/other" }: { dirty: boolean; to?: string }) {
  useUnsavedChanges(dirty);
  return (
    <div>
      <h1>Dirty Page</h1>
      <Link to={to}>go {to}</Link>
    </div>
  );
}

function OtherPage() {
  return <h1>Other Page</h1>;
}

function renderRoutes(rootElement: React.ReactNode, initial = "/") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "/", element: rootElement },
          { path: "/other", element: <OtherPage /> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  return render(<RouterProvider router={router} />);
}

describe("useUnsavedChanges + UnsavedChangesProvider", () => {
  it("dirty + cross-path <Link> → shows the confirm dialog and holds the URL", async () => {
    const user = userEvent.setup();
    renderRoutes(<DirtyPage dirty />);
    expect(screen.getByText("Dirty Page")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "go /other" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    // URL/route did NOT change — still on the dirty page.
    expect(screen.getByText("Dirty Page")).toBeInTheDocument();
    expect(screen.queryByText("Other Page")).not.toBeInTheDocument();
  });

  it("dirty + Discard & leave → proceeds to the target route", async () => {
    const user = userEvent.setup();
    renderRoutes(<DirtyPage dirty />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    await user.click(await screen.findByRole("button", { name: "Discard & leave" }));
    expect(await screen.findByText("Other Page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("dirty + Cancel → stays on the page and dismisses the dialog", async () => {
    const user = userEvent.setup();
    renderRoutes(<DirtyPage dirty />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("Dirty Page")).toBeInTheDocument();
    expect(screen.queryByText("Other Page")).not.toBeInTheDocument();
  });

  it("clean nav → no dialog, navigates immediately", async () => {
    const user = userEvent.setup();
    renderRoutes(<DirtyPage dirty={false} />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    expect(await screen.findByText("Other Page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("same-path navigation while dirty → no dialog", async () => {
    const user = userEvent.setup();
    renderRoutes(<DirtyPage dirty to="/" />);
    await user.click(screen.getByRole("link", { name: "go /" }));
    await waitFor(() => expect(screen.getByText("Dirty Page")).toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // Ref-count: the blocker fires iff at least one registrant is dirty.
  function MultiPage({ aDirty, bDirty }: { aDirty: boolean; bDirty: boolean }) {
    return (
      <div>
        <h1>Dirty Page</h1>
        <Registrant dirty={aDirty} />
        <Registrant dirty={bDirty} />
        <Link to="/other">go /other</Link>
      </div>
    );
  }

  it("two registrants: ANY dirty → blocks", async () => {
    const user = userEvent.setup();
    renderRoutes(<MultiPage aDirty bDirty={false} />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText("Other Page")).not.toBeInTheDocument();
  });

  it("two registrants: ALL clean → no block", async () => {
    const user = userEvent.setup();
    renderRoutes(<MultiPage aDirty={false} bDirty={false} />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    expect(await screen.findByText("Other Page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("unmounting the only dirty registrant drops it → no block", async () => {
    const user = userEvent.setup();
    function UnmountHarness() {
      const [mounted, setMounted] = useState(true);
      return (
        <div>
          <h1>Dirty Page</h1>
          {mounted && <Registrant dirty />}
          <button onClick={() => setMounted(false)}>unmount A</button>
          <Link to="/other">go /other</Link>
        </div>
      );
    }
    renderRoutes(<UnmountHarness />);
    await user.click(screen.getByRole("button", { name: "unmount A" }));
    await user.click(screen.getByRole("link", { name: "go /other" }));
    expect(await screen.findByText("Other Page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("two simultaneous dirty editors: Discard & leave clears BOTH (no re-block on next nav)", async () => {
    const user = userEvent.setup();
    // Land on a MultiPage (both dirty) at /other-less route, then navigate.
    const router = createMemoryRouter(
      [
        {
          element: (
            <UnsavedChangesProvider>
              <Outlet />
            </UnsavedChangesProvider>
          ),
          children: [
            { path: "/", element: <MultiPage aDirty bDirty /> },
            // /other has no dirty registrants — a second nav from here must NOT re-block.
            {
              path: "/other",
              element: (
                <div>
                  <h1>Other Page</h1>
                  <Link to="/third">go /third</Link>
                </div>
              ),
            },
            { path: "/third", element: <h1>Third Page</h1> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole("link", { name: "go /other" }));
    await user.click(await screen.findByRole("button", { name: "Discard & leave" }));
    expect(await screen.findByText("Other Page")).toBeInTheDocument();
    // Both registrants cleared → navigating again does NOT re-block.
    await user.click(screen.getByRole("link", { name: "go /third" }));
    expect(await screen.findByText("Third Page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // The browser Back button (popstate) is proven by the Task-1 /browse spike and
  // the agent-unsaved-guard.spec.ts page.goBack() case — jsdom/MemoryRouter
  // popstate is unreliable, so we do NOT fake-pass it here.
  it.skip("blocks the browser Back button (proven by the /browse spike + e2e)", () => {});
});
