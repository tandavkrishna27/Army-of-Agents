// Verifies that the URL/GitHub fetch helpers in company-portability and
// company-skills services route through the shared SSRF guard
// (validateAndResolveFetchUrl + executePinnedRequest from outbound-url-guard.ts).
//
// Threat model: an authenticated user supplies an arbitrary URL via
//   POST /companies/import/preview
//   POST /companies/import (URL or GitHub source)
//   POST /companies/:cid/skills/import
// If the helper called raw fetch(), it would happily fetch
// http://169.254.169.254/... (cloud metadata IMDS), file:///etc/passwd (proto
// abuse), or http://10.0.0.1/... (lateral RFC-1918 reach) and surface the
// response to the caller. Same threat model as the http adapter SSRF closed
// in PR #149.

import { createServer } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// Mock drizzle-orm to break the ESM cycle between vitest's module loader
// and the real drizzle package. See server/src/__tests__/helpers/drizzle-mock.ts.
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// company-portability.ts and company-skills.ts both pull in the full service
// graph at top-level (agents, projects, issues, routines, secrets, ...) which
// transitively imports heartbeat.ts, memory.ts, etc — those modules eagerly
// destructure tables from @armyofagents/db. We have to enumerate every table
// the chain touches; vitest validates `import { X } from "@armyofagents/db"`
// against the mock's enumerable keys, so a generic Proxy isn't enough.
// Each entry returns a makeTableProxy so column accesses (table.colName) yield
// stable Symbol stand-ins suitable for Drizzle's tagged-template builders.
vi.mock("@armyofagents/db", () => {
  const tables: Record<string, unknown> = {};
  const names = [
    "activityLog", "agentApiKeys", "agentConfigRevisions", "agentProjects",
    "agentRuntimeState", "agentTaskSessions", "agentTrustScores",
    "agentWakeupRequests", "agents", "approvalComments", "approvals",
    "artifactVersions", "artifacts", "assets", "authAccounts", "authSessions",
    "authUsers", "authVerifications", "boardApiKeys", "briefItems", "briefs",
    "budgetIncidents", "budgetPolicies", "cliAuthChallenges", "companies",
    "companyMemberships", "companySecretVersions", "companySecrets",
    "companySkills", "costEvents", "debriefs", "discussionAnnotations",
    "discussionAnnotationsRelations", "discussionEntries",
    "discussionEntriesRelations", "discussionExtractedItems",
    "discussionExtractedItemsRelations", "discussions", "discussionsRelations",
    "documentRevisions", "documents", "executionWorkspaces", "feedbackExports",
    "feedbackVotes", "fileImportJobs", "financeEvents", "goals",
    "heartbeatRunEvents", "heartbeatRunWatchdogDecisions", "heartbeatRuns",
    "inboxDismissals", "instanceSettings", "instanceUserRoles",
    "internalAgentConfig", "internalAgentConfigRelations",
    "internalAgentConversations", "internalAgentConversationsRelations",
    "internalAgentMessages", "internalAgentMessagesRelations",
    "internalAgentReminders", "internalAgentRemindersRelations",
    "internalAgentRuns", "internalAgentRunsRelations", "invites",
    "issueApprovals", "issueAttachments", "issueComments", "issueDocuments",
    "issueLabels", "issueReadStates", "issues", "joinRequests", "labels",
    "marketplaceCatalogCache", "marketplaceCompanySettings",
    "marketplaceInstallOperations", "marketplacePendingUpdates", "mcpApiKeys",
    "mcpClientConnections", "memoryAssets", "memoryExtractionBatches",
    "memoryExtractions", "memoryFeedbackPatterns", "memoryFolders",
    "memoryItemVersions", "memoryItems", "memoryRelations", "memoryRetrievals",
    "notifications", "notificationsRelations", "pluginCompanySettings",
    "pluginConfig", "pluginEntities", "pluginJobRuns", "pluginJobs",
    "pluginLogs", "pluginState", "pluginVersionSnapshots",
    "pluginWebhookDeliveries", "plugins", "principalPermissionGrants",
    "projectGoals", "projectWorkspaces", "projects", "providerQuotaWindows",
    "routineRuns", "routineTriggers", "routines", "sidebarPreferences",
    "suggestions", "taskDependencies", "teamCoordinations", "teamMembers",
    "teams", "userRoles", "workflowTemplates", "workflowTemplatesRelations",
    "workspaceOperations", "workspaceRuntimeServices",
  ];
  for (const name of names) tables[name] = makeTableProxy(name);
  return {
    ...tables,
    // Non-table exports the modules touch via factory invocation. None of these
    // are called in the test path, but they need to exist so import-time
    // destructuring doesn't fail.
    createDb: () => ({}),
    ensurePostgresDatabase: () => undefined,
    inspectMigrations: () => undefined,
    applyPendingMigrations: () => undefined,
    reconcilePendingMigrationHistory: () => undefined,
    migratePostgresIfEmpty: () => undefined,
    runDatabaseBackup: () => undefined,
    formatDatabaseBackupResult: () => undefined,
    pruneOldBackups: () => undefined,
  };
});

const companySkillsTestPromise = import("../services/company-skills.js").then((mod) => mod.__test__);

