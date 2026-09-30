import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SnapshotUpdateModal } from "../SnapshotUpdateModal";

const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

function response(
  status: number,
  body: unknown,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SnapshotUpdateModal
        open
        onClose={vi.fn()}
        companyId="company-1"
        updateId="update-1"
        itemName="Brainstorming"
      />
    </QueryClientProvider>,
  );
}

describe("SnapshotUpdateModal snapshot conflicts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushToast.mockReset();
  });

  it("disables stale retries and refetches a fresh token after SKILL_MERGE_CONFLICT", async () => {
    const refresh = deferred<Pick<Response, "ok" | "status" | "json">>();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(200, {
        diff: [{
          header: "Old",
          state: "changed",
          mine: "old mine",
          theirs: "old upstream",
        }],
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        snapshotToken: "token-old",
      }) as Response)
      .mockResolvedValueOnce(response(409, {
        error: "The skill changed after this diff was reviewed.",
        code: "SKILL_MERGE_CONFLICT",
      }) as Response)
      .mockImplementationOnce(() => refresh.promise as Promise<Response>)
      .mockResolvedValueOnce(response(200, { ok: true }) as Response);

    renderModal();
    const user = userEvent.setup();
    const acceptUpstream = await screen.findByRole("button", { name: "Accept upstream" });
    const applyButton = screen.getByRole("button", { name: "Apply merge" });

    await user.click(acceptUpstream);
    await user.click(applyButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(applyButton).toBeDisabled();
    expect(screen.getByText(/reviewed snapshot changed/i)).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({
      snapshotToken: "token-old",
      decisions: { Old: "theirs" },
    });

    refresh.resolve(response(200, {
      diff: [{
        header: "New",
        state: "changed",
        mine: "new mine",
        theirs: "new upstream",
      }],
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      snapshotToken: "token-new",
    }));

    await waitFor(() => expect(applyButton).toBeEnabled());
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Merge diff refreshed",
      tone: "info",
    }));

    await user.click(applyButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toMatchObject({
      snapshotToken: "token-new",
      decisions: { New: "mine" },
    });
  });

  it("keeps Apply disabled and offers an in-modal retry when refresh fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(200, {
        diff: [{
          header: "Old",
          state: "changed",
          mine: "old mine",
          theirs: "old upstream",
        }],
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        snapshotToken: "token-old",
      }) as Response)
      .mockResolvedValueOnce(response(409, {
        error: "The skill changed.",
        code: "SKILL_MERGE_CONFLICT",
      }) as Response)
      .mockResolvedValueOnce(response(503, { error: "Catalog unavailable" }) as Response)
      .mockResolvedValueOnce(response(200, {
        diff: [{
          header: "New",
          state: "changed",
          mine: "new mine",
          theirs: "new upstream",
        }],
        currentVersion: "1.0.0",
        latestVersion: "1.2.0",
        snapshotToken: "token-new",
      }) as Response);

    renderModal();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Accept upstream" });
    const applyButton = screen.getByRole("button", { name: "Apply merge" });

    await user.click(applyButton);

    const refreshButton = await screen.findByRole("button", { name: "Refresh diff" });
    expect(applyButton).toBeDisabled();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not refresh merge diff",
      tone: "error",
    }));

    await user.click(refreshButton);
    await waitFor(() => expect(applyButton).toBeEnabled());
  });
});
