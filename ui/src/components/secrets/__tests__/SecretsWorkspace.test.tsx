import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { CompanySecret, CompanySecretBinding } from "@armyofagents/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsWorkspace } from "@/components/secrets/SecretsWorkspace";
import { renderWithProviders } from "@/__tests__/test-utils";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatSecretDate,
  looksSensitiveKey,
  modeLabel,
  providerConfigSummary,
  providerLabel,
} from "@/components/secrets/secret-ui";

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    list: vi.fn(),
    providers: vi.fn(),
    create: vi.fn(),
    rotate: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    providerConfigs: {
      list: vi.fn(),
      create: vi.fn(),
      check: vi.fn(),
    },
    runtimeProviderKeys: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    remoteImport: {
      preview: vi.fn(),
      commit: vi.fn(),
    },
    bindings: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    accessEvents: vi.fn(),
  },
}));

function makeSecret(partial: Partial<CompanySecret>): CompanySecret {
  return {
    id: partial.id ?? "secret-1",
    companyId: "company-1",
    name: partial.name ?? "OpenAI API Key",
    key: partial.key ?? "OPENAI_API_KEY",
    status: partial.status ?? "active",
    managedMode: partial.managedMode ?? "aoa_managed",
    provider: partial.provider ?? "local_encrypted",
    providerConfigId: null,
    providerMetadata: null,
    externalRef: partial.externalRef ?? null,
    latestVersion: partial.latestVersion ?? 1,
    description: partial.description ?? "Used by QA",
    lastResolvedAt: partial.lastResolvedAt ?? null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-05-14T00:00:00Z"),
    updatedAt: new Date("2026-05-14T00:00:00Z"),
  };
}