describe("company-portability fetch helpers — SSRF guard", () => {
  let companyPortabilityTest: typeof import("../services/company-portability.js").__test__;

  beforeAll(async () => {
    companyPortabilityTest = (await import("../services/company-portability.js")).__test__;
  });

  it("fetchJson rejects link-local cloud-metadata IP (169.254.169.254)", async () => {
    await expect(
      companyPortabilityTest.fetchJson("http://169.254.169.254/latest/meta-data/iam/"),
    ).rejects.toThrow(/private/);
  });

  it("fetchText rejects file:// (disallowed protocol)", async () => {
    await expect(
      companyPortabilityTest.fetchText("file:///etc/passwd"),
    ).rejects.toThrow(/Disallowed protocol/);
  });

  it("fetchText rejects javascript: (disallowed protocol)", async () => {
    await expect(
      companyPortabilityTest.fetchText("javascript:alert(1)"),
    ).rejects.toThrow(/Disallowed protocol/);
  });

  it("fetchText rejects RFC-1918 literal (10.0.0.1)", async () => {
    await expect(
      companyPortabilityTest.fetchText("http://10.0.0.1/some/path"),
    ).rejects.toThrow(/private/);
  });
});

describe("company-skills fetch helpers — SSRF guard", () => {
  it("fetchText rejects RFC-1918 literal (10.0.0.1)", async () => {
    const companySkillsTest = await companySkillsTestPromise;
    await expect(
      companySkillsTest.fetchText("http://10.0.0.1/some/SKILL.md"),
    ).rejects.toThrow(/private/);
  });

  it("fetchJson rejects link-local cloud-metadata IP (169.254.169.254)", async () => {
    const companySkillsTest = await companySkillsTestPromise;
    await expect(
      companySkillsTest.fetchJson("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private/);
  });

  it("fetchText rejects file:// (disallowed protocol)", async () => {
    const companySkillsTest = await companySkillsTestPromise;
    await expect(
      companySkillsTest.fetchText("file:///etc/passwd"),
    ).rejects.toThrow(/Disallowed protocol/);
  });

  it("fetchText rejects IPv6 loopback ([::1])", async () => {
    const companySkillsTest = await companySkillsTestPromise;
    await expect(
      companySkillsTest.fetchText("http://[::1]/SKILL.md"),
    ).rejects.toThrow(/private/);
  });
});

// The happy-path tests run in a separate describe block so the
// outbound-url-guard mock can isolate them — the rejection tests above need
// the REAL validate gate to fire. We use vi.doMock + vi.resetModules so the
// stub only applies to these specific cases without affecting the earlier
// tests in the same file.
describe("fetch helpers — happy path with pinned IP", () => {
  it("company-portability fetchText returns body when target resolves cleanly", async () => {
    let seenHost: string | undefined;
    const server = createServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("portability-pinned-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    vi.resetModules();
    vi.doMock("../services/outbound-url-guard.js", async () => {
      const actual = await vi.importActual<typeof import("../services/outbound-url-guard.js")>(
        "../services/outbound-url-guard.js",
      );
      return {
        ...actual,
        validateAndResolveFetchUrl: async () => ({
          parsedUrl: new URL(`http://example.test:${port}/manifest.json`),
          resolvedAddress: "127.0.0.1",
          hostHeader: `example.test:${port}`,
          tlsServername: undefined,
          useTls: false,
        }),
      };
    });

    try {
      const { __test__ } = await import("../services/company-portability.js");
      const body = await __test__.fetchText(`http://example.test:${port}/manifest.json`);
      expect(body).toBe("portability-pinned-ok");
      // Wire-level proof of DNS-rebind defense: connect went to 127.0.0.1
      // (server.listen address) but the Host header still carries the
      // original hostname, which is how virtual-host routing + TLS SNI work
      // when the validated target is pinned to its resolved IP.
      expect(seenHost).toBe(`example.test:${port}`);
    } finally {
      server.close();
      vi.doUnmock("../services/outbound-url-guard.js");
      vi.resetModules();
    }
  });

  it("company-skills fetchText sends User-Agent header and returns body, returns null on 404", async () => {
    let seenUserAgent: string | undefined;
    const server = createServer((req, res) => {
      seenUserAgent = req.headers["user-agent"];
      if (req.url === "/missing") {
        res.writeHead(404);
        res.end("not found");
      } else {
        res.writeHead(200, { "content-type": "text/markdown" });
        res.end("# SKILL\n\npinned-skill-content");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    vi.resetModules();
    vi.doMock("../services/outbound-url-guard.js", async () => {
      const actual = await vi.importActual<typeof import("../services/outbound-url-guard.js")>(
        "../services/outbound-url-guard.js",
      );
      return {
        ...actual,
        validateAndResolveFetchUrl: async (urlStr: string) => {
          const parsed = new URL(urlStr);
          return {
            parsedUrl: new URL(`http://example.test:${port}${parsed.pathname}`),
            resolvedAddress: "127.0.0.1",
            hostHeader: `example.test:${port}`,
            tlsServername: undefined,
            useTls: false,
          };
        },
      };
    });

    try {
      const { __test__ } = await import("../services/company-skills.js");
      const ok = await __test__.fetchText("http://example.test/SKILL.md");
      expect(ok).toBe("# SKILL\n\npinned-skill-content");

      // GitHub requires a User-Agent header and returns 403 without one.
      // Node's https.request does not add one automatically, so fetchText
      // must set it explicitly (regression guard for the SSRF-guard rewrite).
      expect(seenUserAgent).toBe("ArmyOfAgents/1.0");

      // The skills helpers are intentionally fail-soft on ordinary HTTP
      // failures (a missing GitHub blob, stale raw URL, etc.) — only SSRF
      // guard violations are escalated to thrown errors. Otherwise the
      // install-update flow would start surfacing 500s for routine "tracked
      // ref no longer exists" cases.
      const missing = await __test__.fetchText("http://example.test/missing");
      expect(missing).toBeNull();
    } finally {
      server.close();
      vi.doUnmock("../services/outbound-url-guard.js");
      vi.resetModules();
    }
  });
});
