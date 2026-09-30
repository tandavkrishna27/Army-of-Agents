import { render, screen } from "@testing-library/react";
import { Mic } from "lucide-react";
import { describe, expect, it } from "vitest";
import { AttentionCount, IconChip, ParticipantStack } from "../ThreadCardIcons";

describe("ThreadCardIcons", () => {
  it("renders attention, participant, and icon metadata accessibly", () => {
    render(<AttentionCount count={3} />);
    expect(screen.getByLabelText("3 items need review")).toBeInTheDocument();

    render(
      <ParticipantStack
        participants={[{ name: "TK" }, { name: "Revenue Agent" }]}
        total={2}
      />,
    );
    expect(screen.getByLabelText("TK")).toBeInTheDocument();
    expect(screen.getByLabelText("Revenue Agent")).toBeInTheDocument();

    render(<IconChip Icon={Mic} label="Source: Voice" tone="source" />);
    expect(screen.getByLabelText("Source: Voice")).toBeInTheDocument();
  });
});
