import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DepartmentStep } from "../DepartmentStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";
import { DEPARTMENT_FUNCTION_TYPES } from "@armyofagents/shared";

const list = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const create = vi.hoisted(() => vi.fn(async () => ({ id: "d1" })));
const listWorkspaces = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const createWorkspace = vi.hoisted(() => vi.fn(async () => ({})));
const getCompany = vi.hoisted(() => vi.fn(async () => ({ id: "c1", rootFolder: "/home/ada/AoA" })));
const mkdir = vi.hoisted(() => vi.fn(async () => ({ created: true, path: "" })));

vi.mock("../../../api/projects", () => ({
  projectsApi: { list, create, listWorkspaces, createWorkspace },
}));
vi.mock("../../../api/companies", () => ({ companiesApi: { get: getCompany } }));
vi.mock("../../../api/filesystem", () => ({ filesystemApi: { mkdir } }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: [] })),
}));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: "c1",
  journey: "founder",
  completedStates: [
    "AUTHENTICATED",
    "PROFILE_SET",
    "ORGANIZATION_CREATED",
    "ENVIRONMENT_READY",
    "COMMANDER_SELECTED",
    "COMMANDER_VERIFIED",
  ],
};

describe("DepartmentStep (Stage C / order 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
    listWorkspaces.mockResolvedValue([]);
    create.mockResolvedValue({ id: "d1" });
    getCompany.mockResolvedValue({ id: "c1", rootFolder: "/home/ada/AoA" });
  });

  it("creates a software department + nested workspace, advances DEPARTMENT_CREATED, completes", async () => {
    const onComplete = vi.fn();
    render(<DepartmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Engineering"), { target: { value: "Engineering" } });
    // wait for the nested-folder prefill to settle
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/engineering")).toBeTruthy());
    fireEvent.click(screen.getByText("Create department"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "Engineering", type: "department", functionType: "software_development" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ cwd: "/home/ada/AoA/engineering" }),
      "c1",
    );
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "DEPARTMENT_CREATED",
    });
  });

  it("is idempotent — reuses an existing same-named department (no second create)", async () => {
    list.mockResolvedValue([{ id: "existing", type: "department", name: "Engineering" }]);
    const onComplete = vi.fn();
    render(<DepartmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Engineering"), { target: { value: "Engineering" } });
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/engineering")).toBeTruthy());
    fireEvent.click(screen.getByText("Create department"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    expect(listWorkspaces).toHaveBeenCalledWith("existing", "c1");
    expect(createWorkspace).toHaveBeenCalledWith(
      "existing",
      expect.objectContaining({ cwd: "/home/ada/AoA/engineering" }),
      "c1",
    );
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: "c1",
      journey: "founder",
      requestedState: "DEPARTMENT_CREATED",
    });
  });

  it("does not duplicate a workspace that already exists on retry", async () => {
    list.mockResolvedValue([{ id: "existing", type: "department", name: "Engineering" }]);
    listWorkspaces.mockResolvedValue([{ id: "w1", projectId: "existing" }]);
    const onComplete = vi.fn();
    render(<DepartmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/engineering")).toBeTruthy());
    fireEvent.click(screen.getByText("Create department"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    expect(listWorkspaces).toHaveBeenCalledWith("existing", "c1");
    expect(mkdir).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("prefills the name so the create button isn't silently disabled (live-QA regression)", () => {
    render(<DepartmentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    const btn = screen.getByRole("button", { name: "Create department" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByDisplayValue("Engineering")).toBeTruthy();
  });

  it("surfaces a folder-creation failure instead of silently building a broken workspace", async () => {
    mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const onComplete = vi.fn();
    render(<DepartmentStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Engineering"), { target: { value: "Engineering" } });
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/engineering")).toBeTruthy());
    fireEvent.click(screen.getByText("Create department"));
    // the mkdir error is surfaced …
    expect(await screen.findByText(/Couldn't create the folder/)).toBeTruthy();
    // … and we do NOT create a workspace on a folder that doesn't exist, nor advance.
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("requires a repository URL when GitHub repo is selected", async () => {
    render(<DepartmentStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/engineering")).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Local folder/i));
    fireEvent.click(screen.getByLabelText(/GitHub repo/i));

    const button = screen.getByRole("button", { name: "Create department" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(createWorkspace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("https://github.com/org/repo"), {
      target: { value: "https://github.com/acme/product" },
    });
    expect(button.disabled).toBe(false);
  });
});

describe("assembled registry (WS0c: DepartmentStep is no longer a wizard step)", () => {
  it("passes the guard, and DEPARTMENT_CREATED/DepartmentStep are no longer registered — the founder wizard ends at the spine (SETUP_COMPLETE); Home owns the department tail", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
    expect(ONBOARDING_STEPS.find((s) => s.state === "DEPARTMENT_CREATED")).toBeUndefined();
    expect(ONBOARDING_STEPS.find((s) => s.id === "department")).toBeUndefined();
  });
  it("uses the shared taxonomy (sales present)", () => {
    expect(DEPARTMENT_FUNCTION_TYPES.some((t) => t.value === "sales")).toBe(true);
  });
});
