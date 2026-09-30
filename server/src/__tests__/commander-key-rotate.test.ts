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
 * Stateful secretService mock reproducing the real service contract that made
 * the Codex P1 bite: `create` REJECTS an active duplicate name with a 409, so a
 * founder who saves a bad key then retries with a corrected one used to get
 * permanently wedged. `getByName` finds the existing row and `rotate` succeeds.
 *
 * NOTE: persistCommanderApiKey and the route's `writeSecret` closure are NOT
 * mocked here — this drives the fix end-to-end through the real route.
 */
const secretsMock = vi.hoisted(() => {
  const state = {
    byName: new Map<string, { id: string; name: string; value: string; status: string }>(),
    seq: 0,
  };
  const svc = {
    getByName: vi.fn(async (_companyId: string, name: string) => state.byName.get(name) ?? null),
    create: vi.fn(async (_companyId: string, input: { name: string; value: string }) => {
      if (state.byName.has(input.name)) {
        throw Object.assign(new Error(`Secret already exists: ${input.name}`), { status: 409, statusCode: 409 });
      }
      const row = { id: `sec-${++state.seq}`, name: input.name, value: input.value, status: "active" };
      state.byName.set(input.name, row);
      return row;
    }),
    rotate: vi.fn(async (secretId: string, input: { value: string }) => {
      // Mirrors the real service: rotate appends a version + value; it NEVER
      // touches status. Reactivation must therefore happen separately.
      const row = [...state.byName.values()].find((r) => r.id === secretId);
      if (row) row.value = input.value;
      return row ?? null;
    }),
    update: vi.fn(async (secretId: string, patch: { status?: string }) => {
      // Canonical status-setting seam (svc.update) used to reactivate a
      // disabled/archived secret back to "active".
      const row = [...state.byName.values()].find((r) => r.id === secretId);
      if (row && patch.status) row.status = patch.status;
      return row ?? null;
    }),
    syncEnvBindingsForTarget: vi.fn(async () => {}),
  };
  return { state, svc };
});
vi.mock("../services/secrets.js", () => ({ secretService: () => secretsMock.svc }));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

import { errorHandler } from "../middleware/error-handler.js";
import { commanderKeyRoutes } from "../routes/commander-key.js";

