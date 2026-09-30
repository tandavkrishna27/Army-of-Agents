/**
 * Commander skill-triggering acceptance test (Plan 2, Task 6d).
 *
 * §17-style hard bar: drives the REAL `agentLoopService.chat()` (real CLI
 * subprocess spawn, real DB) with a naive prompt that never names the skill,
 * and asserts a `use_skill` tool_call fired for the expected key.
 *
 * Non-deterministic (a live LLM decides whether to call `use_skill`) and
 * gated the same way as `aoa-realoutput.integration.test.ts` — this is a
 * hard-bar acceptance signal, not part of the CI-required suite. Broad
 * corpus coverage (beyond this one case) is deferred to R2; this is a
 * skeleton proving the wiring, not the full 10-case corpus.
 *
 * IMPORTANT — why this asserts on the in-process `tool_call` chunk's
 * `input.key`, not the persisted row: `internal_agent_messages.toolCalls`
 * only stores the tool `name` (e.g. "use_skill"), never the skill `key`
 * argument (`agent-loop.ts:313-315`, `turnToolCalls.push({ name: chunk.name })`).
 * The skill key only ever exists in the live stream (this chunk) or,
 * equivalently, in the `use_skill` tool_result summary text
 * ("Loaded skill: <name>" — `tools/skill-tools.ts:100`). Never assert
 * against the persisted `toolCalls` for the key — it isn't there.
 *
 * CRITICAL PRECONDITIONS (all must hold; test skips otherwise):
 *   1. Not running on Windows (embedded-postgres migration issue — Issue #114)
 *   2. AOA_ACCEPTANCE_CLI=1 environment variable is set
 *   3. DATABASE_URL environment variable points to a running database with
 *      migrations already applied
 *   4. The Commander agent is configured with adapterType='claude_local' and
 *      valid credentials
 *
 * See docs/guides/board-operator/aoa-agents-acceptance.md for setup instructions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { ensureCommanderAgent } from "../services/internal-agent/aoa-agents/ensure-commander.js";
import { seedAoaNativeSkills } from "../services/internal-agent/aoa-skills-seeder.js";
import { agentLoopService, type AgentStreamChunk } from "../services/internal-agent/agent-loop.js";

const isWin32 = process.platform === "win32";
const hasAcceptanceCli = Boolean(process.env.AOA_ACCEPTANCE_CLI);

describe.skipIf(isWin32 || !hasAcceptanceCli)(
  "Commander skill-triggering acceptance (§17 hard bar)",
  () => {
    let db: Db;
    let companyId: string;
    let commanderAgentId: string;
    let setupError: unknown = null;

    beforeAll(async () => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error(
            "DATABASE_URL is not set. This acceptance test requires a real " +
              "running database with migrations applied. See " +
              "docs/guides/board-operator/aoa-agents-acceptance.md for setup.",
          );
        }
        db = createDb(databaseUrl);

        const company = await companyService(db).create({
          name: `Commander Skill Triggering Acceptance Co ${Date.now()}`,
        } as any);
        companyId = company.id;

        // Seed all 8 AoA-native skills into this company's catalog (the
        // real seeder — same code path a production company uses), then
        // (re-)ensure the Commander agent so its idempotent skillKeys
        // backfill picks up the newly-installed skills (see
        // ensure-commander.ts:181-229 — it defaults an uninitialized or
        // empty selection to "all currently-installed").
        await seedAoaNativeSkills(db, companyId);
        commanderAgentId = await ensureCommanderAgent(db, companyId);

        // Configure the Commander agent with claude_local so it can actually
        // run. The adapter config is read from ACCEPTANCE_ADAPTER_CONFIG if
        // set (JSON string), otherwise assumes `claude` is on PATH.
        const adapterConfigRaw = process.env.ACCEPTANCE_ADAPTER_CONFIG;
        const adapterConfig = adapterConfigRaw
          ? JSON.parse(adapterConfigRaw)
          : { cwd: process.cwd() };

        await db.execute(sql`
          UPDATE agents
          SET adapter_type = 'claude_local',
              adapter_config = ${JSON.stringify(adapterConfig)}::jsonb,
              updated_at = now()
          WHERE id = ${commanderAgentId}
        `);

        // Belt-and-suspenders: explicitly confirm skill:aoa/spec made it into
        // the Commander's curated selection (the backfill above should have
        // included it, since it's part of seedAoaNativeSkills' full catalog).
        const [row] = await db
          .select({ skillKeys: agents.skillKeys })
          .from(agents)
          .where(eq(agents.id, commanderAgentId))
          .limit(1);
        const skillKeys = (row?.skillKeys as string[] | null) ?? [];
        if (!skillKeys.includes("skill:aoa/spec")) {
          await db
            .update(agents)
            .set({ skillKeys: [...skillKeys, "skill:aoa/spec"] })
            .where(eq(agents.id, commanderAgentId));
        }
      } catch (err) {
        setupError = err;
        // eslint-disable-next-line no-console
        console.error("[commander-skill-triggering-acceptance] setup failed:", err);
      }
    }, 60_000);

    afterAll(async () => {
      if (db && companyId) {
        try {
          await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
        } catch {
          /* swallow — test isolation, not critical */
        }
      }
    }, 30_000);

    it(
      "fires a use_skill tool_call for skill:aoa/spec on a naive prompt that never names the skill",
      async () => {
        if (setupError) {
          throw new Error(
            `acceptance test setup failed — cannot assert real routing: ${String(setupError)}`,
          );
        }

        const chunks: AgentStreamChunk[] = [];
        for await (const chunk of agentLoopService(db).chat({
          companyId,
          userId: "acceptance-test-user",
          userRole: "founder",
          content: "turn this into a ticket the engineer can pick up",
          enabledCapabilities: [],
        })) {
          chunks.push(chunk);
        }

        const skillCalls = chunks.filter(
          (c): c is Extract<AgentStreamChunk, { type: "tool_call" }> =>
            c.type === "tool_call" && /(?:^|_)use_skill$/.test(c.name),
        );
        expect(
          skillCalls.length,
          `Expected ≥1 use_skill tool_call. Got chunk types: ${chunks.map((c) => c.type).join(", ")}`,
        ).toBeGreaterThan(0);

        const keys = skillCalls.map((c) => (c.input as { key?: string } | undefined)?.key);
        expect(keys).toContain("skill:aoa/spec");
      },
      120_000,
    );
  },
);
