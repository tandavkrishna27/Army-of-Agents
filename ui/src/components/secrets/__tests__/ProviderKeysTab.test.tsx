import { render, screen, waitFor, within } from "@testing-library/react";
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
        onCreateWithSecret={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("Default E2B")).toBeInTheDocument();
    expect(screen.getByText("E2B Sandbox - E2B API Key")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-");
  });

  it("adds an E2B key in one step with a masked key input", async () => {
    const user = userEvent.setup();
    const onCreateWithSecret = vi.fn(async () => undefined);
    const onCreate = vi.fn(async () => undefined);

    render(
      <ProviderKeysTab
        providerKeys={[]}
        secrets={[]}
        onCreate={onCreate}
        onCreateWithSecret={onCreateWithSecret}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add e2b key/i }));
    const dialog = screen.getByRole("dialog", { name: "Add E2B key" });
    await user.clear(within(dialog).getByLabelText(/name/i));
    await user.type(within(dialog).getByLabelText(/name/i), "Prod E2B");
    const keyInput = within(dialog).getByLabelText(/api key/i);
    // The key field must be masked and never rendered as plain text.
    expect(keyInput).toHaveAttribute("type", "password");
    await user.type(keyInput, "e2b_live_topsecret");
    await user.click(within(dialog).getByRole("button", { name: "Add E2B key" }));

    expect(onCreateWithSecret).toHaveBeenCalledWith({
      provider: "e2b",
      displayName: "Prod E2B",
      value: "e2b_live_topsecret",
      isDefault: true,
    });
    expect(onCreate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add E2B key" })).not.toBeInTheDocument();
    });
    // The pasted value is not left rendered anywhere after submit.
    expect(document.body.textContent).not.toContain("e2b_live_topsecret");
  });

  it("still supports backing a key with an existing secret", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);

    render(
      <ProviderKeysTab
        providerKeys={[]}
        secrets={[makeSecret()]}
        onCreate={onCreate}
        onCreateWithSecret={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /use existing secret/i }));
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
