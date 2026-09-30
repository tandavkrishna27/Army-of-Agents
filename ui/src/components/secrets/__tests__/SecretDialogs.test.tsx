import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompanySecret, CompanySecretProviderConfig } from "@armyofagents/shared";
import { describe, expect, it, vi } from "vitest";
import { AddSecretDialog } from "@/components/secrets/AddSecretDialog";
import { EditSecretDialog } from "@/components/secrets/EditSecretDialog";
import { RotateSecretDialog } from "@/components/secrets/RotateSecretDialog";

function makeSecret(partial: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: partial.id ?? "secret-1",
    companyId: "company-1",
    name: partial.name ?? "OpenAI API Key",
    key: partial.key ?? "OPENAI_API_KEY",
    status: partial.status ?? "active",
    managedMode: partial.managedMode ?? "aoa_managed",
    provider: partial.provider ?? "local_encrypted",
    providerConfigId: partial.providerConfigId ?? null,
    providerMetadata: partial.providerMetadata ?? null,
    externalRef: partial.externalRef ?? null,
    latestVersion: partial.latestVersion ?? 3,
    description: partial.description ?? "Used by QA",
    lastResolvedAt: partial.lastResolvedAt ?? null,
    lastRotatedAt: partial.lastRotatedAt ?? null,
    deletedAt: partial.deletedAt ?? null,
    createdByAgentId: partial.createdByAgentId ?? null,
    createdByUserId: partial.createdByUserId ?? null,
    createdAt: partial.createdAt ?? new Date("2026-05-14T00:00:00Z"),
    updatedAt: partial.updatedAt ?? new Date("2026-05-14T00:00:00Z"),
  };
}

function makeProviderConfig(partial: Partial<CompanySecretProviderConfig> = {}): CompanySecretProviderConfig {
  return {
    id: partial.id ?? "aws-config-1",
    companyId: partial.companyId ?? "company-1",
    provider: partial.provider ?? "aws_secrets_manager",
    displayName: partial.displayName ?? "Production AWS",
    status: partial.status ?? "ready",
    isDefault: partial.isDefault ?? true,
    config: partial.config ?? { region: "us-east-1", secretNamePrefix: "aoa/prod" },
    healthStatus: partial.healthStatus ?? null,
    healthCheckedAt: partial.healthCheckedAt ?? null,
    healthMessage: partial.healthMessage ?? null,
    healthDetails: partial.healthDetails ?? null,
    disabledAt: partial.disabledAt ?? null,
    createdByAgentId: partial.createdByAgentId ?? null,
    createdByUserId: partial.createdByUserId ?? null,
    createdAt: partial.createdAt ?? new Date("2026-05-14T00:00:00Z"),
    updatedAt: partial.updatedAt ?? new Date("2026-05-14T00:00:00Z"),
  };
}

describe("AddSecretDialog", () => {
  it("submits a local managed secret payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<AddSecretDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Name"), " OpenAI API Key ");
    await user.type(screen.getByLabelText("Key"), " OPENAI_API_KEY ");
    await user.type(screen.getByLabelText("Secret value"), "sk-live");
    await user.type(screen.getByLabelText("Description"), " Used by QA ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add secret" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "OpenAI API Key",
      key: "OPENAI_API_KEY",
      value: "sk-live",
      provider: "local_encrypted",
      providerConfigId: null,
      managedMode: "aoa_managed",
      description: "Used by QA",
      externalRef: null,
    });
  });

  it("warns when key looks sensitive", async () => {
    const user = userEvent.setup();

    render(<AddSecretDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText("Key"), "OPENAI_API_KEY");

    expect(screen.getByText(/this key name looks sensitive/i)).toBeInTheDocument();
  });

  it("does not require value in external reference mode and submits the external ref", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <AddSecretDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        providerConfigs={[makeProviderConfig({ id: "aws-config-1" })]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /external reference/i }));
    await user.type(screen.getByLabelText("Name"), " Stripe webhook ");
    await user.type(screen.getByLabelText("Key"), "STRIPE_WEBHOOK_SECRET");
    await user.type(
      screen.getByLabelText("External reference", { selector: "input" }),
      "arn:aws:secretsmanager:us-east-1:1:secret:stripe",
    );

    const value = screen.getByLabelText("Secret value");
    expect(value).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add secret" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Stripe webhook",
      key: "STRIPE_WEBHOOK_SECRET",
      value: null,
      provider: "aws_secrets_manager",
      providerConfigId: "aws-config-1",
      managedMode: "external_reference",
      description: null,
      externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:stripe",
    });
  });

  it("disables external reference submit until an external vault provider is configured", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<AddSecretDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("radio", { name: /external reference/i }));
    await user.type(screen.getByLabelText("Name"), "Stripe webhook");
    await user.type(
      screen.getByLabelText("External reference", { selector: "input" }),
      "arn:aws:secretsmanager:us-east-1:1:secret:stripe",
    );

    expect(screen.getByText("Configure an external vault provider before adding external references.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows create errors without clearing the dialog", async () => {
    render(
      <AddSecretDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        errorMessage="Create failed"
      />,
    );

    expect(screen.getByText("Create failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add secret" })).toBeInTheDocument();
  });
});

