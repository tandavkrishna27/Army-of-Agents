import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CompanySecret, RuntimeProviderKey } from "@armyofagents/shared";
import { describe, expect, it, vi } from "vitest";
import { ProviderKeysTab } from "../ProviderKeysTab";

function makeSecret(): CompanySecret {
  return {
    id: "secret-e2b",
    companyId: "company-1",
    name: "E2B API Key",
    key: "E2B_API_KEY",
    status: "active",
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
  };
}

function makeProviderKey(): RuntimeProviderKey {
  return {
    id: "key-1",
    companyId: "company-1",
    provider: "e2b",
    displayName: "Default E2B",
    secretId: "secret-e2b",
    status: "active",
    isDefault: true,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("ProviderKeysTab", () => {
  it("renders E2B provider keys without secret material", () => {
    render(
      <ProviderKeysTab
        providerKeys={[makeProviderKey()]}
        secrets={[makeSecret()]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("Default E2B")).toBeInTheDocument();
    expect(screen.getByText("E2B Sandbox - E2B API Key")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-");
  });

  it("creates an E2B provider key backed by an existing secret", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);

    render(
      <ProviderKeysTab
        providerKeys={[]}
        secrets={[makeSecret()]}
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add key/i }));
    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), "Team E2B");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onCreate).toHaveBeenCalledWith({
      provider: "e2b",
      displayName: "Team E2B",
      secretId: "secret-e2b",
      isDefault: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New Sandbox Provider Key" })).not.toBeInTheDocument();
    });
  });
});
