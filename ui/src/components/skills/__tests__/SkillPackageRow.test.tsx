// ui/src/components/skills/__tests__/SkillPackageRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SkillPackageRow } from "../SkillPackageRow";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

const baseProps = {
  packageId: "garrytan/gstack",
  name: "gstack",
  count: 28,
  provider: null,
  expanded: false,
  hasUpdate: false,
  active: false,
  onToggleExpand: vi.fn(),
};

function renderRow(props: Partial<typeof baseProps> = {}) {
  return render(
    <MemoryRouter>
      <SkillPackageRow {...baseProps} {...props} />
    </MemoryRouter>,
  );
}

describe("SkillPackageRow", () => {
  it("renders the package name and count", () => {
    const { getByText } = renderRow();
    expect(getByText("gstack")).toBeInTheDocument();
    expect(getByText("28")).toBeInTheDocument();
  });

  it("shows update chip when hasUpdate=true", () => {
    const { getByTitle } = renderRow({ hasUpdate: true });
    expect(getByTitle(/update available/i)).toBeInTheDocument();
  });

  it("shows provider logo when package metadata includes one", () => {
    const { getByRole } = renderRow({
      provider: {
        id: "angular",
        name: "Angular",
        logoUrl: "https://github.com/angular.png",
        fallbackInitials: "NG",
      },
    });
    expect(getByRole("img", { name: "Angular logo" })).toBeInTheDocument();
  });

  it("hides update chip when hasUpdate=false", () => {
    const { queryByTitle } = renderRow({ hasUpdate: false });
    expect(queryByTitle(/update available/i)).toBeNull();
  });

  it("calls onToggleExpand when the chevron button is clicked", () => {
    const onToggleExpand = vi.fn();
    const { getByLabelText } = renderRow({ onToggleExpand });
    fireEvent.click(getByLabelText(/expand|collapse/i));
    expect(onToggleExpand).toHaveBeenCalledWith("garrytan/gstack");
  });

  it("does not call onToggleExpand when the package name link is clicked", () => {
    const onToggleExpand = vi.fn();
    const { getByText } = renderRow({ onToggleExpand });
    fireEvent.click(getByText("gstack"));
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("renders chevron-right when collapsed and chevron-down when expanded", () => {
    const { container, rerender } = renderRow({ expanded: false });
    expect(container.querySelector("[data-icon='chevron-right']")).not.toBeNull();
    rerender(
      <MemoryRouter>
        <SkillPackageRow {...baseProps} expanded={true} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-icon='chevron-down']")).not.toBeNull();
  });

  it("places the chevron control after the package count", () => {
    const { container, getByText } = renderRow();
    const count = getByText("28");
    const chevron = container.querySelector("[data-icon='chevron-right']");
    expect(chevron).not.toBeNull();

    expect(count.compareDocumentPosition(chevron as Element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