describe("EditSecretDialog", () => {
  it("submits trimmed metadata updates without exposing a value field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<EditSecretDialog open onOpenChange={vi.fn()} secret={makeSecret()} onSubmit={onSubmit} />);

    expect(screen.getByRole("dialog", { name: "Edit secret" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/secret value/i)).not.toBeInTheDocument();
    expect(screen.getByText(/use rotate value/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Managed mode")).toBeDisabled();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), " OpenAI prod ");
    await user.clear(screen.getByLabelText("Key"));
    await user.type(screen.getByLabelText("Key"), " OPENAI_PROD_KEY ");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), " Updated description ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "OpenAI prod",
      key: "OPENAI_PROD_KEY",
      description: "Updated description",
    });
  });

  it("edits external refs only for external-reference secrets and converts blank optionals to null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <EditSecretDialog
        open
        onOpenChange={vi.fn()}
        secret={makeSecret({
          key: "AWS_REMOTE_SECRET",
          managedMode: "external_reference",
          provider: "aws_secrets_manager",
          externalRef: "arn:old",
          description: "Existing description",
        })}
        onSubmit={onSubmit}
      />,
    );

    await user.clear(screen.getByLabelText("Key"));
    await user.clear(screen.getByLabelText("Description"));
    await user.clear(screen.getByLabelText("External reference"));
    await user.type(screen.getByLabelText("External reference"), " arn:new ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "OpenAI API Key",
      key: null,
      description: null,
      externalRef: "arn:new",
    });
  });

  it("shows edit errors without clearing the dialog", () => {
    render(
      <EditSecretDialog
        open
        onOpenChange={vi.fn()}
        secret={makeSecret()}
        onSubmit={vi.fn()}
        errorMessage="Edit failed"
      />,
    );

    expect(screen.getByText("Edit failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit secret" })).toBeInTheDocument();
  });
});

describe("RotateSecretDialog", () => {
  it("shows version impact and submits a new value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <RotateSecretDialog
        open
        onOpenChange={vi.fn()}
        secret={makeSecret({ latestVersion: 3 })}
        impactedBindingCount={5}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Rotate secret" })).toBeInTheDocument();
    expect(screen.getByText("v3 latest")).toBeInTheDocument();
    expect(screen.getByText(/5 bindings/i)).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Create v4" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("New value"), "sk-new");
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({ value: "sk-new" });
  });

  it("shows rotate errors without clearing the dialog", () => {
    render(
      <RotateSecretDialog
        open
        onOpenChange={vi.fn()}
        secret={makeSecret({ latestVersion: 3 })}
        impactedBindingCount={0}
        onSubmit={vi.fn()}
        errorMessage="Rotate failed"
      />,
    );

    expect(screen.getByText("Rotate failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Rotate secret" })).toBeInTheDocument();
  });
});
