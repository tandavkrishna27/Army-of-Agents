/**
 * Company-level provider key service (Task 7).
 *
 * Three guarantees are load-bearing and each has a dedicated test:
 *
 *   1. BORROWER RESOLUTION. A provider may READ a credential another provider
 *      OWNS (pi -> anthropic, cursor_cloud -> cursor). Saving a key for a
 *      borrower must write the OWNER's secret, because the same env var must
 *      mean the same secret — otherwise saving one silently invalidates the
 *      other.
 *   2. NO AGENT WRITE. Unlike server/src/services/commander-key.ts, this
 *      service writes a COMPANY-LEVEL default only. It must never touch an
 *      agent's adapterConfig.env or create a per-agent env binding.
 *   3. NO RAW KEY ANYWHERE. The pasted value never appears in the audit row,
 *      the return value, or an error message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDescriptor } from "@armyofagents/shared";

const secretsMock = vi.hoisted(() => {
  const state = {
    byName: new Map<string, { id: string; name: string; key: string; value: string; status: string }>(),
    seq: 0,
  };
  const svc = {
    getByName: vi.fn(async (_companyId: string, name: string) => state.byName.get(name) ?? null),
    create: vi.fn(async (_companyId: string, input: { name: string; key?: string | null; value?: string | null }) => {
      if (state.byName.has(input.name)) {
        throw Object.assign(new Error(`Secret already exists: ${input.name}`), { status: 409 });
      }
      const row = {
        id: `sec-${++state.seq}`,
        name: input.name,
        key: input.key ?? "",
        value: input.value ?? "",
        status: "active",
      };
      state.byName.set(input.name, row);
      return row;
    }),
    rotate: vi.fn(async (secretId: string, input: { value: string }) => {
      // Mirrors the real service: rotate appends a version; it NEVER touches status.
      const row = [...state.byName.values()].find((r) => r.id === secretId);
      if (row) row.value = input.value;
      return row ?? null;
    }),
    update: vi.fn(async (secretId: string, patch: { status?: string }) => {
      const row = [...state.byName.values()].find((r) => r.id === secretId);
      if (row && patch.status) row.status = patch.status;
      return row ?? null;
    }),
    // Present so a regression that starts binding env vars to a target is
    // observable rather than silently absent from the mock surface.
    syncEnvBindingsForTarget: vi.fn(async () => {}),
    createBinding: vi.fn(async () => ({ id: "bind-1" })),
  };
  return { state, svc };
});
vi.mock("../services/secrets.js", () => ({ secretService: () => secretsMock.svc }));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

import {
  envVarForProvider,
  keyTargetForDescriptor,
  resolveProviderKeyTarget,
  saveProviderKey,
  secretNameForProvider,
} from "../services/providers/provider-key.js";

/* ─── Mock db: records every write so an agent write is observable ──────── */

type Write = { op: "insert" | "update"; table: string };

function makeDb() {
  const writes: Write[] = [];
  const handle: Record<string, unknown> = {
    insert: (tbl: { _?: { name?: string } }) => {
      writes.push({ op: "insert", table: tbl?._?.name ?? "unknown" });
      return { values: async () => undefined };
    },
    update: (tbl: { _?: { name?: string } }) => {
      writes.push({ op: "update", table: tbl?._?.name ?? "unknown" });
      return { set: () => ({ where: async () => undefined }) };
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Model real atomicity: on throw, roll the in-memory vault back.
      const snapshot = new Map([...secretsMock.state.byName].map(([k, v]) => [k, { ...v }] as const));
      const seq = secretsMock.state.seq;
      try {
        return await fn(handle);
      } catch (err) {
        secretsMock.state.byName.clear();
        for (const [k, v] of snapshot) secretsMock.state.byName.set(k, v);
        secretsMock.state.seq = seq;
        throw err;
      }
    },
  };
  return { db: handle as never, writes };
}

function loggedInput(callIndex: number) {
  return mockLogActivity.mock.calls[callIndex][1] as {
    companyId: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  secretsMock.state.byName.clear();
  secretsMock.state.seq = 0;
});

/* ─── Naming (plan Step 1) ─────────────────────────────────────────────── */

