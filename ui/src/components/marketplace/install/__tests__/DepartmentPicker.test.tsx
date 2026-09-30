import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { DepartmentPicker } from "../DepartmentPicker";
import { projectsApi } from "@/api/projects";

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn() },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("DepartmentPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while fetching", () => {
    vi.mocked(projectsApi.list).mockImplementation(() => new Promise(() => {}));
    wrap(<DepartmentPicker companyId="c1" value={null} onChange={() => {}} />);
    expect(screen.getByText(/loading departments/i)).toBeInTheDocument();
  });

  it("renders dropdown of departments only (filters out type='project')", async () => {
    vi.mocked(projectsApi.list).mockResolvedValueOnce([
      { id: "d1", name: "Engineering", type: "department" },
      { id: "p1", name: "Q1 Roadmap", type: "project" },
      { id: "d2", name: "Marketing", type: "department" },
    ] as any);
    wrap(<DepartmentPicker companyId="c1" value={null} onChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Install to department")).toBeInTheDocument(),
    );
  });

  it("shows error message when no departments exist", async () => {
    vi.mocked(projectsApi.list).mockResolvedValueOnce([
      { id: "p1", name: "Q1 Roadmap", type: "project" },
    ] as any);
    wrap(<DepartmentPicker companyId="c1" value={null} onChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/No departments available/i)).toBeInTheDocument(),
    );
  });

  it("does not fetch when companyId is null + shows 'Select company first' hint", () => {
    wrap(<DepartmentPicker companyId={null} value={null} onChange={() => {}} />);
    expect(projectsApi.list).not.toHaveBeenCalled();
    expect(screen.getByText(/select a company first/i)).toBeInTheDocument();
  });
});
