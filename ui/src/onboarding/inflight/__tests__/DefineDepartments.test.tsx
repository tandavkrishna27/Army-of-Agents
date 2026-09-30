import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DefineDepartments } from "../DefineDepartments";

const list = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const create = vi.hoisted(() => vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
  id: `proj-${(data.name as string).toLowerCase().replace(/\s+/g, "-")}`,
  type: data.type,
  name: data.name,
})));
const listWorkspaces = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const createWorkspace = vi.hoisted(() => vi.fn(async () => ({})));
const getCompany = vi.hoisted(() => vi.fn(async () => ({ id: "c1", rootFolder: "/home/ada/AoA" })));
const mkdir = vi.hoisted(() => vi.fn(async () => ({ created: true, path: "" })));
const companyWorkspaceFsApi = vi.hoisted(() => vi.fn((_companyId: string) => ({ mkdir })));

vi.mock("../../../api/projects", () => ({
  projectsApi: { list, create, listWorkspaces, createWorkspace },
}));
vi.mock("../../../api/companies", () => ({ companiesApi: { get: getCompany } }));
vi.mock("../../../api/filesystem", () => ({ companyWorkspaceFsApi }));

// This surface is domain-only — DefineDepartments.tsx does not even import
// "../../api/onboarding" (unlike DepartmentStep, which WS0c forbids calling
// advanceOnboarding from). Mock it anyway and assert it's never called, as a
// regression guard in case that import is ever added back.
const advanceOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../../../api/onboarding", () => ({ advanceOnboarding }));

type FolderBrowserDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  companyId?: string;
  initialPath?: string;
  gitAware?: boolean;
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