function db() {
  const handle: Record<string, unknown> = {
    select: () => ({
      from: (tbl: { _: { name: string } }) => ({
        where: () => ({
          // `.limit()` = pre-tx internal_agent_config id lookup; `.for()` = the
          // in-tx `SELECT adapterConfig … FOR UPDATE` locked read (round-12 P2).
          // These rotate tests don't exercise env merging, so an empty config is
          // fine either way.
          limit: async () =>
            tbl._.name === "internal_agent_config" ? [{ agentId: "cmd" }] : [{ adapterConfig: {} }],
          for: async () =>
            tbl._.name === "internal_agent_config" ? [{ agentId: "cmd" }] : [{ adapterConfig: {} }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    // Model the real DB's atomicity so a rolled-back save undoes the secret
    // mutation. The route now wraps writeSecret + adapter-config + bindings +
    // audit in ONE db.transaction; if any step throws, a real Postgres tx rolls
    // the committed vault row back. The stateful secretsMock write goes to an
    // in-memory Map, so snapshot it here and restore on throw to reproduce that.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = new Map(
        [...secretsMock.state.byName].map(([k, v]) => [k, { ...v }] as const),
      );
      const seqSnapshot = secretsMock.state.seq;
      try {
        return await fn(handle);
      } catch (err) {
        secretsMock.state.byName.clear();
        for (const [k, v] of snapshot) secretsMock.state.byName.set(k, v);
        secretsMock.state.seq = seqSnapshot;
        throw err;
      }
    },
  };
  return handle as never;
}
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = { type: "board", userId: "u1" };
    next();
  });
  app.use("/api", commanderKeyRoutes(db()));
  app.use(errorHandler);
  return app;
}
const url = "/api/companies/c1/internal-agent/commander-key";

describe("POST commander-key rotate-on-retry (Codex P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsMock.state.byName.clear();
    secretsMock.state.seq = 0;
  });

  it("first save creates the Commander secret (no rotate)", async () => {
    const res = await request(makeApp()).post(url).send({ provider: "anthropic", value: "sk-ant-FIRST" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, secretId: "sec-1", verification: "verified" });
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.rotate).not.toHaveBeenCalled();
  });

  it("retry after a bad key ROTATES the existing secret instead of 409ing", async () => {
    const app = makeApp();
    const first = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-BAD" });
    expect(first.status).toBe(200);
    const firstId = first.body.secretId as string;

    const retry = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-GOOD" });
    expect(retry.status).toBe(200); // NOT 409
    expect(retry.body).toEqual({ ok: true, secretId: firstId, verification: "verified" }); // same id → binding stays valid
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1); // created only once
    expect(secretsMock.svc.rotate).toHaveBeenCalledTimes(1); // rotated on retry
    // the rotate actually updated the resolved value the Commander adapter reads
    expect(secretsMock.svc.rotate).toHaveBeenCalledWith(firstId, expect.objectContaining({ value: "sk-ant-GOOD" }), expect.anything());
    expect(secretsMock.state.byName.get("Commander anthropic API key")?.value).toBe("sk-ant-GOOD");
    // no plaintext key ever leaves in the response
    expect(JSON.stringify(retry.body)).not.toContain("sk-ant-GOOD");
  });

  it("openai retry rotates its own deterministic secret independently", async () => {
    const app = makeApp();
    const first = await request(app).post(url).send({ provider: "openai", value: "sk-oai-1" });
    expect(first.status).toBe(200);
    const retry = await request(app).post(url).send({ provider: "openai", value: "sk-oai-2" });
    expect(retry.status).toBe(200);
    expect(secretsMock.svc.rotate).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.rotate).toHaveBeenCalledWith(first.body.secretId, expect.objectContaining({ value: "sk-oai-2" }), expect.anything());
  });

  it("REACTIVATES a disabled Commander secret before rotating so key-save recovers verification (Codex P2)", async () => {
    const app = makeApp();
    const first = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-OLD" });
    expect(first.status).toBe(200);
    const secretId = first.body.secretId as string;

    // Founder DISABLED the secret from Settings (status -> "disabled"). getByName
    // still returns it (deletedAt IS NULL), but resolveSecretValue would reject it
    // as "Secret is not active" until reactivated.
    const row = secretsMock.state.byName.get("Commander anthropic API key")!;
    row.status = "disabled";

    const save = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-NEW" });
    expect(save.status).toBe(200);
    expect(save.body).toEqual({ ok: true, secretId, verification: "verified" }); // same id -> binding stays valid
    // reactivated via the canonical update() seam, then rotated
    expect(secretsMock.svc.update).toHaveBeenCalledTimes(1);
    expect(secretsMock.svc.update).toHaveBeenCalledWith(secretId, { status: "active" });
    expect(secretsMock.svc.rotate).toHaveBeenCalledWith(secretId, expect.objectContaining({ value: "sk-ant-NEW" }), expect.anything());
    // ORDER: reactivate BEFORE rotate, so the final state is active + newest value
    expect(secretsMock.svc.update.mock.invocationCallOrder[0]).toBeLessThan(
      secretsMock.svc.rotate.mock.invocationCallOrder[0],
    );
    // resolvable end state: active + rotated value
    expect(row.status).toBe("active");
    expect(row.value).toBe("sk-ant-NEW");
  });

  it("reactivates an ARCHIVED Commander secret as well", async () => {
    const app = makeApp();
    const first = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-1" });
    expect(first.status).toBe(200);
    const secretId = first.body.secretId as string;
    secretsMock.state.byName.get("Commander anthropic API key")!.status = "archived";

    const save = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-2" });
    expect(save.status).toBe(200);
    expect(secretsMock.svc.update).toHaveBeenCalledWith(secretId, { status: "active" });
    expect(secretsMock.state.byName.get("Commander anthropic API key")?.status).toBe("active");
  });

  it("does NOT write status when the existing secret is already active (idempotent rotate)", async () => {
    const app = makeApp();
    const first = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-1" });
    expect(first.status).toBe(200);

    const retry = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-2" });
    expect(retry.status).toBe(200);
    expect(secretsMock.svc.update).not.toHaveBeenCalled(); // no spurious status write
    expect(secretsMock.svc.rotate).toHaveBeenCalledTimes(1);
    expect(secretsMock.state.byName.get("Commander anthropic API key")?.status).toBe("active");
  });
});

