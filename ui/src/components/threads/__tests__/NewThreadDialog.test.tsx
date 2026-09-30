import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { NewThreadDialog } from "../../NewThreadDialog";
import { queryKeys } from "../../../lib/queryKeys";

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../../api/discussions", () => ({
  discussionsApi: {
    create: vi.fn().mockResolvedValue({ id: "disc-new", title: "New" }),
    addEntry: vi.fn().mockResolvedValue({ id: "entry-new" }),
  },
}));

vi.mock("../../../api/threads", () => ({
  threadsApi: {
    promoteToGoal: vi.fn().mockResolvedValue({ threadId: "t1", goalId: "g1" }),
  },
}));

vi.mock("../../../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

describe("NewThreadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing when open", () => {
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows type chooser chips (Idea, Discussion, Goal, Transcript, Document)", () => {
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    // Use getAllBy and check at least one button matches each label
    expect(screen.getByRole("button", { name: /^idea$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^discussion$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^goal$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^transcript$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^document$/i })).toBeInTheDocument();
  });

  it("does NOT show project field when type is 'Idea'", () => {
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    // Idea is the default — no project-required field shown
    expect(screen.queryByTestId("thread-goal-project-field")).not.toBeInTheDocument();
  });

  it("reveals project field when type is switched to 'Goal'", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    const goalBtn = screen.getByRole("button", { name: /goal/i });
    await user.click(goalBtn);
    await waitFor(() => {
      expect(screen.getByTestId("thread-goal-project-field")).toBeInTheDocument();
    });
  });

  it("calls onClose when dialog is cancelled", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NewThreadDialog open={true} onClose={onClose} />,
    );
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not render when open=false", () => {
    renderWithProviders(
      <NewThreadDialog open={false} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables Create Thread and shows hint when both title and description are empty", () => {
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /create thread/i })).toBeDisabled();
    expect(
      screen.getByText(/add a title or description before creating/i),
    ).toBeInTheDocument();
  });

  it("enables Create Thread once a title is typed", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /create thread/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/title/i), "My thread");
    expect(screen.getByRole("button", { name: /create thread/i })).toBeEnabled();
    expect(
      screen.queryByText(/add a title or description before creating/i),
    ).not.toBeInTheDocument();
  });

  it("enables Create Thread once a description is typed (no title)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );
    await user.type(screen.getByPlaceholderText(/what's on your mind/i), "Some content");
    expect(screen.getByRole("button", { name: /create thread/i })).toBeEnabled();
  });

  it("invalidates the visible threads list after creating a thread", async () => {
    const user = userEvent.setup();
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    renderWithProviders(
      <NewThreadDialog open={true} onClose={vi.fn()} />,
    );

    await user.type(screen.getByLabelText(/title/i), "Live cache check");
    await user.click(screen.getByRole("button", { name: /create thread/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.threads.list("comp-1"),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["threads", "comp-1"],
    });
  });
});
