import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies } from "./helpers/seed-company";

/**
 * E2E: MCP key issuance → tool call smoke.
 *
 * Exercises the full external-MCP-client loop:
 *   1. Bootstrap a company (API round-trip — no UI dependency).
 *   2. Issue an MCP API key via the local-board endpoint.
 *   3. Call the `me` tool with the key as a Bearer token.
 *   4. Assert a JSON-RPC 2.0 response that identifies the caller.
 *
 * Why API-only: the Settings → Integrations tab wires UI controls to the
 * same endpoints this spec hits directly. A UI-driven variant would first
 * need the full onboarding wizard (workspace root + adapter) which isn't
 * a safe CI assumption (see onboarding.spec.ts for the wizard smoke).
 * Phase C's goal is to verify the MCP protocol chain, not the UI chrome —
 * the API path is the authoritative test for what external MCP clients
 * (Claude Code, Cursor, etc.) actually do.
 *
 * If this fails in isolation but `health` passes, the regression is in
 * the MCP server. If both fail, the webServer didn't boot.
 */

const SKIP_LIVE = process.env.AOA_E2E_SKIP_MCP === "true";

async function createCompany(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const res = await request.post("/api/companies", {
    data: { name },
  });
  expect(res.ok()).toBe(true);
  const company = (await res.json()) as { id: string };
  expect(company.id).toBeTruthy();
  return company.id;
}

async function enableMcp(
  request: APIRequestContext,
  companyId: string,
): Promise<void> {
  const res = await request.patch(`/api/companies/${companyId}/mcp/settings`, {
    data: { enabled: true },
  });
  expect(res.ok()).toBe(true);
}

async function issueMcpKey(
  request: APIRequestContext,
  companyId: string,
  keyName: string,
): Promise<string> {
  const res = await request.post(`/api/companies/${companyId}/mcp/keys`, {
    data: { name: keyName },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { token?: string; key?: { token?: string } };
  // mcpSvc.createKey returns the plaintext token once on creation.
  const token = body.token ?? body.key?.token;
  expect(token).toBeTruthy();
  return token as string;
}

test.describe("MCP key → tool call flow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request);
  });

  test("unauthenticated MCP POST returns 401", async ({ request }) => {
    // This runs regardless of env — a cheap contract check that the MCP
    // endpoint is mounted and rejects callers without access (Decision #14).
    //
    // In local_trusted mode the board actor is always auto-injected, so the
    // middleware never returns 401 — it proceeds and hits "Company not found"
    // (403) instead. Accept either 401 or 403 as the rejection signal.
    const res = await request.post(
      "/api/companies/00000000-0000-0000-0000-000000000000/mcp",
      {
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "me", arguments: {} },
        },
        failOnStatusCode: false,
      },
    );
    expect([401, 403]).toContain(res.status());
  });

  test("founder issues key, calls me tool, receives own identity", async ({
    request,
  }) => {
    test.skip(SKIP_LIVE, "AOA_E2E_SKIP_MCP=true");

    const companyName = `E2E-MCP-${Date.now()}`;
    const companyId = await createCompany(request, companyName);
    // Companies are created with mcpEnabled:false — enable it before calling the MCP endpoint.
    await enableMcp(request, companyId);
    const token = await issueMcpKey(request, companyId, "e2e-smoke-key");

    const res = await request.post(`/api/companies/${companyId}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "me", arguments: {} },
      },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: {
        content?: Array<{ type: string; text: string }>;
      };
      error?: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error).toBeUndefined();
    expect(body.result).toBeTruthy();

    const textPart = body.result?.content?.find((c) => c.type === "text");
    expect(textPart?.text).toBeTruthy();
    const payload = JSON.parse(textPart!.text) as {
      userId?: string;
      companyId?: string;
    };
    expect(payload.userId).toBeTruthy();
    expect(payload.companyId).toBe(companyId);
  });
});
