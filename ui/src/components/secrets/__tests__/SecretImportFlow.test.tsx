import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompanySecretProviderConfig } from "@armyofagents/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/__tests__/test-utils";
import { secretsApi } from "@/api/secrets";
import { ImportFromVaultDialog } from "@/pages/secrets/ImportFromVaultDialog";
import { SecretRunPreviewCard } from "../SecretRunPreviewCard";

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    remoteImport: {
      preview: vi.fn(),
      commit: vi.fn(),
    },
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

const providerConfig: CompanySecretProviderConfig = {
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
};

const secondaryProviderConfig: CompanySecretProviderConfig = {
  ...providerConfig,
  id: "aws-2",
  displayName: "Staging AWS",
  config: { region: "us-west-2", secretNamePrefix: "aoa/staging" },
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("ImportFromVaultDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  it("previews remote AWS secrets as external references before import", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.remoteImport.preview).mockResolvedValue({
      providerConfigId: providerConfig.id,
      nextToken: null,
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
          name: "aoa/prod/openai",
          key: "OPENAI_API_KEY",
          providerVersionRef: "v1",
          description: "OpenAI",
          status: "ready",
          reason: null,
          metadata: null,
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/stripe",
          name: "aoa/prod/stripe",
          key: "STRIPE_API_KEY",
          providerVersionRef: "v3",
          description: "Stripe",
          status: "conflict",
          reason: "Key already exists with a different remote reference",
          metadata: null,
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/legacy",
          name: "aoa/prod/legacy",
          key: "LEGACY_TOKEN",
          providerVersionRef: null,
          description: null,
          status: "duplicate",
          reason: "Already imported",
          metadata: null,
        },
      ],
    });
    vi.mocked(secretsApi.remoteImport.commit).mockResolvedValue({
      providerConfigId: providerConfig.id,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
          name: "aoa/prod/openai",
          status: "imported",
          secretId: "secret-1",
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/stripe",
          name: "aoa/prod/stripe",
          status: "skipped",
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/error",
          name: "aoa/prod/error",
          status: "error",
          error: "AWS read failed",
        },
      ],
    });

    renderWithProviders(
      <ImportFromVaultDialog
        companyId="company-1"
        open
        onOpenChange={() => {}}
        providerConfigs={[providerConfig]}
      />,
    );

    expect(
      screen.getByText(
        "Imports create external references by default. AoA stores the remote reference, not the secret value.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Preview remote secrets" }));

    expect(await screen.findByText("aoa/prod/openai")).toBeInTheDocument();
    expect(screen.getByText("aoa/prod/stripe")).toBeInTheDocument();
    expect(screen.getByText("aoa/prod/legacy")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("conflict")).toBeInTheDocument();
    expect(screen.getByText("duplicate")).toBeInTheDocument();
    expect(screen.getAllByText(/external reference/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("sk-live-secret-value")).not.toBeInTheDocument();

    const readyRow = screen.getByText("aoa/prod/openai").closest("tr");
    const conflictRow = screen.getByText("aoa/prod/stripe").closest("tr");
    const duplicateRow = screen.getByText("aoa/prod/legacy").closest("tr");
    expect(readyRow).toBeTruthy();
    expect(conflictRow).toBeTruthy();
    expect(duplicateRow).toBeTruthy();

    await user.click(within(readyRow!).getByRole("checkbox"));
    await user.click(within(conflictRow!).getByRole("checkbox"));
    expect(within(duplicateRow!).getByRole("checkbox")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^import$/i }));

    await waitFor(() => {
      expect(secretsApi.remoteImport.commit).toHaveBeenCalledWith("company-1", {
        providerConfigId: providerConfig.id,
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
            name: "aoa/prod/openai",
            key: "OPENAI_API_KEY",
            providerVersionRef: "v1",
            description: "OpenAI",
          },
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/stripe",
            name: "aoa/prod/stripe",
            key: "STRIPE_API_KEY",
            providerVersionRef: "v3",
            description: "Stripe",
          },
        ],
      });
    });
    expect(await screen.findByText("1 imported")).toBeInTheDocument();
    expect(screen.getByText("1 skipped")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("clears stale preview selections when provider changes", async () => {
    const user = userEvent.setup();
    vi.mocked(secretsApi.remoteImport.preview).mockResolvedValue({
      providerConfigId: providerConfig.id,
      nextToken: null,
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
          name: "aoa/prod/openai",
          key: "OPENAI_API_KEY",
          providerVersionRef: "v1",
          description: "OpenAI",
          status: "ready",
          reason: null,
          metadata: null,
        },
      ],
    });

    renderWithProviders(
      <ImportFromVaultDialog
        companyId="company-1"
        open
        onOpenChange={() => {}}
        providerConfigs={[providerConfig, secondaryProviderConfig]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview remote secrets" }));
    const previewedRow = await screen.findByText("aoa/prod/openai");
    await user.click(within(previewedRow.closest("tr")!).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /^import$/i })).toBeEnabled();

    await user.click(screen.getByRole("combobox", { name: "Provider vault" }));
    await user.click(await screen.findByText("Staging AWS"));

    expect(screen.queryByText("aoa/prod/openai")).not.toBeInTheDocument();
    expect(screen.getByText("No preview loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^import$/i }));
    expect(secretsApi.remoteImport.commit).not.toHaveBeenCalled();
  });

  it("ignores an in-flight preview response after provider changes", async () => {
    const user = userEvent.setup();
    const providerAPreview = createDeferred<Awaited<ReturnType<typeof secretsApi.remoteImport.preview>>>();
    vi.mocked(secretsApi.remoteImport.preview).mockReturnValue(providerAPreview.promise);

    renderWithProviders(
      <ImportFromVaultDialog
        companyId="company-1"
        open
        onOpenChange={() => {}}
        providerConfigs={[providerConfig, secondaryProviderConfig]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview remote secrets" }));
    expect(secretsApi.remoteImport.preview).toHaveBeenCalledWith("company-1", {
      providerConfigId: providerConfig.id,
      query: null,
      nextToken: null,
      pageSize: 25,
    });

    await user.click(screen.getByRole("combobox", { name: "Provider vault" }));
    await user.click(await screen.findByText("Staging AWS"));

    providerAPreview.resolve({
      providerConfigId: providerConfig.id,
      nextToken: null,
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/stale",
          name: "aoa/prod/stale",
          key: "STALE_API_KEY",
          providerVersionRef: "v1",
          description: "Stale",
          status: "ready",
          reason: null,
          metadata: null,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText("aoa/prod/stale")).not.toBeInTheDocument();
    });
    expect(screen.getByText("No preview loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^import$/i }));
    expect(secretsApi.remoteImport.commit).not.toHaveBeenCalled();
  });
});

describe("SecretRunPreviewCard", () => {
  it("shows resolved preview readiness without revealing raw secret values", () => {
    renderWithProviders(
      <SecretRunPreviewCard
        items={[
          {
            key: "OPENAI_API_KEY",
            source: "secret",
            safeDisplayValue: "Secret: OpenAI API Key",
            status: "ok",
            required: true,
          },
          {
            key: "HUBSPOT_TOKEN",
            source: "secret",
            safeDisplayValue: "Missing secret",
            status: "missing",
            required: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Resolved preview")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("Secret: OpenAI API Key")).toBeInTheDocument();
    expect(screen.queryByText("sk-live-secret-value")).not.toBeInTheDocument();
  });
});
