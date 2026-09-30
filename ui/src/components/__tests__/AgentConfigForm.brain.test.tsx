import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigForm, type CreateConfigValues } from "../AgentConfigForm";
import { defaultCreateValues } from "../agent-config-defaults";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../api/agents", () => ({
  agentsApi: {
    // Non-empty models for EVERY adapter type — including non-local ones.
    adapterModels: vi
      .fn()
      .mockResolvedValue([{ id: "openai/gpt-5", label: "gpt-5" }]),
    org: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../api/secrets", () => ({
  secretsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock("../../api/environments", () => ({
  useEnvironments: () => ({ data: [] }),
}));

vi.mock("../../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Prompt template"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function CreateHarness({ initial }: { initial?: Partial<CreateConfigValues> }) {
  const [values, setValues] = useState<CreateConfigValues>({
    ...defaultCreateValues,
    ...initial,
  });
  return (
    <AgentConfigForm
      mode="create"
      values={values}
      onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
    />
  );
}

function renderCreate(initial?: Partial<CreateConfigValues>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CreateHarness initial={initial} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("AgentConfigForm Brain block (create mode)", () => {
  it("shows the model picker for a non-isLocal adapter that exposes models", async () => {
    // "process" is NOT in the isLocal allowlist. Previously the Model picker was
    // gated to isLocal, so this adapter never showed one.
    renderCreate({ adapterType: "process" });

    await waitFor(() =>
      expect(screen.getByText("Model")).toBeInTheDocument(),
    );
  });

  it("keeps command/env behind Advanced (collapsed) in create mode", async () => {
    // codex_local (default) is isLocal, so Command exists — but it must be
    // hidden behind a collapsed Advanced disclosure in create mode.
    renderCreate();

    // The Brain model picker is visible immediately.
    await waitFor(() => expect(screen.getByText("Model")).toBeInTheDocument());

    // Command is not visible until Advanced is expanded.
    expect(screen.queryByText("Command")).not.toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("button", { name: /advanced/i }),
    );

    expect(await screen.findByText("Command")).toBeInTheDocument();
  });
});
