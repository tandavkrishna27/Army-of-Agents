import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAnd, mockEq } = vi.hoisted(() => ({
  mockAnd: vi.fn((..._args: unknown[]) => "and-result"),
  mockEq: vi.fn((..._args: unknown[]) => "eq-result"),
}));

vi.mock("drizzle-orm", () => ({
  and: mockAnd,
  eq: mockEq,
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    companySecrets: makeTable("company_secrets"),
    runtimeProviderKeys: makeTable("runtime_provider_keys"),
  };
});

import { companySecrets, runtimeProviderKeys } from "@armyofagents/db";
import { runtimeProviderKeyService } from "../services/runtime-provider-keys.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(
  config: {
    selects?: MockRow[][];
    inserts?: MockRow[][];
    updates?: MockRow[][];
    deletes?: MockRow[][];
  } = {},
) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;
  const calls = {
    insertValues: [] as unknown[],
    updateSets: [] as unknown[],
  };

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "returning", "orderBy"]) {
      chain[method] = (..._args: unknown[]) => chain;
    }
    chain.values = (value: unknown) => {
      calls.insertValues.push(value);
      return chain;
    };
    chain.set = (value: unknown) => {
      calls.updateSets.push(value);
      return chain;
    };
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    calls,
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
  } as any;
}

const COMPANY = "00000000-0000-4000-8000-000000000001";
const SECRET = "00000000-0000-4000-8000-000000000002";

function makeSecret(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: SECRET,
    companyId: COMPANY,
    status: "active",
    deletedAt: null,
    ...overrides,
  };
}

function makeProviderKey(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "key-1",
    companyId: COMPANY,
    provider: "e2b",
    displayName: "Default E2B",
    secretId: SECRET,
    status: "active",
    isDefault: true,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("runtimeProviderKeyService", () => {
  beforeEach(() => {
    mockAnd.mockClear();
    mockEq.mockClear();
  });

  it("lists provider keys without secret material", async () => {
    const rows = [makeProviderKey()];
    const db = createSequenceDb({ selects: [rows] });

    const result = await runtimeProviderKeyService(db).list(COMPANY);

    expect(result).toEqual(rows);
    expect(result[0]).not.toHaveProperty("value");
    expect(result[0]).not.toHaveProperty("secretValue");
    expect(mockEq).toHaveBeenCalledWith(runtimeProviderKeys.companyId, COMPANY);
  });

  it("creates a default E2B provider key backed by an active company secret", async () => {
    const created = makeProviderKey({ displayName: "Team E2B" });
    const db = createSequenceDb({
      selects: [[makeSecret()]],
      updates: [[]],
      inserts: [[created]],
    });

    const result = await runtimeProviderKeyService(db).create(COMPANY, {
      provider: "e2b",
      displayName: "Team E2B",
      secretId: SECRET,
      isDefault: true,
    });

    expect(result).toEqual(created);
    expect(db.calls.insertValues[0]).toMatchObject({
      companyId: COMPANY,
      provider: "e2b",
      displayName: "Team E2B",
      secretId: SECRET,
      isDefault: true,
      status: "active",
    });
    expect(mockEq).toHaveBeenCalledWith(companySecrets.id, SECRET);
  });

  it("rejects provider keys backed by disabled secrets", async () => {
    const db = createSequenceDb({ selects: [[makeSecret({ status: "disabled" })]] });

    await expect(
      runtimeProviderKeyService(db).create(COMPANY, {
        provider: "e2b",
        displayName: "Disabled",
        secretId: SECRET,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not delete the default provider key", async () => {
    const db = createSequenceDb({ selects: [[makeProviderKey({ isDefault: true })]] });

    await expect(runtimeProviderKeyService(db).remove("key-1")).rejects.toMatchObject({ status: 409 });
  });

  it("resolves default E2B key through secretService at runtime only", async () => {
    const secretSvc = {
      resolveSecretValue: vi.fn(async () => "sk-e2b"),
    };
    const db = createSequenceDb({
      selects: [[makeProviderKey({ isDefault: true })]],
    });

    const value = await runtimeProviderKeyService(db, { secrets: secretSvc as never })
      .resolveCredential(COMPANY, "e2b", { credentialRef: "default" }, {
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        actorType: "system",
        configPath: "runtimeProviderKeys.e2b.default",
      });

    expect(value).toBe("sk-e2b");
    expect(secretSvc.resolveSecretValue).toHaveBeenCalledWith(
      COMPANY,
      SECRET,
      "latest",
      expect.objectContaining({
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        configPath: "runtimeProviderKeys.e2b.default",
      }),
    );
  });
});
