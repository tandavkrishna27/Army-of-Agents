import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { ManifestEditor } from "../ManifestEditor";

const mockUpdateManifest = vi.fn();
const mockPushToast = vi.fn();

vi.mock("../../../api/teams", () => ({
  teamsApi: {
    updateManifest: (...args: unknown[]) => mockUpdateManifest(...args),
  },
}));

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1" }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const SAMPLE_MANIFEST: Record<string, unknown> = {
  routing: { kind: "round_robin" },
  members: ["alice", "bob"],
};

describe("ManifestEditor", () => {
  beforeEach(() => {
    mockUpdateManifest.mockReset();
    mockPushToast.mockReset();
  });

  it("renders the editor with the initial manifest stringified as YAML", () => {
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );
    const textarea = screen.getByRole("textbox", {
      name: /team manifest yaml editor/i,
    }) as HTMLTextAreaElement;
    // YAML stringification format: keys at column 0, list items with `- ` prefix
    expect(textarea.value).toContain("routing:");
    expect(textarea.value).toContain("kind: round_robin");
    expect(textarea.value).toContain("- alice");
    expect(textarea.value).toContain("- bob");
  });

  it("shows a parse error when the user enters invalid YAML", async () => {
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );
    const textarea = screen.getByRole("textbox", {
      name: /team manifest yaml editor/i,
    });
    const saveButton = screen.getByRole("button", { name: /save/i });
    // Use fireEvent.change rather than user.type — userEvent treats `[` as a
    // keyboard-descriptor special character.
    fireEvent.change(textarea, { target: { value: "[unclosed" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    // Behavioral assertions only — don't pin to the `yaml` package's exact
    // wording. Any non-empty error and a disabled Save button is enough.
    expect((alert.textContent ?? "").length).toBeGreaterThan(0);
    expect(saveButton).toBeDisabled();
  });

  it("disables the Save button when there's a parse error", async () => {
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );
    const textarea = screen.getByRole("textbox", {
      name: /team manifest yaml editor/i,
    });
    const saveButton = screen.getByRole("button", { name: /save/i });

    // Initially valid YAML → enabled
    expect(saveButton).not.toBeDisabled();

    fireEvent.change(textarea, { target: { value: "[unclosed" } });

    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("calls teamsApi.updateManifest with the parsed object on Save click", async () => {
    const user = userEvent.setup();
    mockUpdateManifest.mockResolvedValue({ id: "team-1", manifest: SAMPLE_MANIFEST });
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );

    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => expect(mockUpdateManifest).toHaveBeenCalledTimes(1));
    const [calledTeamId, calledManifest] = mockUpdateManifest.mock.calls[0]!;
    expect(calledTeamId).toBe("team-1");
    // The component re-stringifies + parses, so the round-tripped object should
    // equal the input (no mutations from the user in this test).
    expect(calledManifest).toEqual(SAMPLE_MANIFEST);
  });

  it("shows a success toast after a successful save", async () => {
    const user = userEvent.setup();
    mockUpdateManifest.mockResolvedValue({ id: "team-1", manifest: SAMPLE_MANIFEST });
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );

    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() =>
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Manifest saved", tone: "success" }),
      ),
    );
  });

  it("disables Save and shows shape error when textarea is emptied", async () => {
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );
    const textarea = screen.getByRole("textbox", {
      name: /team manifest yaml editor/i,
    });
    const saveButton = screen.getByRole("button", { name: /save/i });

    fireEvent.change(textarea, { target: { value: "" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("rejects YAML that parses to a scalar or list", async () => {
    render(
      wrap(<ManifestEditor teamId="team-1" initialManifest={SAMPLE_MANIFEST} />),
    );
    const textarea = screen.getByRole("textbox", {
      name: /team manifest yaml editor/i,
    });
    const saveButton = screen.getByRole("button", { name: /save/i });

    // Plain string scalar — parses to "hello world", not a mapping.
    fireEvent.change(textarea, { target: { value: "hello world" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    await waitFor(() => expect(saveButton).toBeDisabled());
  });
});
