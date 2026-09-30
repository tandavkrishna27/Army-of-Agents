import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkQuestionPanel } from "./WorkQuestionPanel";

const api = vi.hoisted(() => ({
  detail: vi.fn(),
  answer: vi.fn(),
  takeOver: vi.fn(),
  retryContinuation: vi.fn(),
}));

vi.mock("@/api/work-questions", () => ({ workQuestionsApi: api }));

const question = {
  id: "question-1",
  companyId: "company-1",
  issueId: "issue-1",
  issueIdentifierSnapshot: "WQ-7",
  issueTitleSnapshot: "Choose interview sample",
  askingAgentId: "agent-1",
  askingAgentNameSnapshot: "Research Agent",
  originatingRunKind: "heartbeat",
  originatingRunId: "run-1",
  executionWorkspaceId: null,
  sourceDiscussionId: null,
  sourceDiscussionEntryId: null,
  sourceCommanderConversationId: null,
  primaryRecipientUserId: "user-1",
  currentRecipientUserId: "user-1",
  title: "Which sample should we use?",
  question: "Choose five deep interviews or twelve short interviews.",
  context: { summary: "The launch window is two weeks." },
  options: [
    { label: "Five deep", value: "five", description: "Higher depth." },
    { label: "Twelve short", value: "twelve", rationale: "Broader signal." },
  ],
  blocking: true,
  status: "open",
  answer: null as null | { text?: string; selectedValues?: string[] },
  answerIdempotencyKey: null,
  answeredByUserId: null,
  answeredAt: null,
  continuationStatus: "not_needed",
  continuationRunKind: null,
  continuationRunId: null,
  continuationError: null,
  slaDurationHours: 24,
  slaSource: "company",
  slaSourceId: "company-1",
  dueAt: "2099-07-13T00:00:00.000Z",
  slaBreachedAt: null as string | null,
  escalationRecipientUserId: null,
  version: 0,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

function renderPanel(
  capabilities = { read: true, answer: true, takeOver: false, reassign: false, retryContinuation: false, cancel: false, create: false },
  questionOverride: Partial<typeof question> = {},
) {
  api.detail.mockResolvedValue({ question: { ...question, ...questionOverride }, capabilities });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    ...render(
    <QueryClientProvider client={client}>
      <WorkQuestionPanel companyId="company-1" questionId="question-1" embedded />
    </QueryClientProvider>,
    ),
    client,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.answer.mockResolvedValue({ ...question, status: "answered", version: 1 });
  api.takeOver.mockResolvedValue({ ...question, currentRecipientUserId: "user-2", version: 1 });
  vi.stubGlobal("crypto", { randomUUID: () => "answer-uuid" });
});

describe("WorkQuestionPanel", () => {
  it("polls the durable question detail so answers from another surface appear", async () => {
    vi.useFakeTimers();
    try {
      renderPanel();
      await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling while a continuation is dispatched", async () => {
    vi.useFakeTimers();
    try {
      renderPanel(undefined, { status: "answered", continuationStatus: "dispatched" });
      await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the question and its continuation are settled", async () => {
    vi.useFakeTimers();
    try {
      renderPanel(undefined, { status: "answered", continuationStatus: "completed" });
      await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.detail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an answer draft when an SLA update increments the question version", async () => {
    const { client } = renderPanel();
    const answer = await screen.findByLabelText("Work question answer");
    fireEvent.change(answer, { target: { value: "Keep the launch focused." } });

    act(() => {
      client.setQueryData(
        ["work-questions", "company-1", "question-1"],
        {
          question: { ...question, version: 1, slaBreachedAt: "2026-07-13T00:00:00.000Z" },
          capabilities: { read: true, answer: true, takeOver: false, reassign: false, retryContinuation: false, cancel: false, create: false },
        },
      );
    });

    expect(answer).toHaveValue("Keep the launch focused.");
  });

  it("renders durable task, agent, context, and option metadata", async () => {
    renderPanel();
    expect(await screen.findByText("Which sample should we use?")).toBeInTheDocument();
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Task: Choose interview sample")).toBeInTheDocument();
    expect(screen.getByText("The launch window is two weeks.")).toBeInTheDocument();
    expect(screen.getByText("Higher depth.")).toBeInTheDocument();
    expect(screen.getByText("Rationale: Broader signal.")).toBeInTheDocument();
    expect(screen.getByText(/Due in/)).toBeInTheDocument();
    expect(screen.getByText("Company policy")).toBeInTheDocument();
  });

  it("marks a breached project deadline as overdue", async () => {
    renderPanel(undefined, {
      dueAt: "2026-07-11T00:00:00.000Z",
      slaSource: "project",
      slaBreachedAt: "2026-07-11T00:00:01.000Z",
    });

    expect(await screen.findByText(/Overdue by/)).toHaveClass("text-destructive");
    expect(screen.getByText("Project policy")).toBeInTheDocument();
  });

  it("answers the shared question identity with optimistic versioning", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("Five deep"));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith(
      "company-1",
      "question-1",
      {
        answer: { selectedValues: ["five"] },
        expectedVersion: 0,
        idempotencyKey: "work-question:question-1:answer-uuid",
      },
    ));
  });

  it("shows the human-readable option label after an answer", async () => {
    renderPanel(undefined, {
      status: "answered",
      answer: { selectedValues: ["five"] },
      continuationStatus: "dispatched",
    });

    expect(await screen.findByText("Five deep")).toBeInTheDocument();
    expect(screen.queryByText("five")).not.toBeInTheDocument();
  });

  it("reuses the same answer idempotency key when a lost response is retried", async () => {
    const randomUUID = vi.fn(() => "stable-answer-uuid");
    vi.stubGlobal("crypto", { randomUUID });
    api.answer
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ...question, status: "answered", version: 1 });
    renderPanel();

    fireEvent.click(await screen.findByText("Five deep"));
    const submit = screen.getByRole("button", { name: "Send answer" });
    fireEvent.click(submit);
    await screen.findByRole("alert");
    fireEvent.click(submit);

    await waitFor(() => expect(api.answer).toHaveBeenCalledTimes(2));
    expect(api.answer.mock.calls[0]?.[2].idempotencyKey).toBe("work-question:question-1:stable-answer-uuid");
    expect(api.answer.mock.calls[1]?.[2].idempotencyKey).toBe("work-question:question-1:stable-answer-uuid");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("offers takeover only when the server grants that capability", async () => {
    renderPanel({ read: true, answer: false, takeOver: true, reassign: false, retryContinuation: false, cancel: false, create: false });
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    await waitFor(() => expect(api.takeOver).toHaveBeenCalledWith("company-1", "question-1", 0));
  });
});
