import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompanySecret } from "@armyofagents/shared";
import { describe, expect, it, vi } from "vitest";
import { SecretInventoryTab } from "@/components/secrets/SecretInventoryTab";

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

describe("SecretInventoryTab", () => {
  it("renders polished cards with disciplined metadata hierarchy", () => {
    const secrets = [
      makeSecret({
        id: "openai",
        name: "OpenAI production key",
        key: "OPENAI_API_KEY",
        description: "Used by Engineering and QA agents.",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        latestVersion: 4,
        lastResolvedAt: new Date("2026-05-14T10:00:00Z"),
      }),
    ];

    render(<SecretInventoryTab secrets={secrets} selectedSecret={secrets[0]} onSelectSecret={vi.fn()} />);

    expect(screen.getByTestId("secret-card-openai")).toBeInTheDocument();
    expect(screen.getByTestId("secret-card-openai")).toHaveClass("rounded-lg");
    expect(screen.getByRole("button", { name: /openai production key/i })).toBeInTheDocument();
    expect(screen.getAllByText("OPENAI_API_KEY").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Local encrypted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AoA managed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("v4").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last read/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Used by Engineering and QA agents.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Stored for controlled agent access/i)).not.toBeInTheDocument();
    expect(screen.queryByText("No description yet")).not.toBeInTheDocument();
    expect(screen.queryByText("AoA managed", { selector: "[data-slot='badge'], .badge" })).not.toBeInTheDocument();
  });

  it("opens and closes the preview drawer from inventory cards", async () => {
    const user = userEvent.setup();
    const secrets = [
      makeSecret({ id: "openai", name: "OpenAI production key", key: "OPENAI_API_KEY" }),
      makeSecret({ id: "github", name: "GitHub PAT", key: "GITHUB_TOKEN" }),
    ];
    const onSelect = vi.fn();

    const { rerender } = render(
      <SecretInventoryTab secrets={secrets} selectedSecret={secrets[0]} onSelectSecret={onSelect} />,
    );

    expect(screen.getByRole("complementary", { name: /secret preview/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close preview/i }));
    expect(screen.queryByRole("complementary", { name: /secret preview/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /github pat/i }));
    expect(onSelect).toHaveBeenCalledWith("github");
    rerender(<SecretInventoryTab secrets={secrets} selectedSecret={secrets[1]} onSelectSecret={onSelect} />);
    expect(screen.getByRole("complementary", { name: /secret preview/i })).toBeInTheDocument();
    expect(screen.getAllByText("GitHub PAT").length).toBeGreaterThan(0);
  });

  it("opens the preview drawer when the selected secret arrives after loading", async () => {
    const secrets = [makeSecret({ id: "openai", name: "OpenAI production key", key: "OPENAI_API_KEY" })];
    const { rerender } = render(
      <SecretInventoryTab secrets={[]} selectedSecret={null} onSelectSecret={vi.fn()} />,
    );

    expect(screen.queryByRole("complementary", { name: /secret preview/i })).not.toBeInTheDocument();

    rerender(<SecretInventoryTab secrets={secrets} selectedSecret={secrets[0]} onSelectSecret={vi.fn()} />);

    expect(await screen.findByRole("complementary", { name: /secret preview/i })).toBeInTheDocument();
  });

  it("groups preview actions into primary utilities and an admin menu", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onRotate = vi.fn();
    const onDisable = vi.fn();
    const onDelete = vi.fn();
    const secrets = [makeSecret({ id: "openai", managedMode: "aoa_managed" })];

    render(
      <SecretInventoryTab
        secrets={secrets}
        selectedSecret={secrets[0]}
        onSelectSecret={vi.fn()}
        onEdit={onEdit}
        onRotate={onRotate}
        onDisable={onDisable}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByRole("button", { name: /rotate value/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy ref/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit metadata/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^disable$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /edit metadata/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^disable$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("filters secrets and selects one for detail", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const secrets = [
      makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" }),
      makeSecret({
        id: "hubspot",
        name: "HubSpot Private App",
        key: "HUBSPOT_TOKEN",
        provider: "aws_secrets_manager",
      }),
    ];

    render(<SecretInventoryTab secrets={secrets} selectedSecret={secrets[0]} onSelectSecret={onSelect} />);

    expect(screen.getAllByText("OpenAI API Key").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HubSpot Private App").length).toBeGreaterThan(0);

    await user.type(screen.getByPlaceholderText("Search by name, key, department"), "hub");
    expect(screen.queryByText("OpenAI API Key")).not.toBeInTheDocument();
    expect(screen.getAllByText("HubSpot Private App").length).toBeGreaterThan(0);

    await user.click(screen.getByText("HubSpot Private App"));
    expect(onSelect).toHaveBeenCalledWith("hubspot");
  });

  it("only shows rotate for AoA-managed secrets when callback is provided", async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn();
    const secret = makeSecret({ id: "hubspot", name: "HubSpot Private App", key: "HUBSPOT_TOKEN" });

    const { rerender } = render(
      <SecretInventoryTab secrets={[secret]} selectedSecret={secret} onSelectSecret={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: "Rotate value" })).not.toBeInTheDocument();

    rerender(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onRotate={onRotate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rotate value" }));

    expect(onRotate).toHaveBeenCalledWith(secret);
  });

  it("hides rotate for external reference secrets even when callback is provided", () => {
    const onRotate = vi.fn();
    const secret = makeSecret({
      id: "stripe",
      name: "Stripe webhook",
      key: "STRIPE_WEBHOOK_SECRET",
      managedMode: "external_reference",
      provider: "aws_secrets_manager",
      externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:stripe",
    });

    render(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onRotate={onRotate}
      />,
    );

    expect(screen.queryByRole("button", { name: "Rotate value" })).not.toBeInTheDocument();
  });

  it("hides rotate and disable for disabled secrets", () => {
    const secret = makeSecret({ id: "openai", status: "disabled", managedMode: "aoa_managed" });

    render(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onRotate={vi.fn()}
        onDisable={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Rotate value" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
  });

  it("shows enable for disabled secrets when callback is provided", async () => {
    const user = userEvent.setup();
    const onEnable = vi.fn();
    const secret = makeSecret({ id: "openai", status: "disabled", managedMode: "aoa_managed" });

    render(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onEnable={onEnable}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable" }));

    expect(onEnable).toHaveBeenCalledWith(secret);
  });

  it("shows clipboard failure feedback when copying the reference fails", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", key: "OPENAI_API_KEY" });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied"));

    render(<SecretInventoryTab secrets={[secret]} selectedSecret={secret} onSelectSecret={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy ref" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed");
  });

  it("shows delete and read-only version retention information", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const secret = makeSecret({ id: "openai", latestVersion: 3, managedMode: "aoa_managed" });

    render(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText("Version history")).toBeInTheDocument();
    expect(screen.getByText(/Previous versions are retained for audit and recovery context/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith(secret);
  });

  it("shows pending state while disabling a secret", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", status: "active", managedMode: "aoa_managed" });

    render(
      <SecretInventoryTab
        secrets={[secret]}
        selectedSecret={secret}
        onSelectSecret={vi.fn()}
        onDisable={vi.fn()}
        disablingSecretId="openai"
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Disabling..." })).toHaveAttribute("aria-disabled", "true");
  });

  it("marks the selected card and shows an empty filtered state", async () => {
    const user = userEvent.setup();
    const secret = makeSecret({ id: "openai", name: "OpenAI API Key", key: "OPENAI_API_KEY" });

    render(<SecretInventoryTab secrets={[secret]} selectedSecret={secret} onSelectSecret={vi.fn()} />);

    expect(screen.getByRole("button", { name: /OpenAI API Key/i })).toHaveAttribute("aria-current", "true");

    await user.type(screen.getByPlaceholderText("Search by name, key, department"), "stripe");
    expect(screen.getByText("No secrets match your search")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI API Key")).not.toBeInTheDocument();
  });
});
