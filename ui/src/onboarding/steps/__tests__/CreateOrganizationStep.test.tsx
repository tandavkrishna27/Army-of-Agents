import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateOrganizationStep } from "../CreateOrganizationStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const createOrg = vi.fn(async (_: { name: string; creationRequestId?: string }) => ({ id: "org1", name: "Acme" }));
vi.mock("../../../api/organizations", () => ({ organizationsApi: { create: (a: any) => createOrg(a) } }));

const ctx: StepContext = {
  userId: "u1",
  journey: "founder",
  companyId: null,
  completedStates: ["AUTHENTICATED", "PROFILE_SET"],
  organizationId: null,
};

describe("CreateOrganizationStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("requires an organization name", async () => {
    const onComplete = vi.fn();
    render(<CreateOrganizationStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText(/enter a name/i)).toBeTruthy();
    expect(createOrg).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not promise renaming the organization later (no rename route/UI exists)", () => {
    render(<CreateOrganizationStep ctx={ctx} onComplete={() => {}} onBack={() => {}} />);
    // Using body text (not queryByText) avoids throwing on partial multi-node matches.
    expect(document.body.textContent).not.toMatch(/rename it later/i);
  });

  it("creates an organization, stores its id on ctx, and advances", async () => {
    const onComplete = vi.fn();
    const setOrganizationId = vi.fn();
    render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(createOrg).toHaveBeenCalledWith({
      name: "Acme",
      creationRequestId: expect.any(String),
    }));
    await waitFor(() => expect(setOrganizationId).toHaveBeenCalledWith("org1"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("surfaces a create failure and re-enables Continue", async () => {
    createOrg.mockRejectedValueOnce(new Error("network blew up"));
    const onComplete = vi.fn();
    render(<CreateOrganizationStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("network blew up")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("persists a pending tenant on create (before completing)", async () => {
    const onComplete = vi.fn();
    const setOrganizationId = vi.fn();
    render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createOrg).toHaveBeenCalledTimes(1);
    expect(setOrganizationId).toHaveBeenCalledWith("org1");
    expect(localStorage.getItem("aoa.onboarding.pendingTenant.u1")).toContain('"id":"org1"');
  });

  it("persists and reuses the request id after a lost create response", async () => {
    createOrg
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: "org1", name: "Acme" });
    const first = render(
      <CreateOrganizationStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("response lost")).toBeTruthy();
    const firstRequestId = createOrg.mock.calls[0]?.[0].creationRequestId;
    expect(firstRequestId).toEqual(expect.any(String));
    expect(localStorage.getItem("aoa.onboarding.pendingTenant.u1")).toContain(firstRequestId);

    first.unmount();
    const onComplete = vi.fn();
    render(<CreateOrganizationStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createOrg.mock.calls[1]?.[0].creationRequestId).toBe(firstRequestId);
  });

  it("does NOT create a second org after a reload (remount) — adopts the persisted tenant", async () => {
    const setOrganizationId = vi.fn();

    // First mount: create the org.
    const firstComplete = vi.fn();
    const first = render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={firstComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(firstComplete).toHaveBeenCalled());
    expect(createOrg).toHaveBeenCalledTimes(1);

    // Simulate a hard reload between the org step and the company step: the
    // component unmounts and remounts, but localStorage survives.
    first.unmount();
    setOrganizationId.mockClear();

    const secondComplete = vi.fn();
    render(
      <CreateOrganizationStep
        ctx={{ ...ctx, setOrganizationId }}
        onComplete={secondComplete}
        onBack={() => {}}
      />,
    );
    // Adopts the persisted org id and advances WITHOUT a second POST.
    await waitFor(() => expect(secondComplete).toHaveBeenCalled());
    expect(setOrganizationId).toHaveBeenCalledWith("org1");
    expect(createOrg).toHaveBeenCalledTimes(1);
  });
});

describe("assembled registry registers the organization step before the company step", () => {
  it("ONBOARDING_STEPS still passes the registry guard", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
  });
  it("registers CreateOrganizationStep (id 'organization') before the company step for the founder journey", () => {
    const org = ONBOARDING_STEPS.find((s) => s.id === "organization");
    const company = ONBOARDING_STEPS.find((s) => s.id === "company");
    expect(org).toBeTruthy();
    expect(company).toBeTruthy();
    expect(org?.Component).toBe(CreateOrganizationStep);
    expect(org?.journeys).toEqual(["founder"]);
    expect(org?.dependsOn).toEqual(["PROFILE_SET"]);
    expect(org!.order).toBeLessThan(company!.order);
  });
});
