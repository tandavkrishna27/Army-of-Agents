import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretBindingPicker } from "./SecretBindingPicker";
import { renderWithProviders } from "@/__tests__/test-utils";
import { secretsApi } from "@/api/secrets";

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    list: vi.fn(),
  },
}));

describe("SecretBindingPicker", () => {
  it("lists active secrets and selects latest", async () => {
    vi.mocked(secretsApi.list).mockResolvedValue([
      {
        id: "11111111-1111-1111-1111-111111111111",
        companyId: "company-1",
        name: "OpenAI API key",
        key: "OPENAI_API_KEY",
        status: "active",
        managedMode: "aoa_managed",
        provider: "local_encrypted",
        providerConfigId: null,
        providerMetadata: null,
        externalRef: null,
        latestVersion: 2,
        description: null,
        lastResolvedAt: null,
        lastRotatedAt: null,
        deletedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const onChange = vi.fn();

    renderWithProviders(
      <SecretBindingPicker
        companyId="company-1"
        value={null}
        onChange={onChange}
        configPath="env.OPENAI_API_KEY"
        targetType="agent"
        targetId="agent-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /bind secret/i }));
    fireEvent.click(await screen.findByText("OPENAI_API_KEY"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
        version: "latest",
      });
    });
  });
});
