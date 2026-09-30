import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputAddMenu } from "@/components/commander/InputAddMenu";

describe("InputAddMenu", () => {
  it("renders the + trigger button", () => {
    render(<InputAddMenu onUseSkill={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add/i })).toBeInTheDocument();
  });

  it("opening the menu shows the skill action and NO attach item (mock v2)", async () => {
    const user = userEvent.setup();
    render(<InputAddMenu onUseSkill={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /add/i }));

    const useSkillItem = await screen.findByText("Use a skill");
    expect(useSkillItem).toBeInTheDocument();
    // The item itself should not have the disabled attribute
    const useSkillMenuItem = useSkillItem.closest("[role='menuitem']");
    expect(useSkillMenuItem).not.toHaveAttribute("data-disabled");

    // Mock v2: 📎 in the shared toolbar is the ONLY attach entry — the menu
    // must not duplicate it.
    expect(screen.queryByText("Attach file")).not.toBeInTheDocument();
  });

  it("clicking 'Use a skill' calls onUseSkill", async () => {
    const onUseSkill = vi.fn();
    const user = userEvent.setup();
    render(<InputAddMenu onUseSkill={onUseSkill} />);

    await user.click(screen.getByRole("button", { name: /add/i }));
    const useSkillItem = await screen.findByText("Use a skill");
    await user.click(useSkillItem);

    expect(onUseSkill).toHaveBeenCalledOnce();
  });

  it("trigger button is disabled when disabled prop is true", () => {
    render(<InputAddMenu onUseSkill={vi.fn()} disabled={true} />);
    expect(screen.getByRole("button", { name: /add/i })).toBeDisabled();
  });
});
