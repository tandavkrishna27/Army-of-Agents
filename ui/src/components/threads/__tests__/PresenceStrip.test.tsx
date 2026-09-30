import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PresenceStrip } from "../PresenceStrip";

/**
 * Render smoke test for the thread typing/working pill (thread-chat-experience
 * Phase 5, Task 5.3). The full live behaviour is verified visually in Phase 6
 * QA — this just locks the humanized "<Name> is <activity>…" rendering, the
 * fallback to "typing", and the placeholder loader marker.
 */
describe("PresenceStrip", () => {
  it("renders '<Name> is <activity>…' for a working agent with activity", () => {
    render(
      <PresenceStrip
        presence={[]}
        typingMembers={[]}
        workingAgents={[{ id: "a1", name: "Scout", activity: "researching" }]}
      />,
    );
    const chip = screen.getByTestId("agent-working-indicator");
    expect(chip.textContent ?? "").toMatch(/Scout is researching/);
    // Placeholder loader is present (founder-provided asset is a follow-up).
    expect(screen.getByTestId("presence-typing-loader")).toBeInTheDocument();
  });

  it("renders a default agent avatar (not a color chip) beside the activity text", () => {
    render(
      <PresenceStrip
        presence={[]}
        typingMembers={[]}
        workingAgents={[{ id: "a1", name: "Scout", activity: "researching" }]}
      />,
    );
    const chip = screen.getByTestId("agent-working-indicator");
    // The per-agent identity is now carried by an AgentAvatar (role-colored
    // robot icon), NOT the old violet token chip.
    const avatar = within(chip).getByTestId("agent-avatar");
    expect(avatar).toBeInTheDocument();
    // Default avatar renders the robot svg (no custom avatarUrl supplied).
    expect(avatar.querySelector("svg")).not.toBeNull();
    // The old violet chip styling is gone.
    expect(chip.className).not.toMatch(/violet/);
    expect(chip.className).not.toMatch(/token-skill/);
  });

  it("falls back to 'is typing…' when no activity is supplied", () => {
    render(
      <PresenceStrip
        presence={[]}
        typingMembers={[]}
        workingAgents={[{ id: "a2", name: "Engineer" }]}
      />,
    );
    expect(screen.getByTestId("agent-working-indicator").textContent ?? "").toMatch(
      /Engineer is typing/,
    );
  });

  it("collapses to a count when 3+ agents work at once", () => {
    render(
      <PresenceStrip
        presence={[]}
        typingMembers={[]}
        workingAgents={[
          { id: "a1", name: "Scout", activity: "researching" },
          { id: "a2", name: "Planner", activity: "writing the plan" },
          { id: "a3", name: "Engineer", activity: "creating an artifact" },
        ]}
      />,
    );
    expect(screen.getByTestId("agent-working-indicator").textContent ?? "").toMatch(
      /3 agents working/,
    );
  });

  it("renders only the polite live region when nobody is present", () => {
    render(<PresenceStrip presence={[]} typingMembers={[]} workingAgents={[]} />);
    expect(screen.queryByTestId("agent-working-indicator")).toBeNull();
    expect(screen.getByTestId("presence-live")).toBeInTheDocument();
  });
});
