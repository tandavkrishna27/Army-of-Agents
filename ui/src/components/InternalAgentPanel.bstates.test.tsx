import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentPanelContent } from "./InternalAgentPanel";

/**
 * Commander composer B-states (mock §5): send-failed banner with idempotent
 * Retry (same clientSubmissionId — the server-side agent-loop replay dedupes
 * an ambiguous failure), offline strip, and frame-wide drag-drop.
 *
 * These are REAL component tests: the full AgentPanelContent renders in docked
 * mode (no viewer panel) with the provider hooks mocked at the module seam,
 * mirroring CommentThread.test.tsx's harness style.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mutable connection state for the shared offline strip (B-states, mock §5).
const liveState = vi.hoisted(() => ({ connectionState: "open" }));

vi.mock("../context/LiveUpdatesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/LiveUpdatesProvider")>();
  return {
    ...actual,
    useLiveUpdates: () => ({
      connectionState: liveState.connectionState,
      workingAgentsByThread: {},
      presenceByThread: {},
    }),
  };
});

// All hook mocks return STABLE singletons — the panel's effects put these
// values in dependency arrays, and a fresh object/vi.fn() per render loops
// setState-in-effect chains.
const stableHooks = vi.hoisted(() => ({
  company: { selectedCompanyId: "co-1" },
  agentPanel: {
    isOpen: true,
    openPanel: () => {},
    closePanel: () => {},
    setIsStreaming: () => {},
    setCurrentConversationId: () => {},
  },
  breadcrumbs: { breadcrumbs: [] as unknown[] },
  location: { pathname: "/", hash: "", search: "" },
  navigate: () => {},
  teamAccess: { currentUser: { userId: "user-1" }, isLoading: false },
  inlineQuestions: { data: [] as unknown[], isError: false, refetch: () => {} },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => stableHooks.company,
}));

// MarkdownBody pulls ThemeContext (needs ThemeProvider) — render plain text.
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Radix TooltipTrigger's composed refs infinite-loop under React 19 + jsdom
// when the wrapped button's `disabled` flips mid-stream (compose-refs setRef
// → setState loop). The tooltips are chrome, not contract — render children
// directly; the real buttons (aria-labels included) stay in the tree.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("../context/AgentPanelContext", () => ({
  useAgentPanel: () => stableHooks.agentPanel,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => stableHooks.breadcrumbs,
}));

vi.mock("../lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/router")>();
  return {
    ...actual,
    useLocation: () => stableHooks.location,
    useNavigate: () => stableHooks.navigate,
  };
});

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => stableHooks.teamAccess,
}));

// Cut the heavy transitive import trees that never render in docked mode.
vi.mock("../pages/ThreadDetail", () => ({ ThreadDetail: () => null }));
vi.mock("./commander/cockpit/CommanderCockpitPanel", () => ({
  CommanderCockpitPanel: () => null,
}));

vi.mock("./work-questions/WorkQuestionInlineList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./work-questions/WorkQuestionInlineList")>();
  return {
    ...actual,
    useInlineWorkQuestions: () => stableHooks.inlineQuestions,
  };
});

// The stream mock is swapped per-test: failing generator vs completing one.
const streamState = vi.hoisted(() => ({
  impl: undefined as ((...args: unknown[]) => AsyncGenerator<unknown>) | undefined,
  calls: [] as unknown[][],
}));

vi.mock("../api/internal-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/internal-agent")>();
  return {
    ...actual,
    streamAgentChat: (...args: unknown[]) => {
      streamState.calls.push(args);
      if (!streamState.impl) throw new Error("streamState.impl not set");
      return streamState.impl(...args);
    },
    internalAgentApi: {
      ...actual.internalAgentApi,
      getConversation: vi.fn().mockResolvedValue({ conversation: null, messages: [] }),
      getGreeting: vi.fn().mockResolvedValue(null),
      getRuntimeSettings: vi.fn().mockResolvedValue({ runtimeAllowAlwaysEnabled: true }),
      listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    },
    commanderConversationsApi: {
      ...actual.commanderConversationsApi,
      list: vi.fn().mockResolvedValue({ conversations: [] }),
    },
    conversationMessagesApi: {
      ...actual.conversationMessagesApi,
      list: vi.fn().mockResolvedValue(null),
    },
  };
});

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

const uploadFileMock = vi.hoisted(() => vi.fn());
vi.mock("../api/assets", () => ({
  assetsApi: { uploadFile: uploadFileMock },
}));

// ─── Harness ─────────────────────────────────────────────────────────────────

function failingStream(): AsyncGenerator<unknown> {
  // eslint-disable-next-line require-yield
  return (async function* () {
    throw new Error("boom");
  })();
}

function completingStream(): AsyncGenerator<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return (async function* () {})();
}

// The server can emit an SSE `error` event (CLI failure mid-stream, or the
// idempotency "already being processed" response) and then END the generator
// NORMALLY — no throw. The client must still treat this as a failed send.
function erroringStream(): AsyncGenerator<unknown> {
  return (async function* () {
    yield { event: "error", data: { code: "INTERNAL", message: "CLI failed mid-stream" } };
  })();
}

function renderPanel(props: React.ComponentProps<typeof AgentPanelContent> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const makeUi = (p: React.ComponentProps<typeof AgentPanelContent>) => (
    <QueryClientProvider client={client}>
      <AgentPanelContent {...p} />
    </QueryClientProvider>
  );
  const result = render(makeUi(props));
  return {
    ...result,
    // Same mounted panel, new props — simulates switching conversations.
    rerenderPanel: (next: React.ComponentProps<typeof AgentPanelContent>) =>
      result.rerender(makeUi(next)),
  };
}

function composerInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Ask the agent..." });
}

function typeInComposer(text: string): HTMLElement {
  const box = composerInput();
  box.textContent = text;
  fireEvent.input(box);
  return box;
}

function sendViaEnter(box: HTMLElement) {
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  liveState.connectionState = "open";
  streamState.impl = failingStream;
  streamState.calls = [];
  uploadFileMock.mockReset();
  window.localStorage.clear();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Commander composer — B-states (mock §5)", () => {
  it("raises the banner on send failure keeping the draft; Retry replays the IDENTICAL request incl. the same clientSubmissionId; retry-success clears", async () => {
    renderPanel();
    const box = typeInComposer("deploy the beta");
    sendViaEnter(box);

    // Failure never eats your work: banner up, draft intact.
    const banner = await screen.findByTestId("composer-send-failed-banner");
    expect(box.textContent).toBe("deploy the beta");
    expect(streamState.calls).toHaveLength(1);
    const first = streamState.calls[0];
    expect(first[1]).toBe("deploy the beta"); // message
    expect(typeof first[7]).toBe("string"); // clientSubmissionId minted
    expect((first[7] as string).length).toBeGreaterThan(0);

    // Retry replays the EXACT attempt — same message, same clientSubmissionId
    // (the server-side agent-loop replay dedupes if the first turn landed).
    streamState.impl = completingStream;
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    expect(streamState.calls).toHaveLength(2);
    const second = streamState.calls[1];
    expect(second[1]).toBe(first[1]);
    expect(second[7]).toBe(first[7]);
    // Retry-success clears the (non-diverged) draft.
    await waitFor(() => expect(composerInput().textContent).toBe(""));
  });

  it("raises the failed-send banner on an SSE error event (stream ends normally, no throw) — round-3 #3", async () => {
    streamState.impl = erroringStream;
    renderPanel();
    const box = typeInComposer("run the deploy");
    sendViaEnter(box);

    // The error event must surface the banner and retain the draft — NOT be
    // reported as an accepted send.
    const banner = await screen.findByTestId("composer-send-failed-banner");
    expect(box.textContent).toBe("run the deploy");
    // Retry replays the identical attempt (same clientSubmissionId).
    streamState.impl = completingStream;
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    expect(streamState.calls).toHaveLength(2);
    expect(streamState.calls[1][7]).toBe(streamState.calls[0][7]);
  });

  it("dismisses the banner on Edit but keeps the draft; the next send mints a NEW clientSubmissionId", async () => {
    renderPanel();
    const box = typeInComposer("ship it");
    sendViaEnter(box);
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(box.textContent).toBe("ship it");

    // A fresh submission is NOT a replay: new clientSubmissionId.
    sendViaEnter(box);
    await screen.findByTestId("composer-send-failed-banner");
    expect(streamState.calls).toHaveLength(2);
    expect(streamState.calls[1][7]).not.toBe(streamState.calls[0][7]);
  });

  it("Discard dismisses the banner and clears the input", async () => {
    renderPanel();
    const box = typeInComposer("scrap this");
    sendViaEnter(box);
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(box.textContent).toBe("");
  });

  it("dismisses the banner when the draft diverges from the failed attempt", async () => {
    renderPanel();
    const box = typeInComposer("original message");
    sendViaEnter(box);
    await screen.findByTestId("composer-send-failed-banner");

    // Any edit means Retry would post stale content — the banner must go.
    typeInComposer("original message, edited");
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // The newer draft survives.
    expect(box.textContent).toBe("original message, edited");
  });

  it("mid-retry divergence never re-arms the stale banner (removed ref stays unreachable)", async () => {
    uploadFileMock.mockResolvedValue({
      assetId: "asset-1",
      originalFilename: "notes.txt",
      contentPath: "/api/assets/asset-1/content",
      contentType: "text/plain",
      byteSize: 5,
    });
    renderPanel();

    // Attach a ref, then fail the first send — banner up with the snapshot.
    const frame = screen.getByTestId("commander-composer-frame");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(frame, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(await screen.findByTestId("commander-input-refs")).toHaveTextContent("notes.txt");

    const box = typeInComposer("send with the file");
    sendViaEnter(box);
    const banner = await screen.findByTestId("composer-send-failed-banner");
    expect(streamState.calls).toHaveLength(1);

    // Hang the retry so we can mutate the refs tray while it is in flight.
    let failRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { failRetry = resolve; });
    streamState.impl = () =>
      (async function* () {
        await retryGate;
        throw new Error("still failing");
      })();
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(streamState.calls).toHaveLength(2));

    // Divergence while retrying: the dismiss is suppressed (banner shows Retrying…)…
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt reference" }));
    expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();

    // …but when the retry fails, the failure path must NOT re-arm the stale
    // snapshot — a second Retry would post the removed (possibly sensitive) ref.
    failRetry();
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // The stale snapshot stayed unreachable — nothing was re-sent.
    expect(streamState.calls).toHaveLength(2);
  });

  it("shows the offline strip and disables Send while offline", async () => {
    liveState.connectionState = "offline";
    renderPanel();
    expect(await screen.findByTestId("composer-offline-strip")).toBeInTheDocument();

    const box = typeInComposer("try to send offline");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeDisabled();

    // The Enter path is gated too — no request leaves the client.
    sendViaEnter(box);
    expect(streamState.calls).toHaveLength(0);
  });

  it("shows the drop overlay on dragEnter and routes dropped files through the existing attach path", async () => {
    uploadFileMock.mockResolvedValue({
      assetId: "asset-1",
      originalFilename: "notes.txt",
      contentPath: "/api/assets/asset-1/content",
      contentType: "text/plain",
      byteSize: 5,
    });
    renderPanel();
    const frame = screen.getByTestId("commander-composer-frame");

    fireEvent.dragEnter(frame, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(frame, { dataTransfer: { types: ["Files"], files: [file] } });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock).toHaveBeenCalledWith("co-1", file, "commander/new");
    // The uploaded asset lands in the refs tray (validateCommanderAttachmentFiles path).
    expect(await screen.findByTestId("commander-input-refs")).toHaveTextContent("notes.txt");
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
  });

  it("drops a stale upload FAILURE after the user switches conversations mid-upload (round-10 #3)", async () => {
    // The upload hangs, the user switches to conversation B, THEN the upload
    // fails for A. B's tray must not be repopulated with A's failed card — the
    // failure path must apply the same active-conversation guard as the success
    // path (otherwise retrying it would attach A's file to B).
    let failUpload!: () => void;
    uploadFileMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        failUpload = () => reject(new Error("upload failed"));
      }),
    );

    const { rerenderPanel } = renderPanel({ conversationId: "conv-a" });
    const frame = screen.getByTestId("commander-composer-frame");
    const file = new File(["hi"], "stale.txt", { type: "text/plain" });
    fireEvent.drop(frame, { dataTransfer: { types: ["Files"], files: [file] } });

    // Upload is in flight against conversation A; switch to B before it settles.
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    rerenderPanel({ conversationId: "conv-b" });

    // Now it fails — but for the stale (A) conversation.
    failUpload();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No failed card and no error for A's file on conversation B.
    expect(screen.queryByText(/stale\.txt failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not upload stale\.txt/i)).not.toBeInTheDocument();
  });

  it("switching conversations clears the banner and snapshot — Retry must never post into a different conversation", async () => {
    const { rerenderPanel } = renderPanel({ conversationId: "conv-a" });
    const box = typeInComposer("meant for conversation A");
    sendViaEnter(box);
    await screen.findByTestId("composer-send-failed-banner");
    expect(streamState.calls).toHaveLength(1);

    // Entity switch: same mounted panel, different conversation.
    rerenderPanel({ conversationId: "conv-b" });

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // The snapshot is unreachable — nothing was re-sent anywhere.
    expect(streamState.calls).toHaveLength(1);
  });

  it("keeps existing composer affordances intact (aria contract)", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.getByLabelText("Attach files")).toBeInTheDocument(); // hidden input
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
  });
});
