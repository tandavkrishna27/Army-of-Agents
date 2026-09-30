import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
}));
vi.mock("../middleware/rbac.js", () => ({ assertRole: vi.fn(async () => {}) }));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));

/**
 * Stateful secrets vault. Each DISTINCT provider name creates its own secret id,
 * so an anthropic save and an openai save yield DIFFERENT `secret_ref`s — the
 * whole point of the lost-update test. `syncEnvBindingsForTarget` records the env
 * it is handed so we can assert the union survived (nothing deleted).
 *
 * persistCommanderApiKey and the route's `writeSecret` closure are NOT mocked —
 * this drives the merge end-to-end through the real route + real service.
 */
const secretsMock = vi.hoisted(() => {
  const state = {
    byName: new Map<string, { id: string; name: string; value: string; status: string }>(),
    seq: 0,
    syncCalls: [] as Record<string, unknown>[],
  };
  const svc = {
    getByName: vi.fn(async (_companyId: string, name: string) => state.byName.get(name) ?? null),
    create: vi.fn(async (_companyId: string, input: { name: string; value: string }) => {
      const row = { id: `sec-${++state.seq}`, name: input.name, value: input.value, status: "active" };
      state.byName.set(input.name, row);
      return row;
    }),
    rotate: vi.fn(async (id: string, input: { value: string }) => {
      const row = [...state.byName.values()].find((r) => r.id === id);
      if (row) row.value = input.value;
      return row ?? null;
    }),
    update: vi.fn(async (id: string, patch: { status?: string }) => {
      const row = [...state.byName.values()].find((r) => r.id === id);
      if (row && patch.status) row.status = patch.status;
      return row ?? null;
    }),
    syncEnvBindingsForTarget: vi.fn(
      async (_companyId: string, _target: unknown, env: Record<string, unknown>) => {
        // The real service DELETES every env.* binding absent from `env`. Record
        // the env each call receives so a test can prove the second save handed
        // over the full union (so nothing legitimate was deleted).
        state.syncCalls.push(env);
      },
    ),
  };
  return { state, svc };
});
vi.mock("../services/secrets.js", () => ({ secretService: () => secretsMock.svc }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));

import { errorHandler } from "../middleware/error-handler.js";
import { commanderKeyRoutes } from "../routes/commander-key.js";

/**
 * DB mock that models a concurrent overlap deterministically:
 *   - `state.live`  = the committed agents.adapterConfig (mutated by UPDATE).
 *   - `stale`       = a FROZEN snapshot representing what a pre-serialization-
 *                     boundary read sees during an overlap (never updated).
 *
 * The agents `.limit()` path (the OLD pre-tx read) serves the STALE snapshot;
 * the agents `.for("update")` path (the FIX — read inside the tx under a row
 * lock) serves the LIVE committed config. Requests run sequentially, but which
 * read source feeds the merge is exactly what separates the bug from the fix.
 */
function makeDb(opts?: { staleConfig?: Record<string, unknown> }) {
  const state = { live: {} as Record<string, unknown>, forCalls: [] as unknown[][] };
  const stale = opts?.staleConfig ?? {};
  const handle: Record<string, unknown> = {
    select: () => ({
      from: (tbl: { _: { name: string } }) => ({
        where: () => ({
          limit: async () =>
            tbl._.name === "internal_agent_config" ? [{ agentId: "cmd" }] : [{ adapterConfig: stale }],
          for: (...args: unknown[]) => {
            state.forCalls.push(args);
            return Promise.resolve([{ adapterConfig: state.live }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (v: { adapterConfig: Record<string, unknown> }) => ({
        where: async () => {
          state.live = v.adapterConfig;
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
  };
  return { handle, state };
}

function makeApp(handle: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = { type: "board", userId: "u1" };
    next();
  });
  app.use("/api", commanderKeyRoutes(handle as never));
  app.use(errorHandler);
  return app;
}
const url = "/api/companies/c1/internal-agent/commander-key";

describe("POST commander-key concurrent multi-provider saves (Codex round-12 P2 lost-update)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsMock.state.byName.clear();
    secretsMock.state.seq = 0;
    secretsMock.state.syncCalls.length = 0;
  });

  it("two overlapping saves for DIFFERENT providers both keep their secret_ref (union survives, nothing clobbered)", async () => {
    const { handle, state } = makeDb();
    const app = makeApp(handle);

    const a = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-A" });
    expect(a.status).toBe(200);
    const b = await request(app).post(url).send({ provider: "openai", value: "sk-oai-B" });
    expect(b.status).toBe(200);

    // FINAL committed adapterConfig.env must carry BOTH providers' secret_refs.
    // OLD (pre-tx read): B merged onto the STALE {} snapshot, so its write
    // REPLACED the whole config and dropped ANTHROPIC_API_KEY → RED. FIXED
    // (in-tx locked read): B read A's committed config and merged OPENAI on top.
    const env = (state.live.env ?? {}) as Record<string, { type?: string; secretId?: string }>;
    expect(env.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref" });
    expect(env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref" });
    // Distinct vault secrets — neither request reused the other's id.
    expect(env.ANTHROPIC_API_KEY.secretId).not.toBe(env.OPENAI_API_KEY.secretId);

    // The second save's binding sync saw the full union, so it deletes nothing.
    const lastSyncEnv = secretsMock.state.syncCalls.at(-1) as Record<string, unknown>;
    expect(lastSyncEnv).toHaveProperty("ANTHROPIC_API_KEY");
    expect(lastSyncEnv).toHaveProperty("OPENAI_API_KEY");
  });

  it("merges against the config read INSIDE the tx (locked), not a stale pre-tx snapshot", async () => {
    // Seed the STALE pre-tx snapshot with a marker env key absent from the live
    // committed config. If the merge (wrongly) used the pre-tx snapshot, the
    // written config would carry STALE_MARKER; the in-tx locked read must not.
    const { handle, state } = makeDb({
      staleConfig: { env: { STALE_MARKER: { type: "secret_ref", secretId: "stale", version: "latest" } } },
    });
    const app = makeApp(handle);

    const res = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-1" });
    expect(res.status).toBe(200);

    const env = (state.live.env ?? {}) as Record<string, unknown>;
    expect(env.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref" });
    // Proof the merge read the in-tx (live) config, NOT the stale pre-tx snapshot.
    expect(env).not.toHaveProperty("STALE_MARKER");

    // The locked read is issued on the tx handle with strength "update" and NO
    // { noWait } option — plain FOR UPDATE, so a concurrent save WAITS then merges.
    expect(state.forCalls.length).toBe(1);
    expect(state.forCalls[0][0]).toBe("update");
    expect(state.forCalls[0][1]).toBeUndefined();
  });
});
