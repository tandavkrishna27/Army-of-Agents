import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentRuntimeDecisions = pgTable(
  "agent_runtime_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /**
     * BRW-004 (E8-F002) — NULLABLE, in an all-or-nothing pair with `runId`.
     *
     * ★★ WHY. The shipped JOB-011 governance matrix designates THIS table as the aggregate
     * for a `browser_request` source (`job-approval-bridge.ts:173-183`, pinned by
     * `job-source-governance-matrix.test.ts:134-140`). A distributed browser job has no
     * `agents` row and no `heartbeat_runs` row — it has a `jobs` row, an attempt, a lease and
     * a fence. With both columns NOT NULL the designated aggregate could not hold a legal row
     * for the very source it was designated for, and the one end-to-end test that appeared to
     * prove otherwise passes only because it MANUFACTURES a synthetic agent and a seeded run
     * (`job-approval-parity.integration.test.ts:146-171`).
     *
     * ★★ WHY NOT THE ALTERNATIVES, recorded so they are not re-tried. Minting a synthetic
     * agent + heartbeat run per browser session writes rows into two tables whose own
     * machinery would then act on them — trust-score computation, heartbeat sweeps, run-summary
     * comments, the concurrency clamp. A row that is not an agent must not appear in `agents`.
     * A second, parallel decision table for browser is the "never a new engine" prohibition
     * `job-approval-bridge.ts:5-6` exists to enforce, and it would fork the timeout sweeper.
     *
     * The distributed binding rides the EXISTING fence-guarded `job_projection_receipts` row,
     * which already links an aggregate to a job + attempt + fence.
     *
     * ★ THE CHECK IS THE POINT. `(agent_id IS NULL) = (run_id IS NULL)` means no row can be
     * half-bound: a legacy decision carries both, a distributed one carries neither, and
     * nothing can carry one. Without it, "nullable" would silently admit a row with an agent
     * and no run, which every reader below would then have to defend against separately.
     */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    adapterSessionId: text("adapter_session_id"),
    adapterSessionParams: jsonb("adapter_session_params").$type<Record<string, unknown>>(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("created"),
    nonce: text("nonce").notNull(),
    sourceRevision: integer("source_revision").notNull().default(0),
    promptHash: text("prompt_hash").notNull(),
    sourceUniqueKey: text("source_unique_key"),
    title: text("title").notNull(),
    summary: text("summary"),
    promptText: text("prompt_text"),
    toolName: text("tool_name"),
    command: text("command"),
    commandHash: text("command_hash"),
    cwd: text("cwd"),
    path: text("path"),
    networkTarget: text("network_target"),
    riskClass: text("risk_class"),
    options: jsonb("options").$type<Array<Record<string, unknown>>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    timeoutPolicy: text("timeout_policy").notNull(),
    decision: text("decision"),
    answerPayload: jsonb("answer_payload").$type<Record<string, unknown>>(),
    answerIdempotencyKey: text("answer_idempotency_key"),
    answeredByUserId: text("answered_by_user_id"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    relayedAt: timestamp("relayed_at", { withTimezone: true }),
    relayError: text("relay_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusExpiryIdx: index("agent_runtime_decisions_company_status_expiry_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    companyRunStatusIdx: index("agent_runtime_decisions_company_run_status_idx").on(
      table.companyId,
      table.runId,
      table.status,
    ),
    companyAgentCreatedIdx: index("agent_runtime_decisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    statusExpiryIdx: index("agent_runtime_decisions_status_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    sourceUniqueIdx: uniqueIndex("agent_runtime_decisions_source_unique_idx")
      .on(table.sourceUniqueKey)
      .where(sql`source_unique_key is not null`),
    // BRW-004 (E8-F002). The legacy binding is ALL-OR-NOTHING: a decision either carries both
    // `agent_id` and `run_id` (a heartbeat-run decision) or neither (a distributed job
    // decision, bound through `job_projection_receipts`). A half-bound row would be a decision
    // attributed to an agent with no run, or a run with no agent, and every reader would then
    // need its own defence against a state the schema should never have admitted.
    legacyBindingAllOrNothing: check(
      "agent_runtime_decisions_legacy_binding_all_or_nothing",
      sql`(agent_id is null) = (run_id is null)`,
    ),
  }),
);

export const agentRuntimeTrustRules = pgTable(
  "agent_runtime_trust_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /**
     * BRW-004 (E8-F002) — NOT NULL. **THE TENTH NULL-HAZARD of the relaxation above, and the
     * design PREDICTED IT**: §D5, "the moment slice (c) populates `networkTarget` …
     * `allow_always` becomes reachable for browser egress."
     *
     * ★★★ THE CHAIN, and why it is a privilege escalation rather than a null-pointer.
     * `answerPrompt` admits `allow_always` as soon as `hasConcreteTrustScope(row)` holds, and
     * that predicate is satisfied by `riskClass` OR `networkTarget` ALONE — both of which
     * slice (c) now sets on every browser navigation. `buildTrustRuleInsert` then copied
     * `row.agentId` — newly NULLABLE — straight into this column. And `trustRuleMatchesPrompt`
     * skipped its agent clause on a null (`if (rule.agentId && …)`), so an unbound rule was a
     * WILDCARD IN THE AGENT DIMENSION: one founder answering "always allow this browser session to
     * reach example.com" would silently authorise sessions they never saw.
     *
     * ★ Blast radius RE-DERIVED, not asserted: a match also needs equal `riskClass` and an exact
     * `networkScope`, and the browser seam emits `network_egress` + a URL ORIGIN while the CLI hook
     * bridge emits `network` + a bare HOSTNAME — so heartbeat prompts are out of reach TODAY by
     * coincidence, not by design. What is in reach is every other distributed browser prompt in the
     * company on the same adapter and origin, for ninety days.
     *
     * ★★ WHY NOT THE SIBLING'S CHECK. `(agent_id IS NULL) = (run_id IS NULL)` is the right
     * predicate for a DECISION and the WRONG one here: a persistent grant is agent-bound and
     * run-less BY DESIGN (`buildTrustRuleInsert` writes `runId: null`), so copying that check
     * across would reject every trust rule the product has ever written. The sibling's
     * invariant is "all or nothing"; this table's is "always bound". `runId` stays nullable —
     * null there means persistent, not unbound.
     *
     * ★ SAFE TO NARROW, measured rather than assumed. The only production writer of this table
     * is `answerWithTrustRule`, reached solely from `answerPrompt`, which until this branch
     * copied a NOT NULL `agent_id`. The service's own `createTrustRule` — which used to accept
     * `agentId?: string | null` and write `?? null` — has ZERO production callers (routes
     * expose only list + revoke; `internal-agent.ts:506` is the different
     * `internal_agent_tool_trust_rules` service). So no unbound row can exist, and the
     * narrowing makes three call sites a COMPILE error instead of a runtime guard.
     *
     * A company-wide grant is a real product idea; it is not this one. It would need a
     * deliberate scope column and a successor decision, not a null standing in for "everyone".
     */
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    grantScope: text("grant_scope").notNull().default("persistent"),
    adapterType: text("adapter_type").notNull(),
    toolName: text("tool_name"),
    commandHash: text("command_hash"),
    pathScope: text("path_scope"),
    networkScope: text("network_scope"),
    riskClass: text("risk_class"),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentEnabledIdx: index("agent_runtime_trust_rules_company_agent_enabled_idx").on(
      table.companyId,
      table.agentId,
      table.enabled,
    ),
    companyAdapterToolIdx: index("agent_runtime_trust_rules_company_adapter_tool_idx").on(
      table.companyId,
      table.adapterType,
      table.toolName,
    ),
    runScopeIdx: index("agent_runtime_trust_rules_run_scope_idx").on(
      table.runId,
      table.enabled,
    ),
  }),
);
