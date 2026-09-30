import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompanyPicker } from "../CompanyPicker";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: vi.fn(),
}));

import { useCompany } from "@/context/CompanyContext";

describe("CompanyPicker", () => {
  it("hides picker when only 1 active company", () => {
    vi.mocked(useCompany).mockReturnValue({
      companies: [{ id: "c1", name: "Acme", status: "active" }],
    } as any);
    const { container } = render(<CompanyPicker value="c1" onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dropdown when 2+ active companies", () => {
    vi.mocked(useCompany).mockReturnValue({
      companies: [
        { id: "c1", name: "Acme", status: "active" },
        { id: "c2", name: "Beta", status: "active" },
      ],
    } as any);
    render(<CompanyPicker value="c1" onChange={() => {}} />);
    expect(screen.getByLabelText("Install to company")).toBeInTheDocument();
  });

  it("filters out archived companies (1 active + 1 archived = hidden)", () => {
    vi.mocked(useCompany).mockReturnValue({
      companies: [
        { id: "c1", name: "Acme", status: "active" },
        { id: "c3", name: "Old", status: "archived" },
      ],
    } as any);
    const { container } = render(<CompanyPicker value="c1" onChange={() => {}} />);
    expect(container.firstChild).toBeNull(); // only 1 active
  });

  it("hides via forceHidden prop", () => {
    vi.mocked(useCompany).mockReturnValue({
      companies: [
        { id: "c1", name: "Acme", status: "active" },
        { id: "c2", name: "Beta", status: "active" },
      ],
    } as any);
    const { container } = render(<CompanyPicker value="c1" onChange={() => {}} forceHidden />);
    expect(container.firstChild).toBeNull();
  });
});
