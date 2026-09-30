import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelFrame } from "../PanelFrame";
import { initialState, panelKey, panelReducer } from "../panel-state";
const scope = { companyId: "a", userId: "u", conversationId: "c" };
const ref = { companyId: "a", kind: "task" as const, id: "t" };
const state = panelReducer(initialState(scope), {
  type: "open",
  ref,
  title: "Task",
  rect: { x: 0, y: 0, width: 500, height: 400 },
});
const panel = state.panels[panelKey(scope, ref)];
describe("shared frame button contract", () => {
  it.each([
    ["Pin panel", { type: "pin", value: true }],
    ["Maximize panel", { type: "maximize" }],
    ["Minimize panel", { type: "minimize" }],
    ["Close panel", { type: "close" }],
  ])("%s uses the same captured incarnation", (name, action) => {
    const dispatch = vi.fn();
    render(
      <PanelFrame
        panel={panel}
        selected
        maximized={false}
        dispatch={dispatch}
        shielded={false}
        onHeaderKeyDown={() => {}}
      >
        Fixture
      </PanelFrame>
    );
    expect(screen.getByRole("region", { name: "Task" })).toHaveAttribute(
      "data-generation",
      String(panel.generation)
    );
    fireEvent.click(screen.getByRole("button", { name }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      ...action,
      key: panel.key,
      generation: panel.generation,
    });
  });
});
