import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agentProviderCredentialBindings: makeTableProxy("agent_provider_credential_bindings"),
  companyMemberships: makeTableProxy("company_memberships"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  providerCredentials: makeTableProxy("provider_credentials"),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));
import { markScopedSubscriptionVerified } from "../services/provider-credentials.js";
import { verifyAndBindCommanderSubscriptionCredential } from "../services/provider-credentials.js";
import { resolveAgentSubscriptionEnvironment } from "../services/provider-credential-bindings.js";
import { resolveScopedCliAuthHome } from "../services/cli-auth-topology.js";

const previousProfile = process.env.AOA_INSTALL_PROFILE;
const previousHome = process.env.AOA_HOME;
const previousDeploymentMode = process.env.AOA_DEPLOYMENT_MODE;
const previousUserHome = process.env.HOME;
afterEach(() => {
  if (previousProfile === undefined) delete process.env.AOA_INSTALL_PROFILE;
  else process.env.AOA_INSTALL_PROFILE = previousProfile;
  if (previousHome === undefined) delete process.env.AOA_HOME;
  else process.env.AOA_HOME = previousHome;
  if (previousDeploymentMode === undefined) delete process.env.AOA_DEPLOYMENT_MODE;
  else process.env.AOA_DEPLOYMENT_MODE = previousDeploymentMode;
  if (previousUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousUserHome;
});

function credentialDb() {
  const values = vi.fn(async () => undefined);
  const returning = vi.fn(async () => [{ id: "credential-scoped" }]);
  const db = {
    insert: () => ({ values: (row: unknown) => {
      values(row);
      return { onConflictDoNothing: values };
    } }),
    update: () => ({
      set: () => ({ where: () => ({ returning }) }),
    }),
  };
  return { db: db as never, values, returning };
}

describe("terminal-only subscription credential registration", () => {
  it.each([
    ["openai", ".codex", "auth.json"],
    ["anthropic", ".claude", ".credentials.json"],
  ] as const)("registers a local %s subscription from the canonical CLI home", async (provider, directory, file) => {
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-local-credential-"));
    process.env.AOA_DEPLOYMENT_MODE = "local_trusted";
    process.env.AOA_INSTALL_PROFILE = "local_single_user";
    process.env.AOA_HOME = userHome;
    process.env.HOME = userHome;
    const authHome = path.join(userHome, directory);
    await fs.mkdir(authHome, { recursive: true });
    await fs.writeFile(path.join(authHome, file), "fixture-only");
    const scope = {
      companyId: "company-1",
      userId: "founder-1",
      executionTargetId: "control-plane",
      provider,
    };
    const { db, values } = credentialDb();

    try {
      await expect(markScopedSubscriptionVerified(db, scope)).resolves.toEqual(["credential-scoped"]);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        companyId: "company-1",
        ownerUserId: "founder-1",
        executionTargetId: "control-plane",
        provider,
        kind: "personal_subscription",
      }));
    } finally {
      await fs.rm(userHome, { recursive: true, force: true });
    }
  });

  it("registers and verifies only the exact founder/company/target/provider after scoped evidence exists", async () => {
    const aoaHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-terminal-credential-"));
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_HOME = aoaHome;
    const scope = {
      companyId: "company-1",
      userId: "founder-1",
      executionTargetId: "target-1",
      provider: "anthropic" as const,
    };
    const authHome = resolveScopedCliAuthHome({ ...scope, env: process.env });
    await fs.mkdir(authHome, { recursive: true });
    await fs.writeFile(path.join(authHome, ".credentials.json"), "fixture-only");
    const { db, values } = credentialDb();

    try {
      await expect(markScopedSubscriptionVerified(db, scope)).resolves.toEqual([
        "credential-scoped",
      ]);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        companyId: "company-1",
        ownerUserId: "founder-1",
        executionTargetId: "target-1",
        provider: "anthropic",
        kind: "personal_subscription",
        state: "pending",
      }));
    } finally {
      await fs.rm(aoaHome, { recursive: true, force: true });
    }
  });

  it("does not register a pending subscription when the scoped credential is absent", async () => {
    const aoaHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-terminal-credential-missing-"));
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_HOME = aoaHome;
    const { db, values } = credentialDb();
    try {
      await expect(markScopedSubscriptionVerified(db, {
        companyId: "company-1",
        userId: "founder-1",
        executionTargetId: "target-1",
        provider: "anthropic",
      })).resolves.toEqual([]);
      expect(values).not.toHaveBeenCalled();
    } finally {
      await fs.rm(aoaHome, { recursive: true, force: true });
    }
  });

  it("completes fresh terminal registration, Commander binding, and agent credential resolution", async () => {
    const aoaHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-terminal-lifecycle-"));
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_HOME = aoaHome;
    const authHome = resolveScopedCliAuthHome({
      env: process.env,
      companyId: "company-1",
      userId: "founder-1",
      executionTargetId: "target-1",
      provider: "anthropic",
    });
    await fs.mkdir(authHome, { recursive: true });
    await fs.writeFile(path.join(authHome, ".credentials.json"), "fixture-only");
    const credentialRow = {
      credentialId: "credential-terminal-1",
      credentialCompanyId: "company-1",
      provider: "anthropic",
      ownerUserId: "founder-1",
      executionTargetId: "target-1",
      kind: "personal_subscription",
      state: "verified",
      approvedAt: new Date(),
      bindingRevokedAt: null,
      ownerMembershipStatus: "active",
    };
    const selectResults: unknown[][] = [[{ agentId: "commander-1" }], [], [credentialRow]];
    const insertedCredentials: unknown[] = [];
    const insertedBindings: unknown[] = [];
    const query = (rows: unknown[]) => {
      const chain: Record<string, any> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.leftJoin = () => chain;
      chain.where = () => chain;
      chain.limit = async () => rows;
      chain.set = () => chain;
      chain.values = (value: unknown) => {
        if ((value as { kind?: string })?.kind === "personal_subscription") insertedCredentials.push(value);
        else insertedBindings.push(value);
        return chain;
      };
      chain.onConflictDoNothing = async () => undefined;
      chain.onConflictDoUpdate = () => chain;
      chain.returning = async () => [{ id: insertedBindings.length ? "binding-terminal-1" : "credential-terminal-1" }];
      chain.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return chain;
    };
    const db: Record<string, any> = {
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
      select: () => query(selectResults.shift() ?? []),
      insert: () => query([]),
      update: () => query([{ id: "credential-terminal-1" }]),
      execute: async () => [],
    };

    try {
      const transition = await verifyAndBindCommanderSubscriptionCredential(db as never, {
        companyId: "company-1",
        userId: "founder-1",
        actorUserId: "founder-1",
        executionTargetId: "target-1",
        provider: "anthropic",
      });
      expect(transition).toEqual({
        credentialIds: ["credential-terminal-1"],
        bindingIds: ["binding-terminal-1"],
      });
      expect(insertedCredentials[0]).toMatchObject({
        companyId: "company-1",
        ownerUserId: "founder-1",
        executionTargetId: "target-1",
        provider: "anthropic",
        kind: "personal_subscription",
        state: "pending",
      });
      expect(insertedBindings[0]).toMatchObject({
        companyId: "company-1",
        agentId: "commander-1",
        credentialId: "credential-terminal-1",
        approvedByUserId: "founder-1",
      });

      const agentEnv = await resolveAgentSubscriptionEnvironment(db as never, {
        companyId: "company-1",
        agentId: "commander-1",
        provider: "anthropic",
        executionTargetId: "target-1",
        env: { AOA_HOME: aoaHome },
      });
      expect(agentEnv.CLAUDE_CONFIG_DIR).toBe(authHome);
    } finally {
      await fs.rm(aoaHome, { recursive: true, force: true });
    }
  });
});
