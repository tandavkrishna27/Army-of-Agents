import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { DesktopDevice } from "@/api/desktop-devices";

// --- Company context: a company linked to an organization by default. Individual
//     tests override selectedCompany to exercise the two guards. ---
const companyState: {
  selectedCompanyId: string | null;
  selectedCompany: { id: string; organizationId?: string | null } | null;
} = {
  selectedCompanyId: "company-1",
  selectedCompany: { id: "company-1", organizationId: "org-1" },
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

const listMock = vi.fn();
const verifyMock = vi.fn();
vi.mock("@/api/desktop-devices", () => ({
  desktopDevicesApi: {
    list: (...args: unknown[]) => listMock(...args),
    verify: (...args: unknown[]) => verifyMock(...args),
  },
}));

import { DevicesSection } from "../DevicesSection";

function device(over: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: "dev-1",
    targetSlug: "owner-desktop",
    label: "Alex's MacBook",
    status: "active",
    deviceGeneration: 2,
    enrolledAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    health: "healthy",
    ...over,
  };
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DevicesSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  companyState.selectedCompanyId = "company-1";
  companyState.selectedCompany = { id: "company-1", organizationId: "org-1" };
});

describe("DevicesSection", () => {
  it("renders the empty state when the org has no connected devices", async () => {
    listMock.mockResolvedValueOnce([]);
    renderSection();

    expect(await screen.findByText("No devices connected yet")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith("org-1");
  });

  it("lists each device with its label, status pill, target slug and generation", async () => {
    listMock.mockResolvedValueOnce([
      device(),
      device({ deviceId: "dev-2", label: "Build server", status: "draining", targetSlug: "org-server", deviceGeneration: 5 }),
    ]);
    renderSection();

    expect(await screen.findByText("Alex's MacBook")).toBeInTheDocument();
    expect(screen.getByText("Build server")).toBeInTheDocument();
    // Worker-status labels are mapped to the operator vocabulary.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Draining")).toBeInTheDocument();
    // The projected target slug and generation are surfaced on the row.
    expect(screen.getByText("owner-desktop")).toBeInTheDocument();
    expect(screen.getByText(/gen 5/)).toBeInTheDocument();
  });

  it("shows a never-seen device without crashing on a null lastSeenAt", async () => {
    listMock.mockResolvedValueOnce([
      device({ lastSeenAt: null, enrolledAt: null, health: "never_seen" }),
    ]);
    renderSection();

    expect(await screen.findByText("Alex's MacBook")).toBeInTheDocument();
    // "last check-in never" is rendered from the null timestamp.
    expect(screen.getByText(/last check-in never/)).toBeInTheDocument();
    // E11 M2 — the computed liveness pill renders its honest label.
    expect(screen.getByText("Never checked in")).toBeInTheDocument();
  });

  it("renders the health pill and a read-only verify action per device (E11 M2)", async () => {
    listMock.mockResolvedValueOnce([
      device({ health: "healthy" }),
      device({ deviceId: "dev-2", label: "Stale box", health: "stale" }),
    ]);
    renderSection();

    expect(await screen.findByText("Alex's MacBook")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    // One verify button per device row; the action is read-only.
    expect(screen.getAllByRole("button", { name: /verify enrolment key/i })).toHaveLength(2);
  });

  it("does not fetch and shows a guard when the company has no organization", async () => {
    companyState.selectedCompany = { id: "company-1", organizationId: null };
    renderSection();

    expect(
      await screen.findByText(/not linked to an organization/i),
    ).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("prompts for company selection when none is selected", async () => {
    companyState.selectedCompanyId = null;
    companyState.selectedCompany = null;
    renderSection();

    expect(
      await screen.findByText(/Select a company to view connected devices/i),
    ).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });
});
