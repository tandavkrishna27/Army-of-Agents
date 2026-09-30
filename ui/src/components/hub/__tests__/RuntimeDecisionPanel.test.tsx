import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeDecisionDetail } from "@armyofagents/shared";
import { RuntimeDecisionPanel } from "../RuntimeDecisionPanel";
import type { HubItemListRow } from "@/api/hub-items";

// Mock the runtime-decisions api so the panel's detail query resolves to a
// deterministic permission decision without hitting the network.
const detailSpy = vi.fn();
const answerSpy = vi.fn();
vi.mock("@/api/agent-runtime-decisions", () => ({
  agentRuntimeDecisionsApi: {
    detail: (...args: unknown[]) => detailSpy(...args),
    answer: (...args: unknown[]) => answerSpy(...args),
  },
}));

function permissionDetail(overrides: Partial<RuntimeDecisionDetail> = {}): RuntimeDecisionDetail {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    hubItemId: "00000000-0000-0000-0000-0000000000a1",
    companyId: "00000000-0000-0000-0000-0000000000c1",
    agentId: "00000000-0000-0000-0000-0000000000b1",
    runId: "00000000-0000-0000-0000-0000000000d1",
    adapterType: "claude_local",
    adapterSessionId: null,
    kind: "permission",
    status: "shown",
    sourceRevision: 3,
    nonce: "nonce-abc",
    title: "Allow command?",
    summary: "Run the test suite",
    promptText: "pnpm test:run",
    toolName: "shell",
    command: "pnpm test:run",
    cwd: "C:/repo",
    path: null,
    networkTarget: null,
    riskClass: "medium",
    allowRunEligible: false,
    allowRunReason: "Run access is unavailable for shell, network, secret, or unknown actions.",
    options: null,
    timeoutPolicy: "deny",
    expiresAt: null,
    answeredAt: null,
    relayedAt: null,
    relayError: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

function runtimeDecisionItem(overrides: Partial<HubItemListRow> = {}): HubItemListRow {
  return {
    id: "hub-runtime-1",
    companyId: "company-1",
    semanticType: "agent_runtime_decision",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Runtime decision",
    summary: null,
    sourceType: "agent_runtime_decision",
    sourceId: "decision-1",
    ownerUserId: null,
    ownerPool: "board",
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  };
}

function renderPanel(item: HubItemListRow) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RuntimeDecisionPanel item={item} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPanel(nextItem: HubItemListRow) {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <RuntimeDecisionPanel item={nextItem} />
        </QueryClientProvider>,
      );
    },
  };
}

