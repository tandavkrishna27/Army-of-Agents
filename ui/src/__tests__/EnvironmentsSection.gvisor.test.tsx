// Phase 6 (mt-cloud) §3 Task 3.6 — EnvironmentsSection gVisor sandbox option +
// execution-target pin (Phase 5 Task 12). Mirrors the harness in the sibling
// `EnvironmentsSection.test.tsx` (mocked @/api/environments hooks + a real
// QueryClientProvider so the component's own `useQuery` for
// `executionTargetsApi.list` runs for real against a mocked API client) and
// the RTL pattern in `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`.
//
// The pure mapping this exercises end-to-end (buildGvisorConfig /
// normalizeExecutionTargetId) already has its own unit coverage in
// `ui/src/components/settings/sections/environment-target-form.test.ts` — this
// file asserts the FORM wires those helpers correctly: selecting gVisor
// renders the hardened fields, and the "Pin to Execution Target" picker
// (org-admin-gated, only rendered when `organizationId` is supplied) lands its
// selection in the submitted `executionTargetId`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentsSection } from "../components/settings/sections/EnvironmentsSection";
import type { CompanySecret, Environment } from "@armyofagents/shared";

// ─── API hook mocks ──────────────────────────────────────────────────────────

const useEnvironmentsMock = vi.fn();
const useCreateEnvironmentMock = vi.fn();
const useUpdateEnvironmentMock = vi.fn();
const useDeleteEnvironmentMock = vi.fn();
const useProbeEnvironmentMock = vi.fn();