describe("DefineDepartments (WS4 — In-flight standalone surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `vi.clearAllMocks()` resets call history but NOT a mock's
    // implementation — restore the default `create` implementation here so a
    // test that installs a custom `create.mockImplementation(...)` (e.g. to
    // hold a create promise pending) can't leak it into the next test.
    create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      id: `proj-${(data.name as string).toLowerCase().replace(/\s+/g, "-")}`,
      type: data.type,
      name: data.name,
    }));
    list.mockResolvedValue([]);
    listWorkspaces.mockResolvedValue([]);
    getCompany.mockResolvedValue({ id: "c1", rootFolder: "/home/ada/AoA" });
    mkdir.mockResolvedValue({ created: true, path: "" });
    dialogPropsRef.current = null;
  });

  it("defaults to a single Software department", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    expect(screen.getByDisplayValue("Software")).toBeTruthy();
    // Software shows folder + repo controls.
    expect(screen.getByText(/Local folder/)).toBeTruthy();
    expect(screen.getByText(/GitHub repo/)).toBeTruthy();
    await waitFor(() => expect(getCompany).toHaveBeenCalled());
  });

  it("non-software departments hide folder/repo controls", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    // Switch the default department to Marketing.
    fireEvent.click(screen.getByText("Marketing"));
    await waitFor(() => expect(screen.queryByText(/Local folder/)).toBeNull());
    expect(screen.queryByText(/GitHub repo/)).toBeNull();
  });

  it("adds and removes departments; first (Software) stays present", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    expect(screen.getAllByPlaceholderText("Department name")).toHaveLength(1);

    fireEvent.click(screen.getByText(/Add department/));
    expect(screen.getAllByPlaceholderText("Department name")).toHaveLength(2);
    expect(screen.getByDisplayValue("Software")).toBeTruthy();

    const removeButtons = screen.getAllByRole("button", { name: /^Remove /i });
    expect(removeButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    expect(screen.getAllByPlaceholderText("Department name")).toHaveLength(1);
    expect(screen.getByDisplayValue("Software")).toBeTruthy();
    await waitFor(() => expect(getCompany).toHaveBeenCalled());
  });

  it("cannot remove the last remaining department", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
    await waitFor(() => expect(getCompany).toHaveBeenCalled());
  });

  it("blocks submit when the GitHub URL is invalid", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/GitHub repo/));
    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    // Repo checked but empty URL → blocked.
    expect(continueBtn.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("https://github.com/org/repo"), {
      target: { value: "https://gitlab.com/acme/product" },
    });
    expect(continueBtn.disabled).toBe(true);
    expect(screen.getByText(/valid GitHub repository URL/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("https://github.com/org/repo"), {
      target: { value: "https://github.com/acme/product" },
    });
    expect(continueBtn.disabled).toBe(false);
  });

  it("gives the local-folder-path and repo-URL inputs an accessible name", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());
    expect(screen.getByLabelText("Local folder path for Software")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/GitHub repo/));
    expect(screen.getByLabelText("Repository URL for Software")).toBeTruthy();
  });

  it("opens the FolderBrowserDialog scoped to companyId", async () => {
    render(<DefineDepartments companyId="c1" onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());
    expect(dialogPropsRef.current?.open).toBe(false);
    fireEvent.click(screen.getByText("Browse"));
    expect(dialogPropsRef.current?.open).toBe(true);
    expect(dialogPropsRef.current?.companyId).toBe("c1");

    fireEvent.click(screen.getByText("choose-path"));
    await waitFor(() => expect(screen.getByDisplayValue("/chosen/path")).toBeTruthy());
  });

  it("creates the department via the project-create API and calls onDone with NO onboarding-state advance", async () => {
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "Software", type: "department", functionType: "software_development" }),
    );
    expect(createWorkspace).toHaveBeenCalledWith(
      "proj-software",
      expect.objectContaining({ cwd: "/home/ada/AoA/software" }),
      "c1",
    );
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("creates multiple departments in one submit", async () => {
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByText(/Add department/));
    const nameInputs = screen.getAllByPlaceholderText("Department name");
    fireEvent.change(nameInputs[1], { target: { value: "Marketing" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, "c1", expect.objectContaining({ name: "Software" }));
    expect(create).toHaveBeenNthCalledWith(2, "c1", expect.objectContaining({ name: "Marketing" }));
  });

  it("does not clobber a live edit made mid-submit, and sends the fresh value rather than a stale snapshot", async () => {
    let resolveSoftware: (value: unknown) => void = () => {};
    create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => {
      if (data.name === "Software") {
        return new Promise((resolve) => {
          resolveSoftware = () => resolve({ id: "proj-software", type: data.type, name: data.name });
        });
      }
      return { id: `proj-${(data.name as string).toLowerCase().replace(/\s+/g, "-")}`, type: data.type, name: data.name };
    });

    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByText(/Add department/));
    const nameInputs = screen.getAllByPlaceholderText("Department name");
    fireEvent.change(nameInputs[1], { target: { value: "Marketing" } });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Software's create() is pending (the loop is sequential) — fields
    // must be disabled while submitAll is in flight.
    await waitFor(() => expect((nameInputs[1] as HTMLInputElement).disabled).toBe(true));

    // Edit the second department's name WHILE the first department's
    // create() call is still in flight — i.e. before Marketing's own turn
    // in the sequential loop has started.
    fireEvent.change(nameInputs[1], { target: { value: "Marketing Updated" } });

    resolveSoftware(undefined);

    await waitFor(() => expect(onDone).toHaveBeenCalled());

    // Marketing's create() call must have used the fresh (edited) value —
    // never the value captured back when submitAll started.
    expect(create).toHaveBeenCalledWith("c1", expect.objectContaining({ name: "Marketing Updated" }));
    expect(create).not.toHaveBeenCalledWith("c1", expect.objectContaining({ name: "Marketing" }));

    // The edit must not have been reverted once submission finished.
    expect((nameInputs[1] as HTMLInputElement).value).toBe("Marketing Updated");
    // Fields are re-enabled once submission completes.
    expect((nameInputs[1] as HTMLInputElement).disabled).toBe(false);
  });

  it("does not re-fire onDone (or recreate) if Continue is clicked again after every department already succeeded", async () => {
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Give the (no-op) second submitAll run a tick to complete.
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled());
    expect(create).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — reuses an existing same-named department (no second create)", async () => {
    list.mockResolvedValue([{ id: "existing", type: "department", name: "Software" }]);
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    // Gate on the rootFolder-driven prefill so the department row is fully
    // hydrated (name "Software" + nested localPath) before we submit — the
    // localPath is what `createWorkspace` is asserted with below. `findBy*`
    // has a built-in `waitFor`; once the committed DOM shows the prefilled
    // path, the component's render-time `departmentsRef` mirror is guaranteed
    // in sync too (it used to lag behind a passive effect — see the ref-sync
    // note in DefineDepartments.tsx).
    await screen.findByDisplayValue("/home/ada/AoA/software");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Reuse proven: the existing project id was used and NO second create ran.
    expect(create).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledWith(
      "existing",
      expect.objectContaining({ cwd: "/home/ada/AoA/software" }),
      "c1",
    );
  });

  it("a mid-sequence department failure leaves a retryable per-department state; already-created ones aren't recreated; onDone only fires once all succeed", async () => {
    // Second department (Marketing) fails on its project create call.
    create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => {
      if (data.name === "Marketing") throw new Error("boom");
      return { id: `proj-${(data.name as string).toLowerCase()}`, type: data.type, name: data.name };
    });
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByText(/Add department/));
    const nameInputs = screen.getAllByPlaceholderText("Department name");
    fireEvent.change(nameInputs[1], { target: { value: "Marketing" } });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Software succeeded, Marketing surfaces a retryable error; onDone must NOT fire yet.
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith("c1", expect.objectContaining({ name: "Software" }));

    // Retry Marketing only — Software must not be recreated.
    create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      id: `proj-${(data.name as string).toLowerCase()}`,
      type: data.type,
      name: data.name,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Software's create call count stays at 1 (never re-created); only Marketing's retry adds one more.
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.filter((c) => (c[1] as Record<string, unknown>).name === "Software")).toHaveLength(1);
  });

  it("surfaces a workspace/folder failure without losing the already-created project (idempotent retry)", async () => {
    mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const onDone = vi.fn();
    render(<DefineDepartments companyId="c1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByDisplayValue("/home/ada/AoA/software")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Couldn't create the folder/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    mkdir.mockResolvedValue({ created: true, path: "" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // The project was NOT re-created on retry.
    expect(create).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
});
