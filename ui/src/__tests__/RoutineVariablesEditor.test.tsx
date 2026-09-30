import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { RoutineVariablesEditor } from "../components/routines/RoutineVariablesEditor";

const routinesUpdate = vi.fn();
vi.mock("@/api/routines", () => ({
  routinesApi: {
    update: (...args: unknown[]) => routinesUpdate(...args),
  },
}));

const pushToast = vi.fn();
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

const routineId = "11111111-1111-1111-1111-111111111111";
const editorCallbacks = {
  getBaseRevisionId: () => null,
  onRoutineUpdated: vi.fn(),
};

describe("RoutineVariablesEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routinesUpdate.mockResolvedValue({});
  });

  it("renders empty state when title and description contain no placeholders", () => {
    renderWithProviders(
      <RoutineVariablesEditor
        routineId={routineId}
        title="Daily standup"
        description="Post a summary to the team"
        initialVariables={[]}
        {...editorCallbacks}
      />,
    );
    expect(
      screen.getByText(/no variables detected/i),
    ).toBeInTheDocument();
  });

  it("renders one editable row per detected placeholder from title+description", () => {
    renderWithProviders(
      <RoutineVariablesEditor
        routineId={routineId}
        title="Review {{topic}}"
        description="Focus area: {{focus}}"
        initialVariables={[]}
        {...editorCallbacks}
      />,
    );
    expect(screen.getByText("{{topic}}")).toBeInTheDocument();
    expect(screen.getByText("{{focus}}")).toBeInTheDocument();
  });

  it("ignores builtin {{date}} placeholder", () => {
    renderWithProviders(
      <RoutineVariablesEditor
        routineId={routineId}
        title="Daily digest {{date}} for {{topic}}"
        description=""
        initialVariables={[]}
        {...editorCallbacks}
      />,
    );
    expect(screen.queryByText("{{date}}")).not.toBeInTheDocument();
    expect(screen.getByText("{{topic}}")).toBeInTheDocument();
  });

  it("preserves saved metadata when the placeholder is already configured", () => {
    renderWithProviders(
      <RoutineVariablesEditor
        routineId={routineId}
        title="Review {{topic}}"
        description=""
        initialVariables={[
          { name: "topic", label: "Review topic", type: "text", defaultValue: "Q4 OKRs", required: true, options: [] },
        ]}
        {...editorCallbacks}
      />,
    );
    expect(screen.getByDisplayValue("Review topic")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Q4 OKRs")).toBeInTheDocument();
  });

  it("save button calls routinesApi.update with edited variables", async () => {
    const user = userEvent.setup();
    const onRoutineUpdated = vi.fn();
    const updatedRoutine = { latestRevisionId: "revision-2" };
    routinesUpdate.mockResolvedValue(updatedRoutine);
    renderWithProviders(
      <RoutineVariablesEditor
        routineId={routineId}
        title="Review {{topic}}"
        description=""
        initialVariables={[]}
        getBaseRevisionId={() => "revision-1"}
        onRoutineUpdated={onRoutineUpdated}
      />,
    );
    const labelInput = screen.getByLabelText(/label/i) as HTMLInputElement;
    await user.type(labelInput, "Review topic");
    const saveBtn = screen.getByRole("button", { name: /save variables/i });
    await user.click(saveBtn);
    await waitFor(() => {
      expect(routinesUpdate).toHaveBeenCalledWith(
        routineId,
        expect.objectContaining({
          variables: expect.arrayContaining([
            expect.objectContaining({ name: "topic", label: "Review topic" }),
          ]),
          baseRevisionId: "revision-1",
        }),
      );
      expect(onRoutineUpdated).toHaveBeenCalledWith(updatedRoutine);
    });
  });
});