describe("RuntimeDecisionPanel", () => {
  beforeEach(() => {
    detailSpy.mockReset();
    answerSpy.mockReset();
    detailSpy.mockResolvedValue(permissionDetail());
  });

  it("renders the allow/deny controls and decision facts for a permission decision", async () => {
    detailSpy.mockResolvedValueOnce(permissionDetail());
    renderPanel(runtimeDecisionItem());

    // Allow/deny permission controls render once the detail resolves.
    expect(await screen.findByRole("button", { name: /allow once/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /equivalent actions/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
    expect(screen.getByText(/run access is unavailable for shell/i)).toBeInTheDocument();

    // Facts render from the detail (tool + command + risk).
    expect(screen.getByText("Tool")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText("Risk")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();

    // Status label humanizes underscores.
    expect(screen.getByText("shown")).toBeInTheDocument();
  });

  it("offers a run-scoped grant only for a validated workspace filesystem action", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(permissionDetail({
      toolName: "Edit",
      command: null,
      cwd: "C:/repo",
      path: "C:/repo/src/app.ts",
      riskClass: "filesystem",
      allowRunEligible: true,
      allowRunReason: null,
    }));
    answerSpy.mockResolvedValueOnce(permissionDetail({ status: "answered" }));
    renderPanel(runtimeDecisionItem());

    fireEvent.click(await screen.findByRole("button", { name: /allow equivalent actions for this run/i }));
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    expect(answerSpy.mock.calls[0][2]).toMatchObject({
      kind: "permission",
      decision: "allow_run",
    });
  });

  it("renders a work-question answer box for a work_question decision", async () => {
    detailSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    expect(await screen.findByLabelText(/work question answer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send answer/i })).toBeInTheDocument();
  });

  it("renders option CARDS with description + rationale and posts {answer:{value}} on select", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(
      permissionDetail({
        kind: "work_question",
        summary: "Deciding the launch segment before we build onboarding.",
        promptText:
          "Which customer segment should we prioritize for the v1 launch, given limited eng bandwidth?",
        options: [
          {
            label: "Founder-led SaaS",
            value: "saas",
            description: "Teams of 3-10 running AI + humans from one control room.",
            rationale: "Highest willingness-to-pay; matches our current wedge.",
          },
          { label: "Agencies", value: "agencies" },
        ] as any,
      }),
    );
    answerSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    expect(await screen.findByText(/deciding the launch segment/i)).toBeInTheDocument();
    expect(screen.getByText(/which customer segment should we prioritize/i)).toBeInTheDocument();
    expect(screen.getByText("Founder-led SaaS")).toBeInTheDocument();
    expect(screen.getByText(/teams of 3-10 running ai/i)).toBeInTheDocument();
    expect(screen.getByText(/highest willingness-to-pay/i)).toBeInTheDocument();
    expect(screen.getByText("Agencies")).toBeInTheDocument();
    expect(screen.getByLabelText(/work question answer/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /founder-led saas/i }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    expect(answerSpy.mock.calls[0][2]).toMatchObject({
      kind: "work_question",
      answer: { value: "saas" },
    });
  });

  it("posts free-text over a selected option when the user writes their own answer", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(
      permissionDetail({
        kind: "work_question",
        options: [{ label: "A", value: "a" }] as any,
      }),
    );
    answerSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    const box = await screen.findByLabelText(/work question answer/i);
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    fireEvent.change(box, { target: { value: "Neither - go SMB." } });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    expect(answerSpy.mock.calls[0][2]).toMatchObject({
      kind: "work_question",
      answer: { text: "Neither - go SMB." },
    });
  });

  it("clears draft answer state when switching to a different runtime decision", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy
      .mockResolvedValueOnce(
        permissionDetail({
          id: "decision-detail-1",
          kind: "work_question",
          promptText: "First question",
          sourceRevision: 1,
          options: [{ label: "First option", value: "first" }] as any,
        }),
      )
      .mockResolvedValueOnce(
        permissionDetail({
          id: "decision-detail-2",
          kind: "work_question",
          promptText: "Second question",
          sourceRevision: 1,
          options: [{ label: "Second option", value: "second" }] as any,
        }),
      );
    const view = renderPanel(runtimeDecisionItem({ sourceId: "decision-1" }));

    fireEvent.click(await screen.findByRole("radio", { name: /first option/i }));
    expect(screen.getByRole("button", { name: /send answer/i })).toBeEnabled();

    view.rerenderPanel(runtimeDecisionItem({ sourceId: "decision-2" }));

    expect(await screen.findByText(/second question/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /send answer/i })).toBeDisabled());
  });

  it("still renders the free-text box when a work_question has no options", async () => {
    detailSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question", options: null }));
    renderPanel(runtimeDecisionItem());
    expect(await screen.findByLabelText(/work question answer/i)).toBeInTheDocument();
  });

  it("shows an unavailable message when the item has no source id", () => {
    renderPanel(runtimeDecisionItem({ sourceId: null }));
    expect(screen.getByText(/runtime decision source is unavailable/i)).toBeInTheDocument();
    // No detail fetch when there's no decision id.
    expect(detailSpy).not.toHaveBeenCalled();
  });

  it("surfaces a details-unavailable message when the detail query errors", async () => {
    detailSpy.mockRejectedValueOnce(new Error("boom"));
    renderPanel(runtimeDecisionItem());
    await waitFor(() =>
      expect(screen.getByText(/decision details unavailable/i)).toBeInTheDocument(),
    );
  });
});
