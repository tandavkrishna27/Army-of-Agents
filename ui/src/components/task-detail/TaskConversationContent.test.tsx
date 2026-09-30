import {useState} from "react";
import {fireEvent, render, screen} from "@testing-library/react";
import {expect, it, vi} from "vitest";
import {TaskConversationContent} from "./TaskConversationContent";

vi.mock("../workspace/WorkspaceTimeline", () => ({WorkspaceTimeline: () => {
  const [pending, setPending] = useState("");
  return <input aria-label="Pending composer state" value={pending} onChange={event => setPending(event.target.value)}/>;
}}));

it("preserves the mounted composer across task deactivation", () => {
  const view = render(<TaskConversationContent issueId="task" active/>);
  fireEvent.change(screen.getByRole("textbox"), {target: {value: "pending attachment or retry"}});
  view.rerender(<TaskConversationContent issueId="task" active={false}/>);
  view.rerender(<TaskConversationContent issueId="task" active/>);
  expect(screen.getByRole("textbox")).toHaveValue("pending attachment or retry");
});
