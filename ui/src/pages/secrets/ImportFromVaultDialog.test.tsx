import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportFromVaultDialog } from "./ImportFromVaultDialog";
import { renderWithProviders } from "@/__tests__/test-utils";
import { secretsApi } from "@/api/secrets";

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

const providerConfig = {
  id: "22222222-2222-2222-2222-222222222222",
  companyId: "company-1",
  provider: "aws_secrets_manager" as const,
  displayName: "Production AWS",
  status: "ready" as const,
  isDefault: true,
  config: { region: "us-east-1" },
  healthStatus: null,
  healthCheckedAt: null,
  healthMessage: null,
  healthDetails: null,
  disabledAt: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ImportFromVaultDialog", () => {
  it("previews and imports selected ready or conflict candidates", async () => {
    vi.mocked(secretsApi.remoteImport.preview).mockResolvedValue({
      providerConfigId: providerConfig.id,
      nextToken: "next",
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
          name: "OPENAI_API_KEY",
          key: "OPENAI_API_KEY",
          providerVersionRef: "v1",
          description: null,
          status: "ready",
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/conflict",
          name: "CONFLICTING_KEY",
          key: "CONFLICTING_KEY",
          providerVersionRef: null,
          description: null,
          status: "conflict",
          reason: "Name already exists",
        },
      ],
    });
    vi.mocked(secretsApi.remoteImport.commit).mockResolvedValue({
      providerConfigId: providerConfig.id,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
          name: "OPENAI_API_KEY",
          status: "imported",
          secretId: "secret-1",
        },
      ],
    });

    renderWithProviders(
      <ImportFromVaultDialog
        companyId="company-1"
        open
        onOpenChange={vi.fn()}
        providerConfigs={[providerConfig]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview remote secrets" }));
    await screen.findAllByText("CONFLICTING_KEY");
    const readyRow = screen.getAllByText("OPENAI_API_KEY")[0];
    const conflictRow = screen.getAllByText("CONFLICTING_KEY")[0].closest("tr")!;
    expect(conflictRow).toBeTruthy();
    expect(within(conflictRow).getByRole("checkbox").getAttribute("disabled")).toBeNull();

    fireEvent.click(within(readyRow.closest("tr")!).getByRole("checkbox"));
    fireEvent.click(within(conflictRow).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    await waitFor(() => {
      expect(secretsApi.remoteImport.commit).toHaveBeenCalledWith("company-1", {
        providerConfigId: providerConfig.id,
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/openai",
            name: "OPENAI_API_KEY",
            key: "OPENAI_API_KEY",
            providerVersionRef: "v1",
            description: null,
          },
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:aoa/prod/conflict",
            name: "CONFLICTING_KEY",
            key: "CONFLICTING_KEY",
            providerVersionRef: null,
            description: null,
          },
        ],
      });
    });
    expect(await screen.findByText("imported")).toBeTruthy();
    expect(screen.getByText("1 imported")).toBeTruthy();
    expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
  });
});
