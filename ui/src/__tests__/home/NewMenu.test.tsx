import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewMenu } from "../../components/home/NewMenu";

const openNewIssue = vi.fn();
const openDiscussionCapture = vi.fn();
const openNewGoal = vi.fn();
const openNewAgent = vi.fn();
const openNewProject = vi.fn();

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue,
    openDiscussionCapture,
    openNewGoal,
    openNewAgent,
    openNewProject,
  }),
}));

describe("NewMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a solid, prominent 'Create' trigger button", () => {
    render(<NewMenu />);
    const trigger = screen.getByRole("button", { name: "Create" });
    expect(trigger).toBeInTheDocument();
    // Plan 7 Task 1: the trigger is now a solid (default-variant) button
    // labeled "Create" — not the old outline "+ New" button — mirroring the
    // Lobby's prominent "+ New organization" fill.
    expect(trigger).toHaveTextContent("Create");
    expect(trigger.getAttribute("data-variant")).toBe("default");
  });

  it("opening the menu shows all six creators, grouped Task/Discussion/Goal then Agent/Department/Project", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("menuitem", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Discussion" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Department" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Project" })).toBeInTheDocument();
  });

  it("'Task' calls openNewIssue", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Task" }));

    expect(openNewIssue).toHaveBeenCalledTimes(1);
    expect(openNewIssue).toHaveBeenCalledWith();
    expect(openDiscussionCapture).not.toHaveBeenCalled();
    expect(openNewGoal).not.toHaveBeenCalled();
    expect(openNewAgent).not.toHaveBeenCalled();
    expect(openNewProject).not.toHaveBeenCalled();
  });

  it("'Discussion' calls openDiscussionCapture", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Discussion" }));

    expect(openDiscussionCapture).toHaveBeenCalledTimes(1);
    expect(openDiscussionCapture).toHaveBeenCalledWith();
    expect(openNewIssue).not.toHaveBeenCalled();
    expect(openNewGoal).not.toHaveBeenCalled();
    expect(openNewAgent).not.toHaveBeenCalled();
    expect(openNewProject).not.toHaveBeenCalled();
  });

  it("'Goal' calls openNewGoal", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Goal" }));

    expect(openNewGoal).toHaveBeenCalledTimes(1);
    expect(openNewGoal).toHaveBeenCalledWith();
    expect(openNewIssue).not.toHaveBeenCalled();
    expect(openDiscussionCapture).not.toHaveBeenCalled();
    expect(openNewAgent).not.toHaveBeenCalled();
    expect(openNewProject).not.toHaveBeenCalled();
  });

  it("'Agent' calls openNewAgent", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Agent" }));

    expect(openNewAgent).toHaveBeenCalledTimes(1);
    expect(openNewAgent).toHaveBeenCalledWith();
    expect(openNewIssue).not.toHaveBeenCalled();
    expect(openDiscussionCapture).not.toHaveBeenCalled();
    expect(openNewGoal).not.toHaveBeenCalled();
    expect(openNewProject).not.toHaveBeenCalled();
  });

  it("'Department' calls openNewProject({ type: 'department' })", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Department" }));

    expect(openNewProject).toHaveBeenCalledTimes(1);
    expect(openNewProject).toHaveBeenCalledWith({ type: "department" });
    expect(openNewIssue).not.toHaveBeenCalled();
    expect(openDiscussionCapture).not.toHaveBeenCalled();
    expect(openNewGoal).not.toHaveBeenCalled();
    expect(openNewAgent).not.toHaveBeenCalled();
  });

  it("'Project' calls openNewProject({ type: 'project' })", async () => {
    const user = userEvent.setup();
    render(<NewMenu />);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: "Project" }));

    expect(openNewProject).toHaveBeenCalledTimes(1);
    expect(openNewProject).toHaveBeenCalledWith({ type: "project" });
    expect(openNewIssue).not.toHaveBeenCalled();
    expect(openDiscussionCapture).not.toHaveBeenCalled();
    expect(openNewGoal).not.toHaveBeenCalled();
    expect(openNewAgent).not.toHaveBeenCalled();
  });
});