vi.mock("@/api/environments", () => ({
  useEnvironments: (...args: unknown[]) => useEnvironmentsMock(...args),
  useCreateEnvironment: (...args: unknown[]) => useCreateEnvironmentMock(...args),
  useUpdateEnvironment: (...args: unknown[]) => useUpdateEnvironmentMock(...args),
  useDeleteEnvironment: (...args: unknown[]) => useDeleteEnvironmentMock(...args),
  useProbeEnvironment: (...args: unknown[]) => useProbeEnvironmentMock(...args),
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock("@/api/execution-targets", () => ({
  executionTargetsApi: {
    list: vi.fn(),
  },
}));

import { secretsApi } from "@/api/secrets";
import { executionTargetsApi } from "@/api/execution-targets";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    companyId: "comp-1",
    name: "production",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeSecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: overrides.id ?? "secret-1",
    companyId: "comp-1",
    name: overrides.name ?? "Secret",
    key: overrides.key ?? "SECRET_KEY",
    status: overrides.status ?? "active",
    managedMode: "aoa_managed",
    provider: "local_encrypted",
    providerConfigId: null,
    providerMetadata: null,
    externalRef: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeExecutionTarget(overrides: Partial<{
  id: string;
  organizationId: string | null;
  slug: string;
  kind: string;
  trustClass: string;
  status: string;
  lastSeenAt: string | null;
}> = {}) {
  return {
    id: "et-shared-pool",
    organizationId: "org-1",
    slug: "shared-pool",
    kind: "pooled_gvisor" as const,
    trustClass: "shared_multitenant" as const,
    status: "active" as const,
    lastSeenAt: null,
    ...overrides,
  };
}

function idleMutation() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    reset: vi.fn(),
  };
}

// ─── Render helper ───────────────────────────────────────────────────────────

function renderSection({
  companyId = "comp-1",
  organizationId = null as string | null,
  deploymentMode = "local_trusted" as "local_trusted" | "authenticated" | "cloud_auth",
} = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <EnvironmentsSection companyId={companyId} organizationId={organizationId} deploymentMode={deploymentMode} />
    </QueryClientProvider>,
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  useEnvironmentsMock.mockReturnValue({ data: [], isLoading: false, isError: false });
  useCreateEnvironmentMock.mockReturnValue(idleMutation());
  useUpdateEnvironmentMock.mockReturnValue(idleMutation());
  useDeleteEnvironmentMock.mockReturnValue(idleMutation());
  useProbeEnvironmentMock.mockReturnValue(idleMutation());
  vi.mocked(secretsApi.list).mockResolvedValue([]);
  vi.mocked(executionTargetsApi.list).mockResolvedValue([]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EnvironmentsSection — gVisor sandbox option + execution-target pin", () => {
  it("shows only E2B and no execution-target pin in cloud_auth", async () => {
    const user = userEvent.setup();
    renderSection({ organizationId: "org-1", deploymentMode: "cloud_auth" });
    await user.click(screen.getByRole("button", { name: /new environment/i }));
    const select = screen.getByTestId("environment-target-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["e2b"]);
    expect(screen.queryByTestId("environment-execution-target-pin-select")).not.toBeInTheDocument();
    expect(screen.getByText(/gVisor.*remain unavailable on AoA Cloud/i)).toBeInTheDocument();
    expect(executionTargetsApi.list).not.toHaveBeenCalled();
  });

  it("warns when an existing cloud environment must be migrated", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [makeEnvironment({
        driver: "sandbox",
        config: { provider: "gvisor", runtime: "runsc" },
        executionTargetId: "et-shared-pool",
      })],
      isLoading: false,
      isError: false,
    });
    renderSection({ deploymentMode: "cloud_auth" });
    expect(screen.getByText(/Unavailable on AoA Cloud.*migrate.*unpinned E2B/i)).toBeInTheDocument();
  });

  it("lists gVisor as a target-type option alongside local/sandbox-docker/e2b", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /new environment/i }));

    const select = screen.getByTestId("environment-target-select") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.value);
    expect(optionLabels).toEqual(["local", "sandbox-docker", "e2b", "gvisor"]);
    expect(
      screen.getByRole("option", { name: /gVisor Sandbox \(hardened, runsc\)/i }),
    ).toBeInTheDocument();
  });

  it("selecting gVisor reveals the hardened image/memory/cpus/pids fields with defaults", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.selectOptions(screen.getByTestId("environment-target-select"), "gvisor");

    const imageInput = screen.getByTestId("environment-gvisor-image-input") as HTMLInputElement;
    const memoryInput = screen.getByTestId("environment-gvisor-memory-input") as HTMLInputElement;
    const cpusInput = screen.getByTestId("environment-gvisor-cpus-input") as HTMLInputElement;
    const pidsInput = screen.getByTestId("environment-gvisor-pids-input") as HTMLInputElement;

    expect(imageInput).toBeInTheDocument();
    // New (unedited) environment: defaults come from DEFAULT_GVISOR_FIELDS.
    expect(memoryInput.value).toBe("2g");
    expect(cpusInput.value).toBe("2");
    expect(pidsInput.value).toBe("512");

    // The runsc/hardening explainer copy is shown so the founder knows what
    // they are opting into before submitting. (Matches both the <select>
    // option label and the explainer paragraph, so assert >= 2 hits rather
    // than a single unique node.)
    expect(screen.getAllByText(/runsc/i).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/hardened, default-off isolation profile/i),
    ).toBeInTheDocument();
  });

  it("does not render the execution-target pin picker when the company has no organizationId", async () => {
    const user = userEvent.setup();
    renderSection({ organizationId: null });

    await user.click(screen.getByRole("button", { name: /new environment/i }));

    expect(
      screen.queryByTestId("environment-execution-target-pin-select"),
    ).not.toBeInTheDocument();
  });

  it("renders the Pin to Execution Target picker listing the org's execution targets", async () => {
    vi.mocked(executionTargetsApi.list).mockResolvedValue([
      makeExecutionTarget({ id: "et-shared-pool", slug: "shared-pool", kind: "pooled_gvisor" }),
      makeExecutionTarget({ id: "et-dedicated", slug: "acme-dedicated", kind: "dedicated_worker", status: "draining" }),
    ]);

    const user = userEvent.setup();
    renderSection({ organizationId: "org-1" });

    await user.click(screen.getByRole("button", { name: /new environment/i }));

    const pinSelect = await screen.findByTestId("environment-execution-target-pin-select");
    await waitFor(() => {
      expect(executionTargetsApi.list).toHaveBeenCalledWith("org-1");
    });

    // Auto (unpinned) is always first, then one <option> per execution target.
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /shared-pool \(pooled_gvisor\)/i })).toBeInTheDocument();
    });
    expect(
      screen.getByRole("option", { name: /acme-dedicated \(dedicated_worker, draining\)/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Auto \(route by credential\)$/i })).toBeInTheDocument();
    expect((pinSelect as HTMLSelectElement).value).toBe("");
  });

  it("submitting a gVisor environment pinned to an execution target includes both the hardened config and executionTargetId", async () => {
    vi.mocked(executionTargetsApi.list).mockResolvedValue([
      makeExecutionTarget({ id: "et-shared-pool", slug: "shared-pool", kind: "pooled_gvisor" }),
    ]);
    const captureMutate = vi.fn((_vars: unknown, opts: Record<string, unknown>) => {
      (opts?.onSuccess as (data: unknown, vars: unknown, ctx: unknown) => void)?.(
        makeEnvironment(),
        _vars,
        undefined,
      );
    });
    useCreateEnvironmentMock.mockReturnValue({ ...idleMutation(), mutate: captureMutate });

    const user = userEvent.setup();
    renderSection({ organizationId: "org-1" });

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. production/i), "hardened-sandbox");
    await user.selectOptions(screen.getByTestId("environment-target-select"), "gvisor");
    await user.type(screen.getByTestId("environment-gvisor-image-input"), "aoa/agent-base:latest");

    const pinSelect = await screen.findByTestId("environment-execution-target-pin-select");
    await waitFor(() => expect(executionTargetsApi.list).toHaveBeenCalled());
    await user.selectOptions(pinSelect, "et-shared-pool");

    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(captureMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          input: expect.objectContaining({
            name: "hardened-sandbox",
            driver: "sandbox",
            target: null,
            // The execution-target pin selection is threaded straight through
            // to the submitted payload — this is the multi-tenant behavior
            // the plan calls out (Phase 5 Task 12/13 pin selector).
            executionTargetId: "et-shared-pool",
            config: expect.objectContaining({
              provider: "gvisor",
              image: "aoa/agent-base:latest",
              runtime: "runsc",
              network: "none",
              isolation: expect.objectContaining({
                user: "1000:1000",
                capDropAll: true,
                noNewPrivileges: true,
                readOnlyRootfs: true,
                memory: "2g",
                cpus: "2",
                pidsLimit: 512,
              }),
            }),
          }),
        }),
        expect.any(Object),
      );
    });
  });

  it("leaves executionTargetId null (unpinned/auto-route) when the pin selector is left on Auto", async () => {
    vi.mocked(executionTargetsApi.list).mockResolvedValue([
      makeExecutionTarget({ id: "et-shared-pool", slug: "shared-pool" }),
    ]);
    const captureMutate = vi.fn((_vars: unknown, opts: Record<string, unknown>) => {
      (opts?.onSuccess as (data: unknown) => void)?.(makeEnvironment());
    });
    useCreateEnvironmentMock.mockReturnValue({ ...idleMutation(), mutate: captureMutate });

    const user = userEvent.setup();
    renderSection({ organizationId: "org-1" });

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. production/i), "auto-routed");
    await user.selectOptions(screen.getByTestId("environment-target-select"), "gvisor");
    await user.type(screen.getByTestId("environment-gvisor-image-input"), "aoa/agent-base:latest");

    // Wait for the picker to load, but never select anything in it.
    await screen.findByTestId("environment-execution-target-pin-select");
    await waitFor(() => expect(executionTargetsApi.list).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(captureMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ executionTargetId: null }),
        }),
        expect.any(Object),
      );
    });
  });

  it("shows the org-admin-gated hint instead of blocking the dialog when the execution-targets list fails", async () => {
    vi.mocked(executionTargetsApi.list).mockRejectedValue(new Error("forbidden"));

    const user = userEvent.setup();
    renderSection({ organizationId: "org-1" });

    await user.click(screen.getByRole("button", { name: /new environment/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/execution targets are only visible to organization admins/i),
      ).toBeInTheDocument();
    });
    // The rest of the dialog remains usable (degrades to Auto-only, never blocks).
    expect(screen.getByTestId("environment-execution-target-pin-select")).toBeInTheDocument();
  });
});
