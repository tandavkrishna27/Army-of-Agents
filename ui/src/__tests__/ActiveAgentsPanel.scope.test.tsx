import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// jsdom doesn't implement Element.scrollTo; the panel auto-scrolls its feed on
// new activity, so shim it to a no-op to avoid an unhandled TypeError.
if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = vi.fn();
}

/**
 * Scope contract (unified-crew-board design 2026-06-02, T-C #3): the
 * ActiveAgentsPanel builds an issue map to LABEL live crew runs, so its task
 * list MUST request `taskScope: 'all'` — the fail-safe 'org' default would hide
 * crew tasks and the live-run labels would go blank.
 */

// Real router (the panel only uses <Link>).
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, Link: actual.Link };
});

const issuesListMock = vi.fn().mockResolvedValue([]);
vi.mock("../api/issues", () => ({
  issuesApi: { list: (...args: unknown[]) => issuesListMock(...args) },
}));

// One active live run so the (run-gated) issues query is enabled and fires.
const liveRunsMock = vi.fn().mockResolvedValue([
  {
    id: "run-1",
    issueId: "issue-1",
    agentName: "Engineer",
    startedAt: new Date().toISOString(),
    status: "running",
  },
]);
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: (...args: unknown[]) => liveRunsMock(...args) },
}));

import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveAgentsPanel companyId="comp-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ActiveAgentsPanel — task scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issuesListMock.mockResolvedValue([]);
  });

  it("requests its issue map with taskScope:'all' so live crew runs can be labeled", async () => {
    renderPanel();

    await waitFor(() =>
      expect(issuesListMock).toHaveBeenCalledWith("comp-1", { taskScope: "all" }),
    );

    // Never an org-scoped (scope-less) task list from this panel.
    for (const [, filters] of issuesListMock.mock.calls) {
      expect((filters as { taskScope?: string } | undefined)?.taskScope).toBe("all");
    }
  });
});
