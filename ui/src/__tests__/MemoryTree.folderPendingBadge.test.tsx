import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Isolated fixture (separate from MemoryTree.test.tsx) so this feature test
// doesn't perturb the shared counts asserted there.
const navigateMock = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      {
        id: "f-eng-decisions",
        companyId: "co-1",
        departmentId: "d-eng",
        path: "engineering/Decisions",
        displayName: "Decisions",
        icon: null,
        sortOrder: 0,
        seedKey: "decisions",
      },
    ]),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "d-eng",
        type: "department",
        name: "Engineering",
        archivedAt: null,
        urlKey: "engineering",
      },
    ]),
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => ({
      items: [
        {
          id: "i-d1",
          title: "We ship on Fridays",
          layer: "domain",
          status: "pending",
          departmentId: "d-eng",
          folderPath: "engineering/Decisions",
          updatedAt: new Date().toISOString(),
        },
        {
          id: "i-d2",
          title: "Approved note",
          layer: "domain",
          status: "approved",
          departmentId: "d-eng",
          folderPath: "engineering/Decisions",
          updatedAt: new Date().toISOString(),
        },
      ],
      semanticAvailable: true,
    })),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: { issuePrefix: "co1" },
  }),
}));

import { MemoryTree } from "../components/memory/MemoryTree";

function renderTree() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryTree
          companyId="co-1"
          selectedFolderPath=""
          selectedDepartmentId={null}
          selectedLayer={null}
          selectedGoalId={null}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryTree folder pending badge", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("badges a folder that has pending memory in the tree", async () => {
    const user = userEvent.setup();
    renderTree();
    await waitFor(() => expect(screen.getByText("Engineering")).toBeInTheDocument());
    const eng = screen.getByText("Engineering").closest("div");
    expect(eng).not.toBeNull();
    await user.click(eng!);
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    const decisionsRow = screen.getByText("Decisions").closest("div");
    expect(decisionsRow?.textContent).toMatch(/1 pending/i);
  });
});
