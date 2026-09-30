import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { RoutineRunDialog } from "../components/routines/RoutineRunDialog";

const routinesRun = vi.fn();
vi.mock("@/api/routines", () => ({
  routinesApi: {
    run: (...args: unknown[]) => routinesRun(...args),
  },
}));

const pushToast = vi.fn();
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

const routineId = "11111111-1111-1111-1111-111111111111";

describe("RoutineRunDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routinesRun.mockResolvedValue({ id: "run-1" });
  });

  it("zero-variable routine renders a confirmation body and runs on submit", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={onOpenChange}
        routineId={routineId}
        routineTitle="Daily standup"
        variables={[]}
      />,
    );
    expect(
      screen.getByText(/no variables to set/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/daily standup/i)).toBeInTheDocument();

    const runBtn = screen.getByRole("button", { name: /run routine/i });
    expect(runBtn).not.toBeDisabled();
    await user.click(runBtn);

    await waitFor(() => {
      expect(routinesRun).toHaveBeenCalledWith(routineId, { source: "manual" });
    });
  });

  it("renders one input per detected variable with matching type", () => {
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={vi.fn()}
        routineId={routineId}
        routineTitle="Review {{topic}}"
        variables={[
          { name: "topic", label: "Review topic", type: "text", defaultValue: null, required: true, options: [] },
          { name: "count", label: null, type: "number", defaultValue: null, required: false, options: [] },
          { name: "flag", label: null, type: "boolean", defaultValue: null, required: false, options: [] },
          { name: "kind", label: null, type: "select", defaultValue: null, required: false, options: ["a", "b"] },
        ]}
      />,
    );
    expect(screen.getByLabelText(/review topic/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/count/i)).toHaveAttribute("type", "number");
    expect(screen.getByText(/flag/i)).toBeInTheDocument();
    expect(screen.getByText(/kind/i)).toBeInTheDocument();
  });

  it("disables submit when a required variable is empty and shows missing list", () => {
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={vi.fn()}
        routineId={routineId}
        routineTitle="Review {{topic}}"
        variables={[
          { name: "topic", label: "Review topic", type: "text", defaultValue: null, required: true, options: [] },
        ]}
      />,
    );
    const runBtn = screen.getByRole("button", { name: /run routine/i });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/missing:.*review topic/i)).toBeInTheDocument();
  });

  it("submits typed variable values to the run endpoint", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={vi.fn()}
        routineId={routineId}
        routineTitle="Review {{topic}} x{{count}}"
        variables={[
          { name: "topic", label: "Topic", type: "text", defaultValue: null, required: true, options: [] },
          { name: "count", label: "Count", type: "number", defaultValue: null, required: true, options: [] },
        ]}
      />,
    );
    const topicInput = screen.getByLabelText(/topic/i) as HTMLInputElement;
    await user.type(topicInput, "OKRs");
    const countInput = screen.getByLabelText(/count/i) as HTMLInputElement;
    await user.type(countInput, "3");
    await user.click(screen.getByRole("button", { name: /run routine/i }));
    await waitFor(() => {
      // T11 (draft defaults + run-time variable overrides): RoutineRunDialog
      // now sends variableOverrides (string map) instead of variables.
      expect(routinesRun).toHaveBeenCalledWith(routineId, {
        source: "manual",
        variableOverrides: { topic: "OKRs", count: "3" },
      });
    });
  });

  it("prefills values from variable defaultValue", () => {
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={vi.fn()}
        routineId={routineId}
        routineTitle="Review {{topic}}"
        variables={[
          { name: "topic", label: "Topic", type: "text", defaultValue: "Q4 OKRs", required: true, options: [] },
        ]}
      />,
    );
    expect(screen.getByDisplayValue("Q4 OKRs")).toBeInTheDocument();
  });

  it("cancel button closes the dialog without running", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <RoutineRunDialog
        open
        onOpenChange={onOpenChange}
        routineId={routineId}
        routineTitle="Daily"
        variables={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(routinesRun).not.toHaveBeenCalled();
  });
});
