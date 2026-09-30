import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentAvatar, agentRoleColor } from "../AgentAvatar";

describe("AgentAvatar", () => {
  it("renders the default RobotIcon (svg) when no avatarUrl is supplied", () => {
    render(<AgentAvatar name="Scout" />);
    const avatar = screen.getByTestId("agent-avatar");
    expect(avatar).toBeInTheDocument();
    // Default = role-colored circle containing the robot svg, no <img>.
    expect(avatar.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders an <img> with the avatarUrl when one is supplied", () => {
    render(<AgentAvatar name="Scribe" avatarUrl="https://example.com/scribe.png" />);
    const img = screen.getByTestId("entry-agent-avatar") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toBe("https://example.com/scribe.png");
    // The default robot svg is not rendered when a custom image is present.
    expect(screen.getByTestId("agent-avatar").querySelector("svg")).toBeNull();
  });

  it("applies the supplied size to the circle", () => {
    render(<AgentAvatar name="Planner" size={20} />);
    const avatar = screen.getByTestId("agent-avatar");
    expect(avatar.style.width).toBe("20px");
    expect(avatar.style.height).toBe("20px");
  });

  it("agentRoleColor maps known roles and falls back to slate", () => {
    expect(agentRoleColor("Scribe")).toBe("#6470DC");
    expect(agentRoleColor("Adjutant")).toBe("#D9A938");
    expect(agentRoleColor("Some Unknown Agent")).toBe("#7E8AA8");
    expect(agentRoleColor(null)).toBe("#7E8AA8");
  });
});