function makeBinding(partial: Partial<CompanySecretBinding>): CompanySecretBinding {
  return {
    id: partial.id ?? "binding-1",
    companyId: "company-1",
    secretId: partial.secretId ?? "openai",
    targetType: partial.targetType ?? "agent",
    targetId: partial.targetId ?? "agent-1",
    configPath: partial.configPath ?? "env.OPENAI_API_KEY",
    versionSelector: partial.versionSelector ?? "latest",
    required: partial.required ?? true,
    label: partial.label ?? null,
    createdAt: new Date("2026-05-14T00:00:00Z"),
    updatedAt: new Date("2026-05-14T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.mocked(secretsApi.runtimeProviderKeys.list).mockResolvedValue([]);
  vi.mocked(secretsApi.runtimeProviderKeys.create).mockResolvedValue({} as never);
  vi.mocked(secretsApi.runtimeProviderKeys.update).mockResolvedValue({} as never);
  vi.mocked(secretsApi.runtimeProviderKeys.remove).mockResolvedValue({ ok: true });
});

describe("SecretsWorkspace", () => {
  it("renders the secrets settings shell", async () => {
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.runtimeProviderKeys.list).mockResolvedValue([]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    expect(await screen.findByRole("heading", { name: "Secrets." })).toBeTruthy();
    expect(
      screen.getByText("Credentials and secret references used by agents, environments, departments, and integrations."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Configure vault" })[0]).toBeEnabled();

    expect(screen.getByRole("tab", { name: "Inventory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Bindings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Sandbox Providers" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Vault providers" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit" })).toBeTruthy();
  });

  it("opens import dialog when an external vault provider is configured", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([
      {
        id: "aws-1",
        companyId: "company-1",
        provider: "aws_secrets_manager",
        displayName: "Production AWS",
        status: "ready",
        isDefault: true,
        config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
        healthStatus: "ready",
        healthCheckedAt: null,
        healthMessage: null,
        healthDetails: null,
        disabledAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-05-14T00:00:00Z"),
        updatedAt: new Date("2026-05-14T00:00:00Z"),
      },
    ]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByRole("dialog", { name: "Import from vault" })).toBeInTheDocument();
    expect(screen.getByText("Production AWS")).toBeInTheDocument();
  });

  it("opens the add dialog from the empty-state Add first secret control", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Add first secret" }));

    expect(screen.getByRole("dialog", { name: "Add secret" })).toBeInTheDocument();
  });

  it("sends the user to vault setup when no external vault is configured", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    const configureButton = (await screen.findAllByRole("button", { name: "Configure vault" }))[0];

    expect(configureButton).toBeEnabled();
    expect(configureButton).toHaveAttribute("title", "Configure an external vault provider before importing");

    await user.click(configureButton);

    expect(await screen.findByText("Configured vaults")).toBeInTheDocument();
  });

  it("opens the import dialog from the empty-state vault import control when an external vault is configured", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([
      {
        id: "aws-1",
        companyId: "company-1",
        provider: "aws_secrets_manager",
        displayName: "Production AWS",
        status: "ready",
        isDefault: true,
        config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
        healthStatus: "ready",
        healthCheckedAt: null,
        healthMessage: null,
        healthDetails: null,
        disabledAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-05-14T00:00:00Z"),
        updatedAt: new Date("2026-05-14T00:00:00Z"),
      },
    ]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Import from vault" }));

    expect(screen.getByRole("dialog", { name: "Import from vault" })).toBeInTheDocument();
    expect(screen.getByText("Production AWS")).toBeInTheDocument();
  });

  it("shows an error instead of the empty state when secrets fail to load", async () => {
    vi.mocked(secretsApi.list).mockRejectedValue(new Error("Network unavailable"));
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    expect(await screen.findByText("Failed to load secrets. Please refresh and try again.")).toBeTruthy();
    expect(screen.queryByText("No secrets yet")).toBeNull();
  });

  it("renders inventory for non-empty secrets and hides it on another tab", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.bindings.list).mockResolvedValue([]);
    vi.mocked(secretsApi.accessEvents).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([
      makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" }),
      makeSecret({ id: "hubspot", name: "HubSpot Private App", key: "HUBSPOT_TOKEN" }),
    ]);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    expect(await screen.findByPlaceholderText("Search by name, key, department")).toBeTruthy();
    expect(screen.getAllByText("OpenAI API Key").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HubSpot Private App").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Rotate value" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Bindings" }));

    expect(screen.queryByPlaceholderText("Search by name, key, department")).toBeNull();
    expect(await screen.findByText("No bindings for this secret")).toBeTruthy();
  });

  it("shows bindings query failures instead of the no-bindings empty state", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([
      makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" }),
    ]);
    vi.mocked(secretsApi.bindings.list).mockRejectedValue(new Error("Bindings unavailable"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("tab", { name: "Bindings" }));

    expect(await screen.findByText("Failed to load bindings for this secret.")).toBeInTheDocument();
    expect(screen.getByText("Bindings unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No bindings for this secret")).toBeNull();
  });

  it("creates and removes bindings from the bindings tab", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" });
    const createdBinding = makeBinding({
      id: "binding-created",
      secretId: "openai",
      targetType: "environment",
      targetId: "env-prod",
      configPath: "env.OPENAI_API_KEY",
      required: false,
      label: "Production env",
    });
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([secret]);
    vi.mocked(secretsApi.bindings.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdBinding])
      .mockResolvedValue([]);
    vi.mocked(secretsApi.bindings.create).mockResolvedValue(createdBinding);
    vi.mocked(secretsApi.bindings.remove).mockResolvedValue({ ok: true });

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("tab", { name: "Bindings" }));
    await user.click(await screen.findByRole("button", { name: "Add binding" }));
    await user.selectOptions(screen.getByLabelText("Target type"), "environment");
    await user.type(screen.getByLabelText("Target id"), "env-prod");
    await user.type(screen.getByLabelText("Config path"), "env.OPENAI_API_KEY");
    await user.type(screen.getByLabelText("Label"), "Production env");
    await user.click(screen.getByLabelText("Required binding"));
    await user.click(screen.getByRole("button", { name: "Create binding" }));

    expect(secretsApi.bindings.create).toHaveBeenCalledWith("openai", {
      targetType: "environment",
      targetId: "env-prod",
      configPath: "env.OPENAI_API_KEY",
      versionSelector: "latest",
      required: false,
      label: "Production env",
    });
    expect(await screen.findByText("env-prod")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove binding env-prod" }));

    expect(secretsApi.bindings.remove).toHaveBeenCalledWith("binding-created");
    await waitFor(() => expect(screen.queryByText("env-prod")).not.toBeInTheDocument());
  });

  it("invalidates the removed binding secret even if another secret is selected before removal finishes", async () => {
    const user = userEvent.setup();
    let resolveRemove: (value: { ok: true }) => void = () => {};
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const openai = makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" });
    const hubspot = makeSecret({ id: "hubspot", name: "HubSpot Private App", key: "HUBSPOT_TOKEN" });
    const openaiBinding = makeBinding({ id: "binding-openai", secretId: "openai", targetId: "agent-openai" });
    const hubspotBinding = makeBinding({ id: "binding-hubspot", secretId: "hubspot", targetId: "agent-hubspot" });
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([openai, hubspot]);
    vi.mocked(secretsApi.bindings.list).mockImplementation((secretId) =>
      Promise.resolve(secretId === "openai" ? [openaiBinding] : [hubspotBinding]),
    );
    vi.mocked(secretsApi.bindings.remove).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemove = resolve;
        }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SecretsWorkspace companyId="company-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("tab", { name: "Bindings" }));
    await user.click(await screen.findByRole("button", { name: "Remove binding agent-openai" }));
    await user.click(screen.getByRole("tab", { name: "Inventory" }));
    await user.click(await screen.findByRole("button", { name: /hubspot private app/i }));

    resolveRemove({ ok: true });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.secrets.bindings("openai") }),
    );
  });

  it("shows audit query failures instead of the no-events empty state", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([
      makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" }),
    ]);
    vi.mocked(secretsApi.accessEvents).mockRejectedValue(new Error("Audit unavailable"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("tab", { name: "Audit" }));

    expect(await screen.findByText("Failed to load audit events for this secret.")).toBeInTheDocument();
    expect(screen.getByText("Audit unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No access events")).toBeNull();
  });

  it("shows vault provider query failures on the vault providers tab", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockRejectedValue(new Error("Descriptors unavailable"));
    vi.mocked(secretsApi.providerConfigs.list).mockRejectedValue(new Error("Configs unavailable"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("tab", { name: "Vault providers" }));

    expect(await screen.findByText(/Failed to load provider descriptors/)).toBeInTheDocument();
    expect(screen.getByText("Descriptors unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Failed to load configured vaults/)).toBeInTheDocument();
    expect(screen.getByText("Configs unavailable")).toBeInTheDocument();
  });

  it("disables vault Check while pending and enables it again after resolution", async () => {
    const user = userEvent.setup();
    let resolveCheck: () => void = () => {};
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([
      {
        id: "aws-prod",
        companyId: "company-1",
        provider: "aws_secrets_manager",
        displayName: "Production AWS",
        status: "ready",
        isDefault: true,
        config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
        healthStatus: "ready",
        healthCheckedAt: null,
        healthMessage: null,
        healthDetails: null,
        disabledAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-05-14T00:00:00Z"),
        updatedAt: new Date("2026-05-14T00:00:00Z"),
      },
    ]);
    vi.mocked(secretsApi.providerConfigs.check).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = () => resolve({ status: "ready", message: "Connected" });
        }),
    );

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("tab", { name: "Vault providers" }));
    const checkButton = await screen.findByRole("button", { name: "Check" });
    await user.click(checkButton);

    expect(checkButton).toBeDisabled();

    resolveCheck();
    await waitFor(() => expect(checkButton).toBeEnabled());
  });

  it("creates a local managed secret from the header dialog and selects it after success", async () => {
    const user = userEvent.setup();
    const created = makeSecret({ id: "stripe", name: "Stripe API Key", key: "STRIPE_API_KEY" });
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.accessEvents).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValueOnce([]).mockResolvedValue([created]);
    vi.mocked(secretsApi.create).mockResolvedValue(created);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Add secret" }));
    const dialog = screen.getByRole("dialog", { name: "Add secret" });
    await user.type(within(dialog).getByLabelText("Name"), " Stripe API Key ");
    await user.type(within(dialog).getByLabelText("Key"), " STRIPE_API_KEY ");
    await user.type(within(dialog).getByLabelText("Secret value"), "sk-live");
    await user.click(within(dialog).getByRole("button", { name: "Add secret" }));

    expect(secretsApi.create).toHaveBeenCalledWith("company-1", {
      name: "Stripe API Key",
      key: "STRIPE_API_KEY",
      value: "sk-live",
      provider: "local_encrypted",
      providerConfigId: null,
      managedMode: "aoa_managed",
      description: null,
      externalRef: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add secret" })).not.toBeInTheDocument());
    expect((await screen.findAllByText("Stripe API Key")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Stripe API Key/i })).toHaveAttribute("aria-current", "true");
  });

  it("keeps add dialog open and shows create failures", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.accessEvents).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.create).mockRejectedValue(new Error("Create failed"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Add secret" }));
    const dialog = screen.getByRole("dialog", { name: "Add secret" });
    await user.type(within(dialog).getByLabelText("Name"), "Stripe API Key");
    await user.type(within(dialog).getByLabelText("Secret value"), "sk-live");
    await user.click(within(dialog).getByRole("button", { name: "Add secret" }));

    expect(await within(dialog).findByText("Create failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add secret" })).toBeInTheDocument();
  });

  it("rotates an AoA-managed inventory secret and closes the dialog after success", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY", latestVersion: 3 });
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([secret]);
    vi.mocked(secretsApi.bindings.list).mockResolvedValue([]);
    vi.mocked(secretsApi.accessEvents).mockResolvedValue([]);
    vi.mocked(secretsApi.rotate).mockResolvedValue(makeSecret({ ...secret, latestVersion: 4 }));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Rotate value" }));
    const dialog = screen.getByRole("dialog", { name: "Rotate secret" });
    await user.type(within(dialog).getByLabelText("New value"), "sk-new");
    await user.click(within(dialog).getByRole("button", { name: "Create v4" }));

    expect(secretsApi.rotate).toHaveBeenCalledWith("openai", { value: "sk-new" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rotate secret" })).not.toBeInTheDocument());
  });

  it("keeps rotate dialog open and shows rotate failures", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY", latestVersion: 3 });
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.list).mockResolvedValue([secret]);
    vi.mocked(secretsApi.bindings.list).mockResolvedValue([]);
    vi.mocked(secretsApi.accessEvents).mockResolvedValue([]);
    vi.mocked(secretsApi.rotate).mockRejectedValue(new Error("Rotate failed"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Rotate value" }));
    const dialog = screen.getByRole("dialog", { name: "Rotate secret" });
    await user.type(within(dialog).getByLabelText("New value"), "sk-new");
    await user.click(within(dialog).getByRole("button", { name: "Create v4" }));

    expect(await within(dialog).findByText("Rotate failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Rotate secret" })).toBeInTheDocument();
  });

  it("updates secret metadata from the drawer edit action", async () => {
    const user = userEvent.setup();
    const initial = makeSecret({ id: "openai", name: "OpenAI production key", key: "OPENAI_API_KEY" });
    const updated = makeSecret({ id: "openai", name: "OpenAI prod", key: "OPENAI_API_KEY" });
    vi.mocked(secretsApi.list).mockResolvedValue([initial]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.update).mockResolvedValue(updated);

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit metadata" }));
    const dialog = screen.getByRole("dialog", { name: "Edit secret" });
    await user.clear(within(dialog).getByLabelText(/^name$/i));
    await user.type(within(dialog).getByLabelText(/^name$/i), "OpenAI prod");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(secretsApi.update).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ name: "OpenAI prod" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit secret" })).not.toBeInTheDocument());
  });

  it("disables an active secret from the drawer", async () => {
    const user = userEvent.setup();
    let resolveUpdate: (secret: CompanySecret) => void = () => {};
    vi.mocked(secretsApi.list)
      .mockResolvedValueOnce([makeSecret({ id: "openai", status: "active" })])
      .mockResolvedValue([makeSecret({ id: "openai", status: "disabled" })]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.update).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Disable" }));

    expect(secretsApi.update).toHaveBeenCalledWith("openai", { status: "disabled" });
    expect(await screen.findByText("Disabling secret...")).toBeInTheDocument();

    resolveUpdate(makeSecret({ id: "openai", status: "disabled" }));

    await waitFor(() => expect(screen.queryByText("Disabling secret...")).not.toBeInTheDocument());
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });

  it("enables a disabled secret from the preview", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list)
      .mockResolvedValueOnce([makeSecret({ id: "openai", status: "disabled" })])
      .mockResolvedValue([makeSecret({ id: "openai", status: "active" })]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.update).mockResolvedValue(makeSecret({ id: "openai", status: "active" }));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));

    expect(secretsApi.update).toHaveBeenCalledWith("openai", { status: "active" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument());
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
  });

  it("requires typing the secret key before deleting a secret", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list)
      .mockResolvedValueOnce([makeSecret({ id: "openai", key: "OPENAI_API_KEY" })])
      .mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.remove).mockResolvedValue({ ok: true });

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete secret" });
    const deleteButton = within(dialog).getByRole("button", { name: "Delete secret" });

    expect(deleteButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Type OPENAI_API_KEY to confirm"), "OPENAI_API_KEY");
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);

    expect(secretsApi.remove).toHaveBeenCalledWith("openai");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete secret" })).not.toBeInTheDocument());
    expect(await screen.findByText("No secrets yet")).toBeInTheDocument();
  });

  it("keeps edit dialog open and shows update failures", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.list).mockResolvedValue([makeSecret({ id: "openai" })]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);
    vi.mocked(secretsApi.update).mockRejectedValue(new Error("Update failed"));

    renderWithProviders(<SecretsWorkspace companyId="company-1" />);

    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit metadata" }));
    const dialog = screen.getByRole("dialog", { name: "Edit secret" });
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("Update failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit secret" })).toBeInTheDocument();
  });
});

