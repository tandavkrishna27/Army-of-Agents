import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "../test-utils";
import { MyTasksWidget } from "../../components/home/widgets/MyTasksWidget";

const { issuesApiMock } = vi.hoisted(() => ({ issuesApiMock: { list: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => mockDialogContext }));
vi.mock("../../api/issues", () => ({ issuesApi: issuesApiMock }));

describe("MyTasksWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issuesApiMock.list.mockResolvedValue([
      { id: "t1", title: "Draft launch post", status: "in_progress", priority: "high" },
      { id: "t2", title: "Review crew output", status: "todo", priority: "medium" },
      { id: "t3", title: "Done thing", status: "done", priority: "low" },
    ]);
  });
  it("lists my non-terminal tasks with status", async () => {
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Draft launch post")).toBeInTheDocument();
    expect(screen.getByText("Review crew output")).toBeInTheDocument();
    // terminal tasks excluded
    expect(screen.queryByText("Done thing")).not.toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while the tasks query is in flight", () => {
    issuesApiMock.list.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("My tasks")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows the empty state with a New task CTA when I have no assigned tasks", async () => {
    issuesApiMock.list.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("No tasks assigned to you")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ New task" }));
    expect(mockDialogContext.openNewIssue).toHaveBeenCalledTimes(1);
  });

  it("hides the New task CTA while the board is in edit mode", async () => {
    issuesApiMock.list.mockResolvedValue([]);
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} editing />);

    expect(await screen.findByText("No tasks assigned to you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New task" })).not.toBeInTheDocument();
  });

  it("shows the empty state when every assigned task is terminal (done/cancelled)", async () => {
    issuesApiMock.list.mockResolvedValue([
      { id: "t1", title: "Done thing", status: "done", priority: "low" },
      { id: "t2", title: "Cancelled thing", status: "cancelled", priority: "low" },
    ]);
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("No tasks assigned to you")).toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the tasks query errors", async () => {
    issuesApiMock.list.mockRejectedValue(new Error("network error"));
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Couldn't load your tasks")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders each task row as a deep link to its issue, preferring identifier over id", async () => {
    issuesApiMock.list.mockResolvedValue([
      { id: "t1", identifier: "TC-42", title: "Draft launch post", status: "in_progress", priority: "high" },
      { id: "t2", title: "Review crew output", status: "todo", priority: "medium" },
    ]);
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);

    const withIdentifier = await screen.findByRole("link", { name: /Draft launch post/i });
    expect(withIdentifier).toHaveAttribute("href", "/issues/TC-42");

    const withoutIdentifier = screen.getByRole("link", { name: /Review crew output/i });
    expect(withoutIdentifier).toHaveAttribute("href", "/issues/t2");
  });

  it("does not render task rows as links while editing", async () => {
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} editing />);

    expect(await screen.findByText("Draft launch post")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Draft launch post/i })).not.toBeInTheDocument();
  });

  it("caps the list at 2 rows + a '+N more' tail for a short (h=1) tile", async () => {
    issuesApiMock.list.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "todo", priority: "medium" })),
    );
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Task 0")).toBeInTheDocument();
    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Task 7")).not.toBeInTheDocument();
    expect(screen.getByText("+6 more")).toBeInTheDocument();
  });

  it("caps the list at 6 rows + a '+N more' tail for a tall (h=2) tile", async () => {
    issuesApiMock.list.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "todo", priority: "medium" })),
    );
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("Task 0")).toBeInTheDocument();
    expect(screen.getByText("Task 5")).toBeInTheDocument();
    expect(screen.queryByText("Task 6")).not.toBeInTheDocument();
    expect(screen.queryByText("Task 7")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("shows no '+N more' tail when every task fits inside the current row cap", async () => {
    issuesApiMock.list.mockResolvedValue(
      Array.from({ length: 2 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "todo", priority: "medium" })),
    );
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Task 0")).toBeInTheDocument();
    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });
});
