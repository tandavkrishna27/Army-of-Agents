/**
 * H7 regression — GET /invites/:token/test-resolution must route its outbound
 * probe through the central SSRF guard (validateAndResolveFetchUrl), so a
 * user-supplied url pointing at cloud-metadata / RFC1918 / loopback is rejected
 * with 400 and NEVER probed. The route is authorized solely by invite-token
 * possession (pre-auth, no board/RBAC), so without the guard it was an
 * unauthenticated blind-SSRF / internal-port-scan oracle.
 *
 * The guard rejects IP-literal private targets without any network/DNS I/O, so
 * these assertions are deterministic and make no outbound request.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// ESM-cycle-safe drizzle operator stubs (the only route exercised here issues a
// single eq()-keyed invite lookup).
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy(
      {},
      { get: (_t, p) => (p === "_" ? { name } : Symbol(`${name}.${String(p)}`)) },
    );
  // Vitest validates named imports against the mock's declared keys, so the
  // tables access.ts imports must be listed explicitly (a bare Proxy namespace
  // fails that check).
  return {
    agentApiKeys: makeTable("agent_api_keys"),
    authUsers: makeTable("auth_users"),
    companies: makeTable("companies"),
    companyMemberships: makeTable("company_memberships"),
    invites: makeTable("invites"),
    joinRequests: makeTable("join_requests"),
  };
});

// The access router constructs these at factory time; stub them so mounting the
// router never touches real DB logic — only the /test-resolution route is under
// test.
vi.mock("../services/index.js", () => ({
  accessService: () => ({ isInstanceAdmin: vi.fn().mockResolvedValue(false) }),
  teamService: () => ({}),
  agentService: () => ({}),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const VALID_INVITE = {
  id: "inv-1",
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
};

function makeDb(invite: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (cb: (rows: unknown[]) => unknown) =>
            Promise.resolve(cb(invite ? [invite] : [])),
        }),
      }),
    }),
  } as any;
}

function makeApp(invite: unknown = VALID_INVITE) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none" };
    next();
  });
  app.use(
    "/api",
    accessRoutes(makeDb(invite), {
      deploymentMode: "authenticated",
      deploymentExposure: "exposed",
      bindHost: "0.0.0.0",
      allowedHostnames: [],
    } as any),
  );
  app.use(errorHandler);
  return app;
}

function probe(app: express.Express, url: string) {
  return request(app).get(
    `/api/invites/tok/test-resolution?url=${encodeURIComponent(url)}`,
  );
}

describe("GET /invites/:token/test-resolution — SSRF guard (H7)", () => {
  it("rejects the cloud-metadata endpoint with 400 (never probes)", async () => {
    const res = await probe(makeApp(), "http://169.254.169.254/latest/meta-data/iam/");
    expect(res.status).toBe(400);
    expect(String(res.body?.error)).toMatch(/SSRF|private|reserved/i);
  });

  it("rejects RFC1918 + loopback targets with 400", async () => {
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://10.0.0.5:8080/",
      "http://192.168.1.1/",
    ]) {
      const res = await probe(makeApp(), url);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a disallowed protocol with 400 before any probe", async () => {
    const res = await probe(makeApp(), "ftp://169.254.169.254/");
    // Caught by the route's http(s)-only check (or the guard) — either way 400.
    expect(res.status).toBe(400);
  });

  it("still 404s for an invalid/expired invite token (auth gate intact)", async () => {
    const res = await probe(makeApp(null), "http://169.254.169.254/");
    expect(res.status).toBe(404);
  });
});
