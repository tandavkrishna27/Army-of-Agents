import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/__tests__/test-utils";
import { secretsApi } from "@/api/secrets";
import { Secrets } from "./Secrets";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Test Co" },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    list: vi.fn(),
    providers: vi.fn(),
    create: vi.fn(),
    rotate: vi.fn(),
    providerConfigs: {
      list: vi.fn(),
      create: vi.fn(),
      check: vi.fn(),
    },
    remoteImport: {
      preview: vi.fn(),
      commit: vi.fn(),
    },
    bindings: {
      list: vi.fn(),
    },
    accessEvents: vi.fn(),
  },
}));

describe("Secrets render", () => {
  it("renders the new settings shell through the legacy page", async () => {
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(secretsApi.providers).mockResolvedValue([]);
    vi.mocked(secretsApi.providerConfigs.list).mockResolvedValue([]);

    renderWithProviders(<Secrets />);

    expect(await screen.findByRole("heading", { name: /secrets/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add secret/i })).toBeTruthy();
  });
});