describe("provider key naming", () => {
  it("uses the reserved provider: namespace", () => {
    expect(secretNameForProvider("anthropic")).toBe("provider:anthropic");
  });

  it("maps providers to their env var", () => {
    expect(envVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(envVarForProvider("openai")).toBe("OPENAI_API_KEY");
    expect(envVarForProvider("google")).toBe("GEMINI_API_KEY");
  });

  it("rejects a provider that cannot take an API key", () => {
    expect(() => envVarForProvider("opencode")).toThrow(/does not support an API key/i);
    expect(() => secretNameForProvider("opencode")).toThrow(/does not support an API key/i);
  });

  it("rejects an unknown provider", () => {
    expect(() => envVarForProvider("nope")).toThrow(/unknown provider/i);
    expect(() => secretNameForProvider("nope")).toThrow(/unknown provider/i);
  });

  it("never hardcodes: every catalog provider with an apiKey round-trips through the catalog", async () => {
    const { PROVIDER_CATALOG } = await import("@armyofagents/shared");
    for (const p of PROVIDER_CATALOG) {
      if (!p.credential.apiKey) continue;
      expect(secretNameForProvider(p.id)).toBe(p.credential.apiKey.secretName);
      expect(envVarForProvider(p.id)).toBe(p.credential.apiKey.envVar);
    }
  });
});

/* ─── Borrower resolution (guarantee 1) ────────────────────────────────── */

describe("credential-owner resolution", () => {
  it("resolves a borrower to its owner (pi -> anthropic)", () => {
    const target = resolveProviderKeyTarget("pi");
    expect(target.ownerId).toBe("anthropic");
    expect(target.secretName).toBe("provider:anthropic");
    expect(target.envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("resolves cursor_cloud to cursor", () => {
    const target = resolveProviderKeyTarget("cursor_cloud");
    expect(target.ownerId).toBe("cursor");
    expect(target.secretName).toBe("provider:cursor");
    expect(target.envVar).toBe("CURSOR_API_KEY");
  });

  it("leaves an owner as itself", () => {
    expect(resolveProviderKeyTarget("anthropic").ownerId).toBe("anthropic");
    expect(resolveProviderKeyTarget("openai").ownerId).toBe("openai");
  });

  /**
   * The load-bearing test. The catalog already stores the OWNER's secretName on
   * each borrower entry, so reading the borrower's own spec happens to produce
   * the right answer today — which means an implementation that skips
   * getCredentialOwner would pass every test above. This synthetic borrower
   * declares a DIVERGENT secretName/envVar, so only an implementation that
   * genuinely resolves through the owner gets it right.
   */
  it("reads the OWNER's spec even when the borrower's own spec diverges", () => {
    const divergentBorrower = {
      id: "pi",
      label: "Divergent",
      adapterType: "pi_local",
      kind: "local_cli",
      credential: {
        apiKey: {
          envVar: "WRONG_API_KEY",
          secretName: "provider:WRONG",
          placeholder: "x",
        },
        credentialOwnerId: "anthropic",
        selfCompletingLogin: false,
      },
    } as unknown as ProviderDescriptor;

    const target = keyTargetForDescriptor(divergentBorrower);
    expect(target.ownerId).toBe("anthropic");
    expect(target.secretName).toBe("provider:anthropic");
    expect(target.envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("saving a Pi key writes the anthropic secret, not a pi one", async () => {
    const { db } = makeDb();
    const res = await saveProviderKey(db, {
      companyId: "c1",
      providerId: "pi",
      value: "sk-ant-PI",
      actorUserId: "u1",
    });

    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    const created = secretsMock.svc.create.mock.calls[0][1];
    expect(created.name).toBe("provider:anthropic");
    expect(created.key).toBe("ANTHROPIC_API_KEY");
    expect([...secretsMock.state.byName.keys()]).toEqual(["provider:anthropic"]);
    expect(res.credentialOwnerId).toBe("anthropic");
    expect(res.providerId).toBe("pi");
  });

  it("saving Pi then Claude rotates ONE shared secret (same env var = same secret)", async () => {
    const { db } = makeDb();
    const first = await saveProviderKey(db, { companyId: "c1", providerId: "pi", value: "sk-ant-1", actorUserId: "u1" });
    const second = await saveProviderKey(db, {
      companyId: "c1",
      providerId: "anthropic",
      value: "sk-ant-2",
      actorUserId: "u1",
    });

    expect(second.secretId).toBe(first.secretId);
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.rotate).toHaveBeenCalledTimes(1);
    expect(secretsMock.state.byName.size).toBe(1);
    expect(secretsMock.state.byName.get("provider:anthropic")?.value).toBe("sk-ant-2");
  });

  it("rejects a save for a provider with no API key at all", async () => {
    const { db } = makeDb();
    await expect(
      saveProviderKey(db, { companyId: "c1", providerId: "opencode", value: "x", actorUserId: "u1" }),
    ).rejects.toThrow(/does not support an API key/i);
    expect(secretsMock.svc.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider and an empty value before touching the vault", async () => {
    const { db } = makeDb();
    await expect(
      saveProviderKey(db, { companyId: "c1", providerId: "nope", value: "x", actorUserId: "u1" }),
    ).rejects.toThrow(/unknown provider/i);
    await expect(
      saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "   ", actorUserId: "u1" }),
    ).rejects.toThrow(/value is required/i);
    expect(secretsMock.svc.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

/* ─── create / rotate / reactivate ─────────────────────────────────────── */

describe("create-or-rotate-or-reactivate", () => {
  it("first save CREATES the company-level secret", async () => {
    const { db } = makeDb();
    const res = await saveProviderKey(db, {
      companyId: "c1",
      providerId: "anthropic",
      value: "sk-ant-FIRST",
      actorUserId: "u1",
    });
    expect(res).toMatchObject({ secretId: "sec-1", operation: "created" });
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.rotate).not.toHaveBeenCalled();
    expect(secretsMock.svc.create.mock.calls[0][1]).toMatchObject({
      name: "provider:anthropic",
      key: "ANTHROPIC_API_KEY",
      provider: "local_encrypted",
      managedMode: "aoa_managed",
    });
  });

  it("a second save ROTATES the same secret id instead of 409ing", async () => {
    const { db } = makeDb();
    const first = await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-BAD", actorUserId: "u1" });
    const retry = await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-GOOD", actorUserId: "u1" });

    expect(retry.secretId).toBe(first.secretId);
    expect(retry.operation).toBe("rotated");
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.rotate).toHaveBeenCalledWith(
      first.secretId,
      expect.objectContaining({ value: "sk-ant-GOOD" }),
      expect.anything(),
    );
    expect(secretsMock.state.byName.get("provider:anthropic")?.value).toBe("sk-ant-GOOD");
  });

  it("REACTIVATES a disabled secret BEFORE rotating", async () => {
    const { db } = makeDb();
    const first = await saveProviderKey(db, { companyId: "c1", providerId: "openai", value: "sk-1", actorUserId: "u1" });
    secretsMock.state.byName.get("provider:openai")!.status = "disabled";

    const res = await saveProviderKey(db, { companyId: "c1", providerId: "openai", value: "sk-2", actorUserId: "u1" });
    expect(res).toMatchObject({ secretId: first.secretId, operation: "reactivated" });
    expect(secretsMock.svc.update).toHaveBeenCalledWith(first.secretId, { status: "active" });
    expect(secretsMock.svc.update.mock.invocationCallOrder[0]).toBeLessThan(
      secretsMock.svc.rotate.mock.invocationCallOrder[0],
    );
    const row = secretsMock.state.byName.get("provider:openai");
    expect(row?.status).toBe("active");
    expect(row?.value).toBe("sk-2");
  });

  it("does not write status when the secret is already active", async () => {
    const { db } = makeDb();
    await saveProviderKey(db, { companyId: "c1", providerId: "openai", value: "sk-1", actorUserId: "u1" });
    await saveProviderKey(db, { companyId: "c1", providerId: "openai", value: "sk-2", actorUserId: "u1" });
    expect(secretsMock.svc.update).not.toHaveBeenCalled();
  });

  it("does not assume provider:<id> is the only row for an env var (external bindings coexist)", async () => {
    const { db } = makeDb();
    // A pre-existing Commander/llm binding for the SAME env var must not be
    // rotated, deleted or otherwise disturbed by a company-default save.
    secretsMock.state.byName.set("Commander anthropic API key", {
      id: "sec-pre",
      name: "Commander anthropic API key",
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-COMMANDER",
      status: "active",
    });
    secretsMock.state.byName.set("llm:anthropic", {
      id: "sec-llm",
      name: "llm:anthropic",
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-LLM",
      status: "active",
    });

    const res = await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-NEW", actorUserId: "u1" });
    expect(res.operation).toBe("created");
    expect(secretsMock.state.byName.get("Commander anthropic API key")?.value).toBe("sk-ant-COMMANDER");
    expect(secretsMock.state.byName.get("llm:anthropic")?.value).toBe("sk-ant-LLM");
    expect(secretsMock.svc.rotate).not.toHaveBeenCalled();
  });
});

/* ─── No agent write (guarantee 2) ─────────────────────────────────────── */

describe("company-level only — never touches an agent", () => {
  it("writes NO agent row and creates NO per-agent env binding", async () => {
    const { db, writes } = makeDb();
    await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-X", actorUserId: "u1" });

    expect(secretsMock.svc.syncEnvBindingsForTarget).not.toHaveBeenCalled();
    expect(secretsMock.svc.createBinding).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.table === "agents")).toEqual([]);
    // Nothing at all is written through the raw db handle: the vault goes
    // through secretService and the audit through logActivity.
    expect(writes).toEqual([]);
  });

  it("accepts no agentId in its input contract", async () => {
    const { db, writes } = makeDb();
    await saveProviderKey(db, {
      companyId: "c1",
      providerId: "anthropic",
      value: "sk-ant-Y",
      actorUserId: "u1",
      // @ts-expect-error — agentId is intentionally not part of the contract
      agentId: "agent-1",
    });
    expect(writes.filter((w) => w.table === "agents")).toEqual([]);
    expect(secretsMock.svc.syncEnvBindingsForTarget).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("agent-1");
  });
});

/* ─── Audit + redaction (guarantee 3) ──────────────────────────────────── */

describe("audit trail", () => {
  it("logs provider.key.created with entityId = secretId and NO raw key", async () => {
    const { db } = makeDb();
    const res = await saveProviderKey(db, {
      companyId: "c1",
      providerId: "anthropic",
      value: "sk-ant-SECRETVALUE",
      actorUserId: "u1",
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const input = loggedInput(0);
    expect(input).toMatchObject({
      companyId: "c1",
      actorType: "user",
      actorId: "u1",
      action: "provider.key.created",
      entityType: "secret",
      entityId: res.secretId,
    });
    expect(input.details).toMatchObject({
      providerId: "anthropic",
      credentialOwnerId: "anthropic",
      secretId: res.secretId,
      operation: "created",
    });
    expect(JSON.stringify(input)).not.toContain("sk-ant-SECRETVALUE");
  });

  it("logs provider.key.rotated / provider.key.reactivated", async () => {
    const { db } = makeDb();
    await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-1", actorUserId: "u1" });
    await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-2", actorUserId: "u1" });
    expect(loggedInput(1).action).toBe("provider.key.rotated");

    secretsMock.state.byName.get("provider:anthropic")!.status = "archived";
    await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-3", actorUserId: "u1" });
    expect(loggedInput(2).action).toBe("provider.key.reactivated");
  });

  it("audits the BORROWER's request under the owner's secret", async () => {
    const { db } = makeDb();
    const res = await saveProviderKey(db, { companyId: "c1", providerId: "pi", value: "sk-ant-PI", actorUserId: "u1" });
    const input = loggedInput(0);
    expect(input.entityId).toBe(res.secretId);
    expect(input.details).toMatchObject({ providerId: "pi", credentialOwnerId: "anthropic" });
    expect(JSON.stringify(input)).not.toContain("sk-ant-PI");
  });

  it("never returns the raw key", async () => {
    const { db } = makeDb();
    const res = await saveProviderKey(db, { companyId: "c1", providerId: "google", value: "AIza-RAW", actorUserId: "u1" });
    expect(JSON.stringify(res)).not.toContain("AIza-RAW");
    expect(Object.keys(res).sort()).toEqual(["credentialOwnerId", "envVar", "operation", "providerId", "secretId"]);
  });

  it("no raw key leaks and nothing is audited when the vault write fails", async () => {
    const { db } = makeDb();
    secretsMock.svc.create.mockRejectedValueOnce(new Error("vault down"));
    await expect(
      saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-BOOM", actorUserId: "u1" }),
    ).rejects.toThrow(/vault down/);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(secretsMock.state.byName.size).toBe(0);
  });

  it("a failure AFTER the vault write rolls back — no committed-but-unaudited mutation", async () => {
    const { db } = makeDb();
    mockLogActivity.mockRejectedValueOnce(new Error("audit failed"));
    await expect(
      saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-P", actorUserId: "u1" }),
    ).rejects.toThrow(/audit failed/);
    const committed = secretsMock.state.byName.has("provider:anthropic");
    expect(committed).toBe(false);
  });

  it("runs the whole save in ONE transaction", async () => {
    const { db } = makeDb();
    const spy = vi.spyOn(db as unknown as { transaction: () => unknown }, "transaction");
    await saveProviderKey(db, { companyId: "c1", providerId: "anthropic", value: "sk-ant-T", actorUserId: "u1" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
