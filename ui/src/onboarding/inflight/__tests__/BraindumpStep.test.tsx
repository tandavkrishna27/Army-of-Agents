import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BraindumpStep } from "../BraindumpStep";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../../api/projects", () => ({
  projectsApi: { list },
}));

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../../api/braindump", async () => {
  const actual = await vi.importActual<typeof import("../../../api/braindump")>("../../../api/braindump");
  return {
    ...actual,
    braindumpApi: { submit, listByDepartment: vi.fn(), get: vi.fn(), retry: vi.fn() },
  };
});

const advanceOnboarding = vi.hoisted(() => vi.fn());
vi.mock("../../../api/onboarding", () => ({ advanceOnboarding }));

const uploadAsset = vi.hoisted(() => vi.fn());
vi.mock("../../../api/memoryAssets", () => ({
  memoryAssetsApi: { upload: uploadAsset },
}));

function makeDept(overrides: Record<string, unknown> = {}) {
  return {
    id: "dept-1",
    urlKey: "software",
    name: "Software",
    type: "department",
    functionType: "software_development",
    workspaces: [],
    primaryWorkspace: null,
    ...overrides,
  };
}

describe("BraindumpStep (WS6 — In-flight standalone surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    list.mockResolvedValue([makeDept()]);
    submit.mockResolvedValue({ id: "bd-1", status: "proposed", effectiveStatus: "proposed" });
  });

  it("renders a card per department the founder created (not just company)", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Software" }),
      makeDept({ id: "d2", name: "Marketing", functionType: "marketing" }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByLabelText(/Braindump for Company-wide/i)).toBeInTheDocument();
    expect(await screen.findByText(/^Software$/)).toBeInTheDocument();
    expect(await screen.findByText(/^Marketing$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^\+\s*software$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^\+\s*marketing$/i })).toBeNull();
  });

  it("opens with a company card and a card for every department already created", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Engineering" }),
      makeDept({ id: "d2", name: "Marketing", functionType: "marketing" }),
      makeDept({ id: "d3", name: "Sales", functionType: "sales" }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByLabelText("Braindump for Company-wide")).toBeTruthy();
    expect(await screen.findByLabelText("Braindump for Engineering")).toBeTruthy();
    expect(screen.getByLabelText("Braindump for Marketing")).toBeTruthy();
    expect(screen.getByLabelText("Braindump for Sales")).toBeTruthy();
    // No "+ <department>" chips — every created department already has a card.
    expect(screen.queryByRole("button", { name: /\+\s*engineering/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /\+\s*marketing/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /\+\s*sales/i })).toBeNull();
  });

  it("has no floating add-department menu", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByLabelText("Braindump for Software");

    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("example-prompt chips insert text into the company textarea", async () => {
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
    const textarea = await screen.findByLabelText("Braindump for Company-wide");
    expect((textarea as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /^we value/i }));

    expect((textarea as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
  });

  it("shows a live character count for the company card", async () => {
    list.mockResolvedValue([]); // no department cards, so the count text is unambiguous
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
    const textarea = await screen.findByLabelText("Braindump for Company-wide");

    expect(screen.getByText("0 / 20,000")).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.getByText("5 / 20,000")).toBeTruthy();
  });

  it("renders one dump box per department loaded, with no add step", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Software" }),
      makeDept({ id: "d2", name: "Marketing", functionType: "marketing", primaryWorkspace: null }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("Software")).toBeTruthy();
    expect(screen.getByText("Marketing")).toBeTruthy();
    expect(screen.getByLabelText("Braindump for Software")).toBeTruthy();
    expect(screen.getByLabelText("Braindump for Marketing")).toBeTruthy();
  });

  it("filters out non-department projects — no card rendered for them", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Software" }),
      { id: "p1", name: "Launch Project", type: "project", functionType: null, workspaces: [], primaryWorkspace: null },
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByLabelText("Braindump for Software")).toBeTruthy();
    expect(screen.queryByLabelText("Braindump for Launch Project")).toBeNull();
    expect(screen.queryByText("Launch Project")).toBeNull();
  });

  it("pre-shows a connected repo chip for a software department", async () => {
    list.mockResolvedValue([
      makeDept({
        id: "d1",
        name: "Software",
        primaryWorkspace: { id: "ws1", repoUrl: "https://github.com/acme/product", cwd: null },
      }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("https://github.com/acme/product")).toBeTruthy();
  });

  it("pre-shows a connected local folder chip when there's no repo", async () => {
    list.mockResolvedValue([
      makeDept({
        id: "d1",
        name: "Software",
        primaryWorkspace: { id: "ws1", repoUrl: null, cwd: "/home/ada/AoA/software" },
      }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("/home/ada/AoA/software")).toBeTruthy();
  });

  it("does not show a chip for a non-software department", async () => {
    list.mockResolvedValue([
      makeDept({
        id: "d1",
        name: "Marketing",
        functionType: "marketing",
        primaryWorkspace: { id: "ws1", repoUrl: "https://github.com/acme/product", cwd: null },
      }),
    ]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByText("Marketing")).toBeTruthy();
    expect(screen.queryByText("https://github.com/acme/product")).toBeNull();
  });

  it("submits a braindump per non-empty box with a stable idempotencyKey and calls onDone", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Software" }),
      makeDept({ id: "d2", name: "Marketing", functionType: "marketing" }),
    ]);
    const onDone = vi.fn();
    render(<BraindumpStep companyId="c1" onDone={onDone} />);

    const softwareBox = await screen.findByLabelText("Braindump for Software");
    fireEvent.change(softwareBox, { target: { value: "We use Postgres and Drizzle." } });
    // Marketing box left empty — should NOT be submitted.

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith("c1", {
      scope: "department",
      departmentId: "d1",
      content: "We use Postgres and Drizzle.",
      assetIds: [],
      idempotencyKey: expect.stringContaining("d1:"),
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("resubmitting the same department reuses the same idempotencyKey", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    submit.mockRejectedValueOnce(new Error("network down"));
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const box = await screen.findByLabelText("Braindump for Software");
    fireEvent.change(box, { target: { value: "notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const firstKey = submit.mock.calls[0][1].idempotencyKey;

    submit.mockResolvedValueOnce({ id: "bd-1", status: "proposed", effectiveStatus: "proposed" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const secondKey = submit.mock.calls[1][1].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it("shows a per-box error and a Retry action on submit failure without blocking onDone forever", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", name: "Software" }),
      makeDept({ id: "d2", name: "Marketing", functionType: "marketing" }),
    ]);
    submit.mockImplementation(async (_c: string, input: { departmentId: string }) => {
      if (input.departmentId === "d1") throw new Error("boom");
      return { id: "bd-2", status: "proposed", effectiveStatus: "proposed" };
    });
    const onDone = vi.fn();
    render(<BraindumpStep companyId="c1" onDone={onDone} />);

    fireEvent.change(await screen.findByLabelText("Braindump for Software"), { target: { value: "notes" } });
    fireEvent.change(screen.getByLabelText("Braindump for Marketing"), { target: { value: "more notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/Couldn't save this braindump/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Skip calls onDone without submitting anything", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    const onDone = vi.fn();
    render(<BraindumpStep companyId="c1" onDone={onDone} />);

    await screen.findByLabelText("Braindump for Company-wide");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("Continue with all boxes empty calls onDone without submitting", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    const onDone = vi.fn();
    render(<BraindumpStep companyId="c1" onDone={onDone} />);

    await screen.findByLabelText("Braindump for Company-wide");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(submit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Item 5 / Phase 5d — company-wide scope + file drop.
  // -------------------------------------------------------------------------

  it("renders a company-wide card by default, alongside department cards", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    expect(await screen.findByLabelText("Braindump for Company-wide")).toBeTruthy();
    // Sub-text tells the founder what belongs at each scope.
    expect(screen.getByText(/Vision, mission, values/i)).toBeTruthy();
    expect(await screen.findByLabelText("Braindump for Software")).toBeTruthy();
  });

  it("submits the company card with scope=company and a null departmentId", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const companyBox = await screen.findByLabelText("Braindump for Company-wide");
    fireEvent.change(companyBox, { target: { value: "We optimize for candor." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith("c1", {
      scope: "company",
      departmentId: null,
      content: "We optimize for candor.",
      assetIds: [],
      idempotencyKey: expect.stringContaining("company:"),
    });
  });

  it("uploads a dropped file to the scope's Files folder and submits its assetId", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", urlKey: "software", name: "Software" })]);
    uploadAsset.mockResolvedValue({ asset: { id: "asset-1", fileName: "notes.md" }, jobId: "j1" });
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const zone = await screen.findByLabelText("Attach files for Software");
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(uploadAsset).toHaveBeenCalledTimes(1));
    expect(uploadAsset).toHaveBeenCalledWith("c1", file, {
      departmentId: "d1",
      folderPath: "software/Files",
    });

    // The file alone is enough to submit — no typed text required.
    expect(await screen.findByText("notes.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ scope: "department", departmentId: "d1", assetIds: ["asset-1"] }),
    );
  });

  it("company-card uploads carry no departmentId and land in Company/Files", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    uploadAsset.mockResolvedValue({ asset: { id: "asset-2", fileName: "brand.pdf" }, jobId: "j2" });
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const zone = await screen.findByLabelText("Attach files for Company-wide");
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["x"], "brand.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(uploadAsset).toHaveBeenCalledTimes(1));
    expect(uploadAsset.mock.calls[0][2]).toEqual({ folderPath: "Company/Files" });
  });

  it("blocks Continue while an upload is still in flight", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    let resolveUpload: (v: unknown) => void = () => {};
    uploadAsset.mockImplementation(() => new Promise((r) => { resolveUpload = r; }));
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const zone = await screen.findByLabelText("Attach files for Software");
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["x"], "notes.md", { type: "text/markdown" })] },
    });

    // Submitting here would drop the file the founder just added — or treat
    // the card as empty and advance, orphaning the finished upload.
    const button = await screen.findByRole("button", { name: "Uploading…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveUpload({ asset: { id: "asset-1", fileName: "notes.md" }, jobId: "j1" });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy());
    expect(submit).not.toHaveBeenCalled();
  });

  it("surfaces an upload failure without attaching anything", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    uploadAsset.mockRejectedValue(new Error("Unsupported file type: application/x-msdownload"));
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);

    const zone = await screen.findByLabelText("Attach files for Software");
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["x"], "virus.exe", { type: "application/x-msdownload" })] },
    });

    expect(await screen.findByText(/Unsupported file type/)).toBeTruthy();
    // Nothing to submit — an errored upload must not become an assetId.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submit).not.toHaveBeenCalled());
  });

  it("never calls advanceOnboarding — domain-only surface", async () => {
    list.mockResolvedValue([makeDept({ id: "d1", name: "Software" })]);
    render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByLabelText("Braindump for Company-wide");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("does not imply the Librarian reads the connected repo", async () => {
    list.mockResolvedValue([
      makeDept({ id: "d1", urlKey: "software", name: "Software",
        primaryWorkspace: { id: "ws1", repoUrl: "https://github.com/acme/product", cwd: null } }),
    ]);
    const { container } = render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
    await screen.findByText("https://github.com/acme/product");
    expect(container.textContent).toMatch(/not read yet/i);
  });
});
