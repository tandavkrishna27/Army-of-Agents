import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkQuestionInlineList } from "./WorkQuestionInlineList";

const api = vi.hoisted(() => ({ listInline: vi.fn() }));

vi.mock("@/api/work-questions", () => ({ workQuestionsApi: api }));
vi.mock("./WorkQuestionPanel", () => ({
  WorkQuestionPanel: ({ companyId, questionId }: { companyId: string; questionId: string }) => (
    <div data-testid="inline-question">{companyId}:{questionId}</div>
  ),
}));

function renderList(source: React.ComponentProps<typeof WorkQuestionInlineList>["source"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkQuestionInlineList companyId="company-1" source={source} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listInline.mockResolvedValue([
    { question: { id: "question-1" }, capabilities: { read: true } },
    { question: { id: "question-2" }, capabilities: { read: true } },
  ]);
});

describe("WorkQuestionInlineList", () => {
  it("loads a source without narrowing to the current recipient and preserves question identity", async () => {
    renderList({ issueId: "issue-1" });

    await waitFor(() => expect(api.listInline).toHaveBeenCalledWith("company-1", {
      issueId: "issue-1",
      scope: "all",
    }));
    expect(await screen.findAllByTestId("inline-question")).toHaveLength(2);
    expect(screen.getByText("company-1:question-1")).toBeInTheDocument();
  });

  it("does not query without a concrete source", () => {
    renderList({});
    expect(api.listInline).not.toHaveBeenCalled();
    expect(screen.queryByTestId("work-question-inline-list")).not.toBeInTheDocument();
  });

  it("shows a retry action when the shared question list fails to load", async () => {
    api.listInline.mockRejectedValueOnce(new Error("network unavailable"));
    renderList({ issueId: "issue-1" });

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    api.listInline.mockResolvedValueOnce([{ question: { id: "question-1" }, capabilities: { read: true } }]);
    screen.getByRole("button", { name: "Retry" }).click();

    expect(await screen.findByText("company-1:question-1")).toBeInTheDocument();
  });

  it("treats a malformed successful response as a visible partial failure", async () => {
    api.listInline.mockResolvedValueOnce({});
    renderList({ sourceDiscussionId: "discussion-1" });

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
