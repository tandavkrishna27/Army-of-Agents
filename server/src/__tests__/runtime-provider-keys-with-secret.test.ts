// Contract/unit proof for the ATOMIC combined create (runtimeProviderKeyService
// .createWithSecret): it creates the company secret first, then the provider key
// bound to that secret's id, both inside ONE db.transaction. The rollback arm
// forces the provider-key insert to throw and asserts the call rejects while the
// secret create had already run — i.e. a NON-transactional version would leave an
// orphan secret. The DB-level "no orphan persists" proof lives in the sibling
// integration test (runtime-provider-keys-with-secret.integration.test.ts).
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

const secretCreateSpy = vi.fn();
vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({ create: secretCreateSpy })),
}));

import { runtimeProviderKeys } from "@armyofagents/db";
import { runtimeProviderKeyService } from "../services/runtime-provider-keys.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(
  config: {
    selects?: MockRow[][];
    inserts?: MockRow[][];
    updates?: MockRow[][];
    insertThrows?: boolean;
  } = {},
) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const calls = {
    insertValues: [] as unknown[],
    updateSets: [] as unknown[],
    transactions: 0,
  };

  function makeChain(getResult: () => MockRow[], opts: { throws?: boolean } = {}) {
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
    chain.then = (resolve: (value: MockRow[]) => unknown, reject?: (err: unknown) => unknown) => {
      if (opts.throws) {
        const err = Object.assign(new Error("provider-key insert failed"), { code: "23502" });
        return reject ? Promise.resolve(reject(err)) : Promise.reject(err);
      }
      return Promise.resolve(resolve(getResult()));
    };
    return chain;
  }

  const db: Record<string, unknown> = {
    calls,
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) =>
      makeChain(() => config.inserts?.[insertIdx++] ?? [], { throws: config.insertThrows }),
    update: (..._args: unknown[]) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => unknown) => {
      calls.transactions += 1;
      // Passing the same handle as the "tx" mirrors a real savepoint: the inner
      // secretService(tx)/runtimeProviderKeyService(tx) writes ride the outer txn.
      return fn(db);
    },
  };
  return db as any;
}

const COMPANY = "00000000-0000-4000-8000-000000000001";
const SECRET = "00000000-0000-4000-8000-000000000002";

function makeSecret(overrides: Partial<MockRow> = {}): MockRow {
  return { id: SECRET, companyId: COMPANY, status: "active", deletedAt: null, ...overrides };
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
    ...overrides,
  };
}

describe("runtimeProviderKeyService.createWithSecret", () => {
  beforeEach(() => {
    mockAnd.mockClear();
    mockEq.mockClear();
    secretCreateSpy.mockReset();
  });

  it("creates the secret then the provider key bound to it, inside one transaction", async () => {
    secretCreateSpy.mockResolvedValue(makeSecret());
    const created = makeProviderKey({ displayName: "Prod E2B" });
    const db = createSequenceDb({
      selects: [[makeSecret()]], // assertSecret
      updates: [[]], // clearDefault (isDefault true)
      inserts: [[created]], // provider-key insert
    });

    const actor = { userId: "user-1", agentId: null };
    const result = await runtimeProviderKeyService(db).createWithSecret(
      COMPANY,
      {
        provider: "e2b",
        displayName: "Prod E2B",
        value: "e2b_live_secret",
        isDefault: true,
      },
      actor,
    );

    expect(db.calls.transactions).toBe(1);
    // ★ Codex P1: the actor is threaded to secretService.create so the generated
    // secret carries its creator (createdByUserId), not NULL.
    expect(secretCreateSpy).toHaveBeenCalledWith(
      COMPANY,
      { name: "Prod E2B", value: "e2b_live_secret", provider: "local_encrypted" },
      actor,
    );
    expect(db.calls.insertValues[0]).toMatchObject({
      companyId: COMPANY,
      provider: "e2b",
      displayName: "Prod E2B",
      secretId: SECRET,
      isDefault: true,
      status: "active",
    });
    // Returns BOTH rows so the route can audit secret.created + rpk.created.
    expect(result.providerKey).toEqual(created);
    expect(result.secret).toMatchObject({ id: SECRET });
  });

  it("uses secretName for the secret when provided, and displayName for the key", async () => {
    secretCreateSpy.mockResolvedValue(makeSecret());
    const db = createSequenceDb({
      selects: [[makeSecret()]],
      updates: [[]],
      inserts: [[makeProviderKey()]],
    });

    const actor = { userId: "user-2", agentId: null };
    await runtimeProviderKeyService(db).createWithSecret(
      COMPANY,
      {
        provider: "e2b",
        displayName: "Team E2B",
        value: "e2b_live_secret",
        isDefault: true,
        secretName: "E2B_PROD_KEY",
      },
      actor,
    );

    expect(secretCreateSpy).toHaveBeenCalledWith(
      COMPANY,
      { name: "E2B_PROD_KEY", value: "e2b_live_secret", provider: "local_encrypted" },
      actor,
    );
  });

  it("rolls back (rejects) when the provider-key insert throws, after the secret was created", async () => {
    secretCreateSpy.mockResolvedValue(makeSecret());
    const db = createSequenceDb({
      selects: [[makeSecret()]],
      updates: [[]],
      insertThrows: true,
    });

    await expect(
      runtimeProviderKeyService(db).createWithSecret(COMPANY, {
        provider: "e2b",
        displayName: "Prod E2B",
        value: "e2b_live_secret",
        isDefault: true,
      }),
    ).rejects.toThrow(/provider-key insert failed/);

    // The secret create HAD already run: a naive non-transactional version would
    // now leave an orphan secret. Because the failing insert ran INSIDE the
    // transaction, the DB rollback discards it (asserted for real in the
    // integration test). Structural guarantee here: exactly one transaction.
    expect(secretCreateSpy).toHaveBeenCalledTimes(1);
    expect(db.calls.transactions).toBe(1);
  });

  it("surfaces a duplicate-name conflict from secretService.create unchanged (clean 409)", async () => {
    secretCreateSpy.mockRejectedValue(Object.assign(new Error("Secret already exists: E2B"), { status: 409 }));
    const db = createSequenceDb({});

    await expect(
      runtimeProviderKeyService(db).createWithSecret(COMPANY, {
        provider: "e2b",
        displayName: "E2B",
        value: "e2b_live_secret",
        isDefault: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // No provider-key insert attempted when the secret step already conflicts.
    expect(db.calls.insertValues).toHaveLength(0);
  });
});
