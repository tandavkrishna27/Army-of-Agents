import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EnvironmentStep } from "../EnvironmentStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";
import { ApiError } from "../../../api/client";

const post = vi.hoisted(() => vi.fn(async () => ({ ok: true, environmentId: "e1" })));
// BLOCKING fix: the mount-time prefill must use the company-scoped, jail-aware
// `companyWorkspaceFsApi(companyId).home()` — the SAME client the
// FolderBrowserDialog uses — not the instance-admin `filesystemApi.home()`
// (gated by `assertCanManageInstanceSettings`, 403s for a non-admin founder in
// `authenticated` mode).
const homeCompany = vi.hoisted(() => vi.fn(async () => ({ homePath: "/home/ada", platform: "linux" })));
const homeInstance = vi.hoisted(() =>
  vi.fn(async () => ({ homePath: "/home/instance-admin", platform: "linux" })),
);
const companyWorkspaceFsApi = vi.hoisted(() => vi.fn((_companyId: string) => ({ home: homeCompany })));

vi.mock("../../../api/client", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, api: { ...(actual.api as object), post } };
});
vi.mock("../../../api/filesystem", () => ({
  filesystemApi: { home: () => homeInstance() },
  companyWorkspaceFsApi,
}));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({
    completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED", "ENVIRONMENT_READY"],
  })),
}));

// WS3/WS0a: EnvironmentStep wires in the shared FolderBrowserDialog (a Radix
// Dialog with its own async filesystem queries). Mock the dialog component
// itself — a lightweight stand-in that exposes onSelect via a button — so this
// suite verifies the WIRING (companyId passed through, chosen path written
// back) without depending on Radix portal/query internals covered by
// FolderBrowserDialog's own tests.
type FolderBrowserDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  companyId?: string;
  initialPath?: string;
};
const dialogPropsRef = vi.hoisted(() => ({ current: null as FolderBrowserDialogProps | null }));
vi.mock("@/components/FolderBrowserDialog", () => ({
  FolderBrowserDialog: (props: FolderBrowserDialogProps) => {
    dialogPropsRef.current = props;
    if (!props.open) return null;
    return (
      <button type="button" onClick={() => props.onSelect("/chosen/path")}>
        choose-path
      </button>
    );
  },
}));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: "c1",
  journey: "founder",
  completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"],
};

describe("EnvironmentStep (Stage C / order 3, revA R13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogPropsRef.current = null;
  });

  it("WS0a/WS3: opens the FolderBrowserDialog scoped to the company (jailed API), and writes the chosen path", async () => {
    render(<EnvironmentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home/ada/AoA"),
    );
    // Rendered closed, already scoped to the org-layer company.
    expect(dialogPropsRef.current?.open).toBe(false);
    expect(dialogPropsRef.current?.companyId).toBe("c1");

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect(dialogPropsRef.current?.open).toBe(true);

    fireEvent.click(screen.getByText("choose-path"));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/chosen/path"),
    );

    // The typed/browsed path is what actually gets submitted.
    fireEvent.click(screen.getByText(/verify/i));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/companies/c1/onboarding/environment", {
        rootFolder: "/chosen/path",
      }),
    );
  });

  it("BLOCKING fix: prefill uses the company-scoped fs API (not the instance-admin one)", async () => {
    render(<EnvironmentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home/ada/AoA"),
    );
    expect(companyWorkspaceFsApi).toHaveBeenCalledWith("c1");
    expect(homeCompany).toHaveBeenCalled();
    expect(homeInstance).not.toHaveBeenCalled();
  });

  it("prefills the home dir, sets up the env, advances ENVIRONMENT_READY, then completes", async () => {
    const onComplete = vi.fn();
    render(<EnvironmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    // Prefilled from the home dir.
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home/ada/AoA"),
    );
    fireEvent.click(screen.getByText(/verify/i));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/companies/c1/onboarding/environment", {
      rootFolder: "/home/ada/AoA",
    });
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "ENVIRONMENT_READY",
    });
  });

  it("BLOCKS on a 422 probe failure — surfaces the reason, does not advance or complete", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        ok: false,
        probe: {
          ok: false,
          summary: "Cannot write to /home/ada/AoA.",
          checks: [{ name: "config.path", status: "failed", message: "EACCES: permission denied" }],
        },
      }),
    );
    const onComplete = vi.fn();
    render(<EnvironmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home/ada/AoA"),
    );
    fireEvent.click(screen.getByText(/verify/i));
    expect(await screen.findByText(/cannot write to/i)).toBeTruthy();
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("assembled registry includes the environment step", () => {
  it("ONBOARDING_STEPS still passes the registry guard", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
  });
  it("registers the environment step at order 3 for the founder journey", () => {
    const env = ONBOARDING_STEPS.find((s) => s.state === "ENVIRONMENT_READY");
    expect(env).toBeTruthy();
    expect(env?.order).toBe(3);
    expect(env?.journeys).toEqual(["founder"]);
    expect(env?.dependsOn).toEqual(["COMPANY_CREATED"]);
  });
});
