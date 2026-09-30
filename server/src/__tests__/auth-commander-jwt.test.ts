import { describe, it, expect, beforeAll } from "vitest";
import { agents } from "@armyofagents/db";
import { createCommanderRunJwt, createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

beforeAll(() => {
  process.env.AOA_AGENT_JWT_SECRET = "test-secret-commander-mw";
});

// Real-shape note: the plan's Task-2 harness assumed a factory named
// `attachActor(db)` and a db whose `select()` throws unconditionally. The real
// factory is `actorMiddleware(db, opts)` (auth.ts:74), and it queries the
// board/agent/mcp *key* tables (keyHash lookups) BEFORE the `if (!key)` JWT
// block — so a blanket-throwing db would throw at the boardApiKeys lookup and
// never reach the commander branch. What "no agents-row lookup" actually means
// is that the commander branch must NOT run the AGENT branch's
// `db.select().from(agents)` lookup (auth.ts:318-322). This stub returns []
// for every key-table lookup but THROWS if the `agents` table is ever queried,
// so the assertion is faithful: reaching the agents table = the commander token
// wrongly fell into the agent branch.
function keyTablesEmptyButAgentsForbiddenDb() {
  const makeThenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.from = (table: unknown) => {
      if (table === agents) {
        throw new Error("db must not query the agents table for a commander JWT");
      }
      return chain;
    };
    chain.where = () => chain;
    chain.innerJoin = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    chain.update = () => chain;
    chain.set = () => chain;
    return chain;
  };
  return makeThenable([]) as never;
}

async function runMiddleware(token: string, db: never) {
  const handler = actorMiddleware(db, { deploymentMode: "authenticated" });
  const req: Record<string, unknown> = {
    header: (h: string) =>
      h.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
  };
  await new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req as never, {} as never, () => resolve())).catch(reject);
  });
  return (req as { actor?: Record<string, unknown> }).actor;
}

describe("actorMiddleware: commander JWT branch", () => {
  it("sets a commander actor with NO agents-row lookup", async () => {
    const token = createCommanderRunJwt({
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
    })!;
    const actor = await runMiddleware(token, keyTablesEmptyButAgentsForbiddenDb());
    expect(actor).toMatchObject({
      type: "commander",
      source: "commander_jwt",
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      // runId mirrors turnId so run-scoped audit/telemetry stays populated.
      runId: "run1",
    });
  });

  it("an AGENT JWT still resolves through the agent branch (no commander regression)", async () => {
    // Positive control for the sibling path: an agent token must NOT be caught
    // by the commander branch. It has no `kind:"commander"`, so it falls to the
    // agent branch — which queries the agents table. Here that query is forced
    // to throw, proving the agent token reached the agent branch (i.e. the
    // commander branch did NOT swallow it).
    const agentToken = createLocalAgentJwt("agent-1", "c1", "claude_local", "run-1")!;
    await expect(
      runMiddleware(agentToken, keyTablesEmptyButAgentsForbiddenDb()),
    ).rejects.toThrow(/agents table/);
  });
});
