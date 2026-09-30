import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrgStep } from "../OrgStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const createCompany = vi.fn(async (_data: { name: string; organizationId?: string; creationRequestId?: string }) => ({
  id: "c1",
  name: "Acme",
}));
vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({ createCompany }),
}));
const companiesGet = vi.hoisted(() =>
  vi.fn(async (id: string) => ({ id, name: "Acme Existing" })),
);
vi.mock("../../../api/companies", () => ({ companiesApi: { get: companiesGet } }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({
    completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"],
  })),
}));

import { advanceOnboarding } from "../../../api/onboarding";

// Phase 2 Task 12: organizationId is populated by the preceding
// CreateOrganizationStep and forwarded into createCompany.
const ctx: StepContext = {
  userId: "u1",
  companyId: null,
  journey: "founder",
  completedStates: ["AUTHENTICATED", "PROFILE_SET"],
  organizationId: "org1",
};

describe("OrgStep (Stage C / order 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("requires a company name", async () => {
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText(/enter a name/i)).toBeTruthy();
    expect(createCompany).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("creates the company, advances COMPANY_CREATED on the NEW company, then completes", async () => {
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createCompany).toHaveBeenCalledWith({
      name: "Acme",
      organizationId: "org1",
      creationRequestId: expect.any(String),
    });
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMPANY_CREATED",
    });
    expect(localStorage.getItem("aoa.onboarding.pendingOrganization.u1")).toBeNull();
  });

  it("clears the pending tenant once the company consumes the org", async () => {
    localStorage.setItem(
      "aoa.onboarding.pendingTenant.u1",
      JSON.stringify({ id: "org1", name: "Acme Org" }),
    );
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(localStorage.getItem("aoa.onboarding.pendingTenant.u1")).toBeNull();
  });

  it("does NOT create a second company when the advance fails and the user retries", async () => {
    // First advance throws (e.g. transient network) — the company is already
    // created + selected; a retry must reuse it, not mint a duplicate.
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"],
      });
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });

    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText("network")).toBeTruthy();
    expect(localStorage.getItem("aoa.onboarding.pendingOrganization.u1")).toContain('"id":"c1"');
    expect(onComplete).not.toHaveBeenCalled();

    // Retry — button re-enabled after the failure.
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    expect(createCompany).toHaveBeenCalledTimes(1);
    expect(advanceOnboarding).toHaveBeenCalledTimes(2);
  });

  it("does NOT create a second company after reload when create succeeded but advance failed", async () => {
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"],
      });
    const firstComplete = vi.fn();
    const firstRender = render(
      <OrgStep ctx={ctx} onComplete={firstComplete} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText("network")).toBeTruthy();

    firstRender.unmount();

    const secondComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={secondComplete} onBack={() => {}} />);
    expect(screen.getByDisplayValue("Acme")).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(secondComplete).toHaveBeenCalled());

    expect(createCompany).toHaveBeenCalledTimes(1);
    expect(advanceOnboarding).toHaveBeenLastCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "COMPANY_CREATED",
    });
    expect(localStorage.getItem("aoa.onboarding.pendingOrganization.u1")).toBeNull();
  });

  it("reuses a persisted request id after the company response is lost", async () => {
    createCompany
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: "c1", name: "Acme" });
    const first = render(<OrgStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText("response lost")).toBeTruthy();
    const firstRequestId = createCompany.mock.calls[0]?.[0].creationRequestId;
    expect(firstRequestId).toEqual(expect.any(String));
    expect(localStorage.getItem("aoa.onboarding.pendingOrganization.u1")).toContain(firstRequestId);

    first.unmount();
    const onComplete = vi.fn();
    render(<OrgStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createCompany.mock.calls[1]?.[0].creationRequestId).toBe(firstRequestId);
  });

  it("reuses the selected company when resuming an org layer without a recovery hint", async () => {
    const onComplete = vi.fn();
    render(
      <OrgStep
        ctx={{ ...ctx, companyId: "existing-company" }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    expect(createCompany).not.toHaveBeenCalled();
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "existing-company",
      journey: "founder",
      requestedState: "COMPANY_CREATED",
    });
  });

  it("revisited (walk-back) state is read-only: shows the created company's name, no editable field", async () => {
    const onComplete = vi.fn();
    render(
      <OrgStep
        ctx={{ ...ctx, companyId: "existing-company" }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );

    // The company already exists — an editable empty field here would
    // silently discard whatever the founder typed (the input was never read).
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/already created/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("org-revisited-name").textContent).toBe("Acme Existing"),
    );
    expect(companiesGet).toHaveBeenCalledWith("existing-company");

    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(createCompany).not.toHaveBeenCalled();
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "existing-company",
      journey: "founder",
      requestedState: "COMPANY_CREATED",
    });
  });

  it("revisited state surfaces a failed re-advance and re-enables Continue", async () => {
    (advanceOnboarding as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("advance blew up"),
    );
    const onComplete = vi.fn();
    render(
      <OrgStep
        ctx={{ ...ctx, companyId: "existing-company" }}
        onComplete={onComplete}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText("advance blew up")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    expect(
      (screen.getByText("Continue").closest("button") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("assembled registry includes the company step", () => {
  it("ONBOARDING_STEPS still passes the registry guard", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
  });
  it("registers the company step (id 'company') at order 2 for the founder journey", () => {
    // Phase 2 Task 3/12: two steps now nominally target COMPANY_CREATED (the
    // new "organization"/CreateOrganizationStep placeholder at order 1.5, and
    // the real "company"/OrgStep at order 2) — look up by id, not by state,
    // to avoid Array.find grabbing the wrong one.
    const org = ONBOARDING_STEPS.find((s) => s.id === "company");
    expect(org).toBeTruthy();
    expect(org?.state).toBe("COMPANY_CREATED");
    expect(org?.order).toBe(2);
    expect(org?.journeys).toEqual(["founder"]);
    expect(org?.dependsOn).toEqual(["PROFILE_SET"]);
  });
});
