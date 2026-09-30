import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const instanceHome = vi.fn();
const instanceDrives = vi.fn();
const instanceBrowse = vi.fn();
const instanceMkdir = vi.fn();

const scopedHome = vi.fn();
const scopedDrives = vi.fn();
const scopedBrowse = vi.fn();
const scopedMkdir = vi.fn();

const companyWorkspaceFsApiMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/filesystem", () => ({
  filesystemApi: {
    home: (...args: unknown[]) => instanceHome(...args),
    drives: (...args: unknown[]) => instanceDrives(...args),
    browse: (...args: unknown[]) => instanceBrowse(...args),
    mkdir: (...args: unknown[]) => instanceMkdir(...args),
    reveal: vi.fn(),
  },
  companyWorkspaceFsApi: (...args: unknown[]) => companyWorkspaceFsApiMock(...args),
}));

import { FolderBrowserDialog } from "../FolderBrowserDialog";

function renderDialog(props: { companyId?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FolderBrowserDialog
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        companyId={props.companyId}
      />
    </QueryClientProvider>,
  );
}

describe("FolderBrowserDialog — WS0a companyId scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instanceHome.mockResolvedValue({ homePath: "/home/admin", platform: "linux", jailed: false });
    instanceDrives.mockResolvedValue({ drives: [{ name: "/", path: "/" }], platform: "linux" });
    instanceBrowse.mockResolvedValue({
      currentPath: "/home/admin",
      parentPath: "/home",
      homePath: "/home/admin",
      platform: "linux",
      jailed: false,
      entries: [],
    });

    scopedHome.mockResolvedValue({
      homePath: "/base/company-1",
      platform: "win32",
      jailed: true,
    });
    scopedDrives.mockResolvedValue({ drives: [], platform: "win32", jailed: true });
    scopedBrowse.mockResolvedValue({
      currentPath: "/base/company-1",
      // At the jail root — no parent to go up to.
      parentPath: null,
      homePath: "/base/company-1",
      platform: "win32",
      jailed: true,
      entries: [],
    });

    companyWorkspaceFsApiMock.mockImplementation(() => ({
      home: scopedHome,
      drives: scopedDrives,
      browse: scopedBrowse,
      mkdir: scopedMkdir,
    }));
  });

  it("without companyId, uses the instance-admin filesystemApi (unchanged behavior)", async () => {
    renderDialog({});
    await waitFor(() => expect(instanceHome).toHaveBeenCalled());
    await waitFor(() => expect(instanceBrowse).toHaveBeenCalled());
    expect(companyWorkspaceFsApiMock).not.toHaveBeenCalled();
  });

  it("with companyId, uses the company-scoped workspace-fs API", async () => {
    renderDialog({ companyId: "company-1" });
    await waitFor(() => expect(companyWorkspaceFsApiMock).toHaveBeenCalledWith("company-1"));
    await waitFor(() => expect(scopedHome).toHaveBeenCalled());
    await waitFor(() => expect(scopedBrowse).toHaveBeenCalled());
    expect(instanceHome).not.toHaveBeenCalled();
    expect(instanceBrowse).not.toHaveBeenCalled();
  });

  it("hides the drive picker when the company workspace is jailed", async () => {
    renderDialog({ companyId: "company-1" });
    await waitFor(() => expect(scopedBrowse).toHaveBeenCalled());

    // "Go up" is disabled at the jail root even on a win32 platform (which
    // would otherwise trigger the "This PC" drives view).
    const goUpButton = await screen.findByTitle("Go up");
    expect(goUpButton).toBeDisabled();

    expect(screen.queryByText("This PC")).not.toBeInTheDocument();
    expect(scopedDrives).not.toHaveBeenCalled();
  });
});
