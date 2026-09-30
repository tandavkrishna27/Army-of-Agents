import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { CreateAnotherCompany } from "../CreateAnotherCompany";
import type { OrganizationMembership } from "../../api/organizations";

const state = vi.hoisted(() => ({
  health: { deploymentMode: "cloud_auth" } as { deploymentMode: string },
  healthError: false,
  orgsError: false,
  orgs: [] as OrganizationMembership[],
  orgStepProps: null as unknown as {
    ctx: { organizationId: string | null; companyId: string | null };
    onComplete: () => void;
  },
  createOrgProps: null as unknown as {
    ctx: { setOrganizationId?: (id: string) => void };
    onComplete: () => void;
  },
}));

vi.mock("../../api/health", () => ({
  healthApi: {
    get: () =>
      state.healthError ? Promise.reject(new Error("health down")) : Promise.resolve(state.health),
  },
}));
vi.mock("../../api/organizations", () => ({
  organizationsApi: {
    list: () =>
      state.orgsError ? Promise.reject(new Error("orgs down")) : Promise.resolve(state.orgs),
  },
}));
vi.mock("../steps/OrgStep", () => ({
  OrgStep: (props: {
    ctx: { organizationId: string | null; companyId: string | null };
    onComplete: () => void;
  }) => {
    state.orgStepProps = props;
    return <div>org-step</div>;
  },
}));
vi.mock("../steps/CreateOrganizationStep", () => ({
  CreateOrganizationStep: (props: {
    ctx: { setOrganizationId?: (id: string) => void };
    onComplete: () => void;
  }) => {
    state.createOrgProps = props;
    return (
      <button type="button" onClick={() => props.ctx.setOrganizationId?.("orgNEW")}>
        mint-org
      </button>
    );
  },
}));

const membership = (over: Partial<OrganizationMembership>): OrganizationMembership => ({
  id: "mem-1",
  organizationId: "org",
  organizationName: "Organization",
  organizationSlug: "organization",
  userId: "u1",
  role: "owner",
  status: "active",
  ...over,
});

describe("CreateAnotherCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.health = { deploymentMode: "cloud_auth" };
    state.healthError = false;
    state.orgsError = false;
    state.orgs = [];
    state.orgStepProps = null as never;
    state.createOrgProps = null as never;
  });

  it("cloud_auth + one create-capable org: auto-picks it and sends its id to the company step", async () => {
    state.orgs = [
      membership({ id: "m1", organizationId: "orgA", role: "owner" }),
      membership({ id: "m2", organizationId: "orgB", role: "member" }),
    ];
    const onCompleteCompany = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={onCompleteCompany}
        onBack={() => {}}
      />,
    );
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBe("orgA");
    expect(state.orgStepProps.ctx.companyId).toBeNull();
    state.orgStepProps.onComplete();
    expect(onCompleteCompany).toHaveBeenCalled();
  });

  it("cloud_auth + two create-capable orgs: friendly message, no picker and no company step", async () => {
    state.orgs = [
      membership({ id: "m1", organizationId: "orgA", role: "owner" }),
      membership({ id: "m2", organizationId: "orgB", role: "admin" }),
    ];
    const onBack = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={onBack}
      />,
    );
    // Exact title match (not a /more than one organization/i substring regex):
    // the new title AND description both contain that phrase, so the substring
    // form throws on multiple matches. The exact string hits only the title.
    expect(await screen.findByText("More than one organization")).toBeTruthy();
    // The honest copy must NOT point at a nonexistent "open the organization …
    // create it from there" flow (the removed misleading copy) — the assertion
    // that actually distinguishes the fix from the old copy.
    expect(screen.queryByText(/open the organization/i)).toBeNull();
    expect(screen.queryByText("org-step")).toBeNull();
    // Scope to the button by role: the new honest description also ends with
    // "…go back to your workspace", so a bare getByText would match two nodes.
    fireEvent.click(screen.getByRole("button", { name: /back to your workspace/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("cloud_auth + zero create-capable orgs: routes to CreateOrganizationStep, then into the company step under the new org", async () => {
    state.orgs = [membership({ id: "m1", organizationId: "orgB", role: "member" })];
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={() => {}}
      />,
    );
    fireEvent.click(await screen.findByText("mint-org"));
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBe("orgNEW");
  });

  it("cloud_auth + org list fails to load: friendly retry surface, no company step", async () => {
    state.orgsError = true;
    const onBack = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={onBack}
      />,
    );
    expect(await screen.findByText(/couldn't load your organizations/i)).toBeTruthy();
    expect(screen.queryByText("org-step")).toBeNull();
    fireEvent.click(screen.getByText(/back to your workspace/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("health fails to load: friendly retry surface, NOT a silent self-hosted fall-through", async () => {
    state.healthError = true;
    const onBack = vi.fn();
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={onBack}
      />,
    );
    expect(await screen.findByText(/couldn't load your workspace/i)).toBeTruthy();
    // Must NOT drop a cloud founder into OrgStep with a null org id.
    expect(screen.queryByText("org-step")).toBeNull();
    fireEvent.click(screen.getByText(/back to your workspace/i));
    expect(onBack).toHaveBeenCalled();
  });

  it("self-hosted (not cloud_auth): omits the org id so the server derives the default sentinel", async () => {
    state.health = { deploymentMode: "authenticated" };
    renderWithProviders(
      <CreateAnotherCompany
        userId="u1"
        journey="founder"
        onCompleteCompany={() => {}}
        onBack={() => {}}
      />,
    );
    await screen.findByText("org-step");
    expect(state.orgStepProps.ctx.organizationId).toBeNull();
  });
});
