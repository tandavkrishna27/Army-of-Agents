import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("../client", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

import { filesystemApi, companyWorkspaceFsApi } from "../filesystem";

describe("filesystemApi (instance-admin, unchanged)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("browse hits /filesystem/browse", async () => {
    get.mockResolvedValueOnce({ entries: [] });
    await filesystemApi.browse("/tmp", { gitAware: true });
    expect(get).toHaveBeenCalledWith("/filesystem/browse?path=%2Ftmp&gitAware=true");
  });

  it("home hits /filesystem/home", async () => {
    get.mockResolvedValueOnce({ homePath: "/home/x", platform: "linux" });
    await filesystemApi.home();
    expect(get).toHaveBeenCalledWith("/filesystem/home");
  });

  it("mkdir hits /filesystem/mkdir", async () => {
    post.mockResolvedValueOnce({ created: true, path: "/tmp/x" });
    await filesystemApi.mkdir("/tmp/x");
    expect(post).toHaveBeenCalledWith("/filesystem/mkdir", { path: "/tmp/x" });
  });

  it("drives hits /filesystem/drives", async () => {
    get.mockResolvedValueOnce({ drives: [], platform: "linux" });
    await filesystemApi.drives();
    expect(get).toHaveBeenCalledWith("/filesystem/drives");
  });

  it("reveal hits /filesystem/reveal (instance-admin only op)", async () => {
    post.mockResolvedValueOnce({ ok: true });
    await filesystemApi.reveal("/tmp");
    expect(post).toHaveBeenCalledWith("/filesystem/reveal", { path: "/tmp" });
  });
});

describe("companyWorkspaceFsApi (WS0a, company-scoped)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("browse hits /companies/:cid/workspace-fs/browse", async () => {
    get.mockResolvedValueOnce({ entries: [], jailed: true });
    await companyWorkspaceFsApi("company-1").browse("/base/company-1");
    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/workspace-fs/browse?path=%2Fbase%2Fcompany-1",
    );
  });

  it("home hits /companies/:cid/workspace-fs/home", async () => {
    get.mockResolvedValueOnce({ homePath: "/base/company-1", platform: "linux", jailed: true });
    await companyWorkspaceFsApi("company-1").home();
    expect(get).toHaveBeenCalledWith("/companies/company-1/workspace-fs/home");
  });

  it("mkdir hits /companies/:cid/workspace-fs/mkdir", async () => {
    post.mockResolvedValueOnce({ created: true, path: "/base/company-1/x" });
    await companyWorkspaceFsApi("company-1").mkdir("/base/company-1/x");
    expect(post).toHaveBeenCalledWith("/companies/company-1/workspace-fs/mkdir", {
      path: "/base/company-1/x",
    });
  });

  it("drives hits /companies/:cid/workspace-fs/drives", async () => {
    get.mockResolvedValueOnce({ drives: [], platform: "linux", jailed: true });
    await companyWorkspaceFsApi("company-1").drives();
    expect(get).toHaveBeenCalledWith("/companies/company-1/workspace-fs/drives");
  });

  it("does not expose reveal (not part of the WS0a four ops)", () => {
    const scoped = companyWorkspaceFsApi("company-1") as unknown as Record<string, unknown>;
    expect(scoped.reveal).toBeUndefined();
  });

  it("scopes to the given companyId, not a shared instance", async () => {
    get.mockResolvedValue({ homePath: "/base/company-2", platform: "linux", jailed: true });
    await companyWorkspaceFsApi("company-2").home();
    expect(get).toHaveBeenCalledWith("/companies/company-2/workspace-fs/home");
  });
});