describe("POST commander-key audit trail (Codex P2 — AGENTS.md §5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsMock.state.byName.clear();
    secretsMock.state.seq = 0;
  });

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

  it("logs commander.key.created (redacted) when the secret is first created", async () => {
    const res = await request(makeApp()).post(url).send({ provider: "anthropic", value: "sk-ant-FIRST" });
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const input = loggedInput(0);
    expect(input).toMatchObject({
      companyId: "c1",
      actorType: "user",
      actorId: "u1",
      action: "commander.key.created",
      entityType: "secret",
      entityId: "sec-1",
    });
    expect(input.details).toMatchObject({ provider: "anthropic", secretId: "sec-1", operation: "created" });
    // Redaction proof: the raw key never appears anywhere in the audit entry.
    expect(JSON.stringify(input)).not.toContain("sk-ant-FIRST");
  });

  it("logs commander.key.rotated when an active secret is rotated on retry", async () => {
    const app = makeApp();
    await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-BAD" });
    await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-GOOD" });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    const second = loggedInput(1);
    expect(second.action).toBe("commander.key.rotated");
    expect(second.entityId).toBe("sec-1"); // same secret id → stable reference
    expect(second.details).toMatchObject({ provider: "anthropic", secretId: "sec-1", operation: "rotated" });
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("sk-ant-GOOD");
  });

  it("logs commander.key.reactivated when a disabled secret is reactivated then rotated", async () => {
    const app = makeApp();
    await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-OLD" });
    secretsMock.state.byName.get("Commander anthropic API key")!.status = "disabled";
    await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-NEW" });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    const second = loggedInput(1);
    expect(second.action).toBe("commander.key.reactivated");
    expect(second.details).toMatchObject({ operation: "reactivated", provider: "anthropic" });
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("sk-ant-NEW");
  });

  it("a fully-successful save commits the secret, the bindings AND exactly one redacted audit entry", async () => {
    const res = await request(makeApp()).post(url).send({ provider: "anthropic", value: "sk-ant-OK" });
    expect(res.status).toBe(200);
    // secret written to the vault
    expect(secretsMock.svc.create).toHaveBeenCalledTimes(1);
    // env bindings synced for the agent target
    expect(secretsMock.svc.syncEnvBindingsForTarget).toHaveBeenCalledTimes(1);
    // exactly one audit entry, redacted
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(loggedInput(0).action).toBe("commander.key.created");
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("sk-ant-OK");
  });

  it("a partial failure (binding sync throws after the secret write) leaves NO unaudited mutation — the whole save rolls back (Codex round-11 P2)", async () => {
    // syncEnvBindings is step 3; by the time it runs, the secret create (step 1)
    // has already written the vault row. Before the fix the audit fired only
    // AFTER all three steps + outside any tx, so this committed vault mutation
    // was left with NO audit entry (AGENTS.md §5 violation). The atomic tx now
    // rolls the secret write back together with everything else.
    secretsMock.svc.syncEnvBindingsForTarget.mockRejectedValueOnce(new Error("binding sync failed"));
    const res = await request(makeApp()).post(url).send({ provider: "anthropic", value: "sk-ant-PARTIAL" });
    expect(res.status).toBe(500);

    const committed = secretsMock.state.byName.has("Commander anthropic API key");
    const audited = mockLogActivity.mock.calls.length > 0;
    // Invariant: every committed vault mutation is audited. A committed-but-
    // unaudited secret (committed && !audited) must NEVER happen.
    expect(committed && !audited).toBe(false);
    // Concretely: the tx rolled the secret write back, so nothing committed and
    // nothing needed auditing.
    expect(committed).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalled();
    // No plaintext key ever surfaces, even on the failure path.
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-PARTIAL");
  });

  it("a partial failure on a REACTIVATE+rotate path also rolls back with no unaudited mutation", async () => {
    const app = makeApp();
    await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-OLD" });
    secretsMock.state.byName.get("Commander anthropic API key")!.status = "disabled";
    mockLogActivity.mockClear();
    secretsMock.svc.create.mockClear();

    // Reactivate (step 1a) + rotate (step 1b) commit the vault mutation, then the
    // binding sync fails. The reactivation must not be left committed-but-unaudited.
    secretsMock.svc.syncEnvBindingsForTarget.mockRejectedValueOnce(new Error("binding sync failed"));
    const res = await request(app).post(url).send({ provider: "anthropic", value: "sk-ant-NEW" });
    expect(res.status).toBe(500);

    const row = secretsMock.state.byName.get("Commander anthropic API key");
    // Rolled back: status restored to the pre-save "disabled", value restored.
    expect(row?.status).toBe("disabled");
    expect(row?.value).toBe("sk-ant-OLD");
    // No audit for a rolled-back mutation.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
