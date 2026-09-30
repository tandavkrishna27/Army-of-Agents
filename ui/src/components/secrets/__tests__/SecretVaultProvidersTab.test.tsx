import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CompanySecretProviderConfig } from "@armyofagents/shared";
import { useState } from "react";
import { SecretVaultProvidersTab } from "../SecretVaultProvidersTab";

function makeProviderConfig(partial: Partial<CompanySecretProviderConfig> = {}): CompanySecretProviderConfig {
  return {
    id: partial.id ?? "aws-1",
    companyId: "company-1",
    provider: partial.provider ?? "aws_secrets_manager",
    displayName: partial.displayName ?? "Production AWS",
    status: partial.status ?? "ready",
    isDefault: partial.isDefault ?? true,
    config: partial.config ?? { region: "us-east-1", secretNamePrefix: "aoa/prod" },
    healthStatus: partial.healthStatus ?? null,
    healthCheckedAt: partial.healthCheckedAt ?? null,
    healthMessage: partial.healthMessage ?? null,
    healthDetails: null,
    disabledAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-05-14T00:00:00Z"),
    updatedAt: new Date("2026-05-14T00:00:00Z"),
  };
}

describe("SecretVaultProvidersTab", () => {
  it("shows local encrypted as default and opens AWS configure", async () => {
    render(<SecretVaultProvidersTab providerConfigs={[]} onCreateAwsVault={vi.fn()} onCheckVault={vi.fn()} />);

    expect(screen.getByText("Local encrypted")).toBeInTheDocument();
    expect(screen.getByText(/default vault/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /configure aws vault/i }));

    expect(screen.getByRole("dialog", { name: /aws secrets manager/i })).toBeInTheDocument();
  });

  it("submits the AWS vault payload", async () => {
    const onCreateAwsVault = vi.fn().mockResolvedValue(undefined);
    render(
      <SecretVaultProvidersTab
        providerConfigs={[]}
        onCreateAwsVault={onCreateAwsVault}
        onCheckVault={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure aws vault/i }));
    const dialog = screen.getByRole("dialog", { name: /aws secrets manager/i });

    await userEvent.clear(within(dialog).getByLabelText(/display name/i));
    await userEvent.type(within(dialog).getByLabelText(/display name/i), "Platform AWS");
    await userEvent.clear(within(dialog).getByLabelText(/region/i));
    await userEvent.type(within(dialog).getByLabelText(/region/i), "eu-west-1");
    await userEvent.clear(within(dialog).getByLabelText(/secret name prefix/i));
    await userEvent.type(within(dialog).getByLabelText(/secret name prefix/i), "aoa/stage");
    await userEvent.type(within(dialog).getByLabelText(/kms key id/i), "kms-123");
    await userEvent.type(within(dialog).getByLabelText(/owner tag/i), "ops");
    await userEvent.type(within(dialog).getByLabelText(/environment tag/i), "stage");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /default vault/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /save aws vault/i }));

    expect(onCreateAwsVault).toHaveBeenCalledWith({
      provider: "aws_secrets_manager",
      displayName: "Platform AWS",
      isDefault: false,
      config: {
        region: "eu-west-1",
        secretNamePrefix: "aoa/stage",
        kmsKeyId: "kms-123",
        ownerTag: "ops",
        environmentTag: "stage",
      },
    });
  });

  it("renders existing provider configs with status and invokes Check", async () => {
    const onCheckVault = vi.fn().mockResolvedValue(undefined);
    render(
      <SecretVaultProvidersTab
        providerConfigs={[
          makeProviderConfig({
            id: "aws-prod",
            displayName: "Production AWS",
            healthStatus: "ready",
            healthMessage: "Connected",
          }),
        ]}
        onCreateAwsVault={vi.fn()}
        onCheckVault={onCheckVault}
      />,
    );

    expect(screen.getByText("Production AWS")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText(/Connected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(onCheckVault).toHaveBeenCalledWith("aws-prod");
  });

  it("disables Check while pending and enables it again after resolution", async () => {
    let resolveCheck: () => void = () => {};
    const onCheckVault = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    function Harness() {
      const [checkingVaultId, setCheckingVaultId] = useState<string | null>(null);
      return (
        <SecretVaultProvidersTab
          providerConfigs={[makeProviderConfig({ id: "aws-prod", displayName: "Production AWS" })]}
          onCreateAwsVault={vi.fn()}
          onCheckVault={async (id) => {
            setCheckingVaultId(id);
            try {
              await onCheckVault(id);
            } finally {
              setCheckingVaultId(null);
            }
          }}
          checkingVaultId={checkingVaultId}
        />
      );
    }

    render(<Harness />);

    const checkButton = screen.getByRole("button", { name: "Check" });
    await userEvent.click(checkButton);

    expect(checkButton).toBeDisabled();

    resolveCheck();
    await screen.findByRole("button", { name: "Check" });

    expect(checkButton).toBeEnabled();
  });

  it("styles error health as a failure state", () => {
    render(
      <SecretVaultProvidersTab
        providerConfigs={[makeProviderConfig({ healthStatus: "error" })]}
        onCreateAwsVault={vi.fn()}
        onCheckVault={vi.fn()}
      />,
    );

    expect(screen.getByText("error")).toHaveClass("text-destructive");
  });

  it("shows provider query errors instead of silently degrading", () => {
    render(
      <SecretVaultProvidersTab
        providerConfigs={[]}
        onCreateAwsVault={vi.fn()}
        onCheckVault={vi.fn()}
        providersErrorMessage="Provider descriptors failed"
        providerConfigsErrorMessage="Provider configs failed"
      />,
    );

    expect(screen.getByText("Provider descriptors failed")).toBeInTheDocument();
    expect(screen.getByText("Provider configs failed")).toBeInTheDocument();
  });
});
