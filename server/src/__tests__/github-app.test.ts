import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock @octokit/auth-app ────────────────────────────────────────────────
const mockCreateInstallationAccessToken = vi.hoisted(() => vi.fn());
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => mockCreateInstallationAccessToken),
}));

// ── mock @octokit/rest ────────────────────────────────────────────────────
const mockOctokit = vi.hoisted(() => ({
  apps: { listReposAccessibleToInstallation: vi.fn() },
  // octokit.paginate(endpoint, params) calls the endpoint and flattens the
  // result; for listReposAccessibleToInstallation that's the `repositories` array.
  paginate: vi.fn(async (fn: (p: unknown) => Promise<{ data: { repositories?: unknown[] } }>, params: unknown) => {
    const res = await fn(params);
    return res.data.repositories ?? [];
  }),
}));
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

// ── mock DB ───────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const returningFn = vi.fn().mockResolvedValue([]);
  const values = vi.fn(() => ({ returning: returningFn }));
  const insert = vi.fn(() => ({ values }));

  // deleteWhere returns a promise-like so `await db.delete(table).where(cond)` resolves
  const deleteWhere = vi.fn().mockResolvedValue([]);
  // Drizzle uses `db.delete()` — the key MUST be the string "delete" (reserved word)
  const deleteMethod = vi.fn(() => ({ where: deleteWhere }));

  return {
    select, from, where, limit,
    insert, values, returningFn,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    delete: deleteMethod,
    deleteWhere,
  };
});

import {
  getInstallation,
  saveInstallation,
  removeInstallation,
  mintInstallationToken,
  getInstallUrl,
  listInstallationRepositories,
} from "../services/github-app.js";

describe("getInstallUrl", () => {
  it("returns GitHub App installation URL containing the slug and state", () => {
    process.env.GITHUB_APP_SLUG = "my-aoa-app";
    const url = getInstallUrl("company-abc");
    expect(url).toContain("github.com/apps/my-aoa-app/installations/new");
    expect(url).toContain("state=company-abc");
    // Must NOT be the OAuth authorize URL
    expect(url).not.toContain("login/oauth/authorize");
  });

  it("throws when GITHUB_APP_SLUG is not set", () => {
    delete process.env.GITHUB_APP_SLUG;
    expect(() => getInstallUrl("company-abc")).toThrow("GITHUB_APP_SLUG");
  });
});

describe("saveInstallation", () => {
  it("upserts an installation row", async () => {
    mockDb.returningFn.mockResolvedValue([{
      id: "inst-1",
      companyId: "company-1",
      installationId: "12345",
      accountLogin: "myorg",
      accountType: "Organization",
      githubHost: "github.com",
    }]);

    const result = await saveInstallation(mockDb as any, {
      companyId: "company-1",
      installationId: "12345",
      accountLogin: "myorg",
      accountType: "Organization",
    });

    // upsert = delete-then-insert — both must be called
    expect(mockDb.delete).toHaveBeenCalled();
    expect(mockDb.insert).toHaveBeenCalled();
    expect(result.installationId).toBe("12345");
  });
});

describe("getInstallation", () => {
  it("returns null when no installation exists", async () => {
    mockDb.limit.mockResolvedValue([]);
    const result = await getInstallation(mockDb as any, "company-1");
    expect(result).toBeNull();
  });

  it("returns the installation when it exists", async () => {
    mockDb.limit.mockResolvedValue([{ id: "inst-1", installationId: "12345", accountLogin: "myorg", suspendedAt: null }]);
    const result = await getInstallation(mockDb as any, "company-1");
    expect(result?.installationId).toBe("12345");
  });

  it("returns null for suspended installations", async () => {
    mockDb.limit.mockResolvedValue([{ id: "inst-1", installationId: "12345", accountLogin: "myorg", suspendedAt: new Date() }]);
    const result = await getInstallation(mockDb as any, "company-1");
    expect(result).toBeNull();
  });
});

describe("mintInstallationToken", () => {
  it("calls createAppAuth and returns token", async () => {
    mockCreateInstallationAccessToken.mockResolvedValue({ token: "ghs_installation_token" });
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY_PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----";

    const token = await mintInstallationToken("12345");
    expect(token).toBe("ghs_installation_token");
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ type: "installation" }),
    );
  });
});

describe("listInstallationRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and does not mint a token when no installation exists", async () => {
    mockDb.limit.mockResolvedValue([]); // getInstallation → null

    const result = await listInstallationRepositories(mockDb as any, "company-1");

    expect(result).toEqual([]);
    expect(mockCreateInstallationAccessToken).not.toHaveBeenCalled();
    expect(mockOctokit.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
  });

  it("maps the accessible repositories when an installation exists", async () => {
    mockDb.limit.mockResolvedValue([
      { id: "inst-1", installationId: "12345", accountLogin: "myorg", suspendedAt: null },
    ]);
    mockCreateInstallationAccessToken.mockResolvedValue({ token: "ghs_token" });
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY_PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----";
    mockOctokit.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: {
        repositories: [
          { name: "r", full_name: "o/r", private: true, html_url: "u" },
        ],
      },
    });

    const result = await listInstallationRepositories(mockDb as any, "company-1");

    expect(result).toEqual([
      { name: "r", fullName: "o/r", private: true, url: "u" },
    ]);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ type: "installation", installationId: "12345" }),
    );
  });
});
