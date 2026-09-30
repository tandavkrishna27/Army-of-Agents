import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UniverseCommanderChat } from "./UniverseCommanderChat";
import { initialPresentation } from "./commander-presentation";
vi.mock("../InternalAgentPanel", () => ({ AgentPanelContent: () => {
  const [draft, setDraft] = useState("");
  return <input aria-label="Canonical composer" value={draft} onChange={e => setDraft(e.target.value)} />;
} }));
afterEach(cleanup);
it("keeps the canonical composer mounted through every presentation", () => {
 const onPresentationChange = vi.fn();
 const props = { conversationId: null, onSelectConversation: vi.fn(), onPresentationChange };
 const { rerender } = render(<UniverseCommanderChat {...props} presentation={initialPresentation()} />);
 const input = screen.getByLabelText("Canonical composer");
 fireEvent.change(input, { target: { value: "Keep my draft" } });
 for (const chat of ["expanded", "maximized", "tucked", "compact"] as const) {
   rerender(<UniverseCommanderChat {...props} presentation={{ ...initialPresentation(), chat }} />);
   expect(screen.getByLabelText("Canonical composer")).toBe(input);
   expect((input as HTMLInputElement).value).toBe("Keep my draft");
 }
 fireEvent.click(screen.getByRole("button", { name: "Expand Commander" }));
 expect(onPresentationChange).toHaveBeenCalledWith(expect.objectContaining({ chat: "expanded" }));
});
it("places Compact last and restores maximized chat to expanded", () => {
 const onPresentationChange = vi.fn();
 render(<UniverseCommanderChat conversationId={null} onSelectConversation={vi.fn()} onPresentationChange={onPresentationChange} presentation={{ ...initialPresentation(), chat: "maximized" }} />);
 expect(screen.getAllByRole("button").at(-1)?.getAttribute("aria-label")).toBe("Compact Commander");
 fireEvent.click(screen.getByRole("button", { name: "Restore Commander" }));
 expect(onPresentationChange).toHaveBeenCalledWith(expect.objectContaining({ chat: "expanded" }));
});
it("returns focus to the Commander tray control when tucked", () => {
 const onPresentationChange = vi.fn();
 const onTuck = vi.fn();
 render(<UniverseCommanderChat conversationId={null} onSelectConversation={vi.fn()} onPresentationChange={onPresentationChange} onTuck={onTuck} presentation={{ ...initialPresentation(), chat: "expanded" }} />);
 fireEvent.click(screen.getByRole("button", { name: "Tuck Commander" }));
 expect(onPresentationChange).toHaveBeenCalledWith(expect.objectContaining({ chat: "tucked", chatFrontmost: false }));
 expect(onTuck).toHaveBeenCalledTimes(1);
});
