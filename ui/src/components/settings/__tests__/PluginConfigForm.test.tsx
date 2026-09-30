import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { PluginConfigForm } from "../PluginConfigForm";
import * as pluginsApi from "@/api/plugins";

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>("@/api/plugins");
  return { ...actual, savePluginConfig: vi.fn() };
});

// Minimal ToastContext stub — real one requires full app tree
const toastPush = vi.fn();
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: toastPush }),
}));

const SCHEMA = {
  properties: {
    apiKey: { type: "string", title: "API Key" },
  },
  required: [],
};

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("PluginConfigForm", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("shows success toast after save", async () => {
    vi.mocked(pluginsApi.savePluginConfig).mockResolvedValueOnce({ configJson: {} });

    wrap(
      <PluginConfigForm
        companyId="c1"
        pluginId="p1"
        schema={SCHEMA}
        initialValues={{ apiKey: "test" }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() =>
      expect(toastPush).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "success" }),
      ),
    );
  });

  it("does NOT show success toast when save fails", async () => {
    vi.mocked(pluginsApi.savePluginConfig).mockRejectedValueOnce(new Error("500"));

    wrap(
      <PluginConfigForm
        companyId="c1"
        pluginId="p1"
        schema={SCHEMA}
        initialValues={{ apiKey: "test" }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() =>
      expect(toastPush).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "error" }),
      ),
    );
  });
});