describe("secret-ui helpers", () => {
  it("formats provider and mode labels", () => {
    expect(providerLabel("aws_secrets_manager")).toBe("AWS Secrets Manager");
    expect(providerLabel("gcp_secret_manager")).toBe("GCP Secret Manager");
    expect(providerLabel("vault")).toBe("HashiCorp Vault");
    expect(providerLabel("local_encrypted")).toBe("Local encrypted");

    expect(modeLabel("aoa_managed")).toBe("AoA managed");
    expect(modeLabel("external_reference")).toBe("External reference");
  });

  it("summarizes provider config and sensitive keys", () => {
    expect(
      providerConfigSummary({
        id: "provider-config-1",
        companyId: "company-1",
        provider: "aws_secrets_manager",
        displayName: "Production AWS",
        status: "ready",
        isDefault: true,
        config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
        healthStatus: null,
        healthCheckedAt: null,
        healthMessage: null,
        healthDetails: null,
        disabledAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-05-01T12:00:00Z"),
        updatedAt: new Date("2026-05-01T12:00:00Z"),
      }),
    ).toBe("us-east-1 / aoa/prod");

    expect(formatSecretDate(null)).toBe("Never");
    expect(looksSensitiveKey("OPENAI_API_KEY")).toBe(true);
    expect(looksSensitiveKey("PUBLIC_BASE_URL")).toBe(false);
  });
});
