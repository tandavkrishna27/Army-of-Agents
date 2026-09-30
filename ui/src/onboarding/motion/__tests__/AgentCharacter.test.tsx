import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AgentCharacter } from "../AgentCharacter";

describe("AgentCharacter", () => {
  it("applies the state class and label", () => {
    const { container, getByText } = render(
      <AgentCharacter state="working" label="MEMORY" eyeColor="#D13A26" />,
    );
    expect(container.querySelector(".agent.is-working")).toBeTruthy();
    expect(getByText("MEMORY")).toBeTruthy();
  });

  it("idle state has no is-* modifier", () => {
    const { container } = render(<AgentCharacter />);
    const el = container.querySelector(".agent")!;
    expect(el.className).not.toMatch(/is-(working|thinking|done)/);
  });

  it("applies size modifier classes", () => {
    const { container: sm } = render(<AgentCharacter size="sm" />);
    expect(sm.querySelector(".agent.sm")).toBeTruthy();
    const { container: lg } = render(<AgentCharacter size="lg" />);
    expect(lg.querySelector(".agent.lg")).toBeTruthy();
  });

  it("is decorative with an accessible label", () => {
    const { container } = render(<AgentCharacter label="MEMORY" />);
    const el = container.querySelector(".agent")!;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("MEMORY");
  });
});
