import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentsSection } from "../components/settings/sections/EnvironmentsSection";
import type { CompanySecret, Environment } from "@armyofagents/shared";

// ─── API hook mocks ──────────────────────────────────────────────────────────

const mockMutate = vi.fn();

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

import { secretsApi } from "@/api/secrets";

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
    envVars: { NODE_ENV: "production", PORT: "3000" },
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
    name: overrides.name ?? "E2B API Key",
    key: overrides.key ?? "E2B_API_KEY",
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

// Default mutation stub — idle, no errors
function idleMutation() {
  return {
    mutate: mockMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    reset: vi.fn(),
  };
}

// ─── Render helper ───────────────────────────────────────────────────────────

function renderSection(companyId = "comp-1") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <EnvironmentsSection companyId={companyId} />
    </QueryClientProvider>,
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Safe defaults — a loaded empty list with idle mutations
  useEnvironmentsMock.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
  useCreateEnvironmentMock.mockReturnValue(idleMutation());
  useUpdateEnvironmentMock.mockReturnValue(idleMutation());
  useDeleteEnvironmentMock.mockReturnValue(idleMutation());
  useProbeEnvironmentMock.mockReturnValue(idleMutation());
  vi.mocked(secretsApi.list).mockResolvedValue([]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EnvironmentsSection", () => {
  it("shows loading skeletons while fetching", () => {
    useEnvironmentsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    renderSection();

    // RowSkeleton renders elements with data-slot="skeleton" (Skeleton component)
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no environments exist", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });

    renderSection();

    expect(screen.getByText("No environments yet")).toBeInTheDocument();
    expect(
      screen.getByText("Create your first environment"),
    ).toBeInTheDocument();
  });

  it("renders environment list rows with name and var count", () => {
    const env1 = makeEnvironment({
      id: "env-1",
      name: "production",
      envVars: { NODE_ENV: "production", PORT: "3000" },
    });
    const env2 = makeEnvironment({
      id: "env-2",
      name: "staging",
      envVars: { NODE_ENV: "staging" },
    });

    useEnvironmentsMock.mockReturnValue({
      data: [env1, env2],
      isLoading: false,
      isError: false,
    });

    renderSection();

    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    // env1 has 2 vars, env2 has 1 var
    expect(screen.getByText(/2 variables/)).toBeInTheDocument();
    expect(screen.getByText(/1 variable[^s]/)).toBeInTheDocument();
  });

  it("opens Create dialog when New Environment button clicked", async () => {
    const user = userEvent.setup();

    renderSection();

    // The empty state "Create your first environment" button also opens the dialog,
    // but there's also a "New Environment" header button — use the header one.
    const newBtn = screen.getByRole("button", { name: /new environment/i });
    await user.click(newBtn);

    // Dialog title should appear
    expect(
      screen.getByRole("heading", { name: /new environment/i }),
    ).toBeInTheDocument();
  });

  it("submits create form with name and env vars", async () => {
    const user = userEvent.setup();
    const captureMutate = vi.fn((_vars: unknown, opts: Record<string, unknown>) => {
      (opts?.onSuccess as (data: unknown, vars: unknown, ctx: unknown) => void)?.(
        makeEnvironment(),
        _vars,
        undefined,
      );
    });

    // Simulate mutate calling onSuccess
    useCreateEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: captureMutate,
    });

    renderSection();

    // Open create dialog
    await user.click(screen.getByRole("button", { name: /new environment/i }));

    // Fill in name
    const nameInput = screen.getByPlaceholderText(/e\.g\. production/i);
    await user.clear(nameInput);
    await user.type(nameInput, "testing");

    // Fill in env vars JSON — use fireEvent.change to avoid userEvent keyboard
    // escaping issues with braces/quotes inside JSON strings
    const textarea = screen.getByPlaceholderText(/\{"KEY": "value"\}/i);
    fireEvent.change(textarea, { target: { value: '{"TEST_KEY": "hello"}' } });

    // Submit
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(captureMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          input: expect.objectContaining({
            name: "testing",
            envVars: expect.objectContaining({ TEST_KEY: "hello" }),
            target: { type: "local" },
          }),
        }),
        expect.any(Object),
      );
    });
  });

  it("submits create form with sandbox-docker target", async () => {
    const user = userEvent.setup();
    const captureMutate = vi.fn((_vars: unknown, opts: Record<string, unknown>) => {
      (opts?.onSuccess as (data: unknown, vars: unknown, ctx: unknown) => void)?.(
        makeEnvironment(),
        _vars,
        undefined,
      );
    });

    useCreateEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: captureMutate,
    });

    renderSection();

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. production/i), "docker");
    await user.selectOptions(screen.getByTestId("environment-target-select"), "sandbox-docker");
    await user.type(screen.getByTestId("environment-target-image-input"), "node:22-bookworm");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(captureMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          input: expect.objectContaining({
            name: "docker",
            target: expect.objectContaining({
              type: "sandbox-docker",
              image: "node:22-bookworm",
              workdir: "/workspace",
            }),
          }),
        }),
        expect.any(Object),
      );
    });
  });

  it("probes and submits create form with E2B sandbox config", async () => {
    const user = userEvent.setup();
    const captureMutate = vi.fn();
    const probeMutate = vi.fn((_vars: unknown, opts: Record<string, unknown>) => {
      (opts?.onSuccess as (data: unknown) => void)?.({
        ok: true,
        driver: "sandbox",
        provider: "e2b",
        summary: "E2B sandbox created and workspace directory prepared.",
      });
    });

    useCreateEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: captureMutate,
    });
    useProbeEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: probeMutate,
    });
    vi.mocked(secretsApi.list).mockResolvedValue([makeSecret({ id: "secret-e2b" })]);

    renderSection();

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. production/i), "cloud");
    await user.selectOptions(screen.getByTestId("environment-target-select"), "e2b");
    await user.clear(screen.getByTestId("environment-e2b-template-input"));
    await user.type(screen.getByTestId("environment-e2b-template-input"), "base");
    await user.clear(screen.getByTestId("environment-e2b-timeout-input"));
    await user.type(screen.getByTestId("environment-e2b-timeout-input"), "60000");
    await user.click(screen.getByRole("button", { name: /test environment/i }));

    await waitFor(() => {
      expect(probeMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          input: {
            driver: "sandbox",
            config: {
              provider: "e2b",
              credentialRef: "default",
              template: "base",
              timeoutMs: 60000,
              reuseLease: false,
            },
          },
        }),
        expect.any(Object),
      );
    });
    expect(screen.getByText(/E2B sandbox created/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(captureMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "comp-1",
        input: expect.objectContaining({
          name: "cloud",
          driver: "sandbox",
          config: {
            provider: "e2b",
            credentialRef: "default",
            template: "base",
            timeoutMs: 60000,
            reuseLease: false,
          },
          target: null,
        }),
      }),
      expect.any(Object),
    );
  });

  it("keeps create dialog open and shows API validation errors when create rejects", async () => {
    const user = userEvent.setup();
    const validationError = new Error("Invalid environment variable name: 1BAD");
    const rejectMutate = vi.fn();

    useCreateEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: rejectMutate,
      isError: true,
      error: validationError,
    });

    renderSection();

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. production/i), "broken");
    fireEvent.change(screen.getByPlaceholderText(/\{"KEY": "value"\}/i), {
      target: { value: '{"1BAD": "value"}' },
    });
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(rejectMutate).toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /new environment/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/invalid environment variable name: 1bad/i)).toBeInTheDocument();
  });

  it("opens Edit dialog pre-filled with existing environment data", async () => {
    const user = userEvent.setup();
    const env = makeEnvironment({
      id: "env-1",
      name: "production",
      envVars: { NODE_ENV: "production" },
    });

    useEnvironmentsMock.mockReturnValue({
      data: [env],
      isLoading: false,
      isError: false,
    });

    renderSection();

    // Click the edit button for the environment
    const editBtn = screen.getByTitle("Edit environment");
    await user.click(editBtn);

    // Dialog should open in edit mode
    expect(
      screen.getByRole("heading", { name: /edit environment/i }),
    ).toBeInTheDocument();

    // Name field should be pre-filled
    const nameInput = screen.getByPlaceholderText(/e\.g\. production/i);
    expect((nameInput as HTMLInputElement).value).toBe("production");

    // Env vars textarea should contain the JSON
    const textarea = screen.getByPlaceholderText(/\{"KEY": "value"\}/i);
    expect((textarea as HTMLTextAreaElement).value).toContain("NODE_ENV");
  });

  it("keeps edit dialog open and shows API validation errors when update rejects", async () => {
    const user = userEvent.setup();
    const env = makeEnvironment({ id: "env-1", name: "production" });
    const validationError = new Error("Invalid environment binding for key: API_URL");
    const rejectMutate = vi.fn();

    useEnvironmentsMock.mockReturnValue({
      data: [env],
      isLoading: false,
      isError: false,
    });
    useUpdateEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: rejectMutate,
      isError: true,
      error: validationError,
    });

    renderSection();

    await user.click(screen.getByTitle("Edit environment"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(rejectMutate).toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /edit environment/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/invalid environment binding for key: api_url/i)).toBeInTheDocument();
  });

  it("shows delete confirmation dialog when trash icon clicked", async () => {
    const user = userEvent.setup();
    const env = makeEnvironment({ id: "env-1", name: "staging" });

    useEnvironmentsMock.mockReturnValue({
      data: [env],
      isLoading: false,
      isError: false,
    });

    renderSection();

    const deleteBtn = screen.getByTitle("Delete environment");
    await user.click(deleteBtn);

    // Alert dialog should appear
    expect(
      screen.getByRole("heading", { name: /delete environment\?/i }),
    ).toBeInTheDocument();
    // The env name appears both in the row and in the dialog description (in a <strong>)
    const mentions = screen.getAllByText("staging");
    expect(mentions.length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: /^delete$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
  });

  it("calls deleteEnvironment mutation when confirm delete clicked", async () => {
    const user = userEvent.setup();
    const env = makeEnvironment({ id: "env-99", name: "old-env" });
    const deleteMutate = vi.fn();

    useEnvironmentsMock.mockReturnValue({
      data: [env],
      isLoading: false,
      isError: false,
    });
    useDeleteEnvironmentMock.mockReturnValue({
      ...idleMutation(),
      mutate: deleteMutate,
    });

    renderSection();

    await user.click(screen.getByTitle("Delete environment"));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith(
        { companyId: "comp-1", id: "env-99" },
        expect.any(Object),
      );
    });
  });

  it("shows error state when fetching environments fails", () => {
    useEnvironmentsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    renderSection();

    expect(
      screen.getByText(/failed to load environments/i),
    ).toBeInTheDocument();
  });

  it("renders section header with title and New Environment button", () => {
    renderSection();

    expect(
      screen.getByRole("heading", { name: /environments/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /new environment/i }),
    ).toBeInTheDocument();
  });

  it("shows singular 'variable' for env with exactly 1 var", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [makeEnvironment({ envVars: { ONLY_ONE: "value" } })],
      isLoading: false,
      isError: false,
    });

    renderSection();

    expect(screen.getByText(/1 variable[^s]/)).toBeInTheDocument();
    expect(screen.queryByText(/1 variables/)).not.toBeInTheDocument();
  });

  it("shows 'No variables' for env with empty envVars", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [makeEnvironment({ envVars: {} })],
      isLoading: false,
      isError: false,
    });

    renderSection();

    expect(screen.getByText(/No variables/)).toBeInTheDocument();
  });

  it("shows sandbox-docker target summary for target-aware environments", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [
        makeEnvironment({
          target: { type: "sandbox-docker", image: "node:22-bookworm" },
        }),
      ],
      isLoading: false,
      isError: false,
    });

    renderSection();

    expect(screen.getByText(/sandbox-docker: node:22-bookworm/)).toBeInTheDocument();
  });

  it("shows E2B target summary for E2B sandbox environments", () => {
    useEnvironmentsMock.mockReturnValue({
      data: [
        makeEnvironment({
          driver: "sandbox",
          config: { provider: "e2b", credentialRef: "default", template: "base" },
          target: null,
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });

    renderSection();

    expect(screen.getByText(/E2B Sandbox: base/)).toBeInTheDocument();
  });
});
