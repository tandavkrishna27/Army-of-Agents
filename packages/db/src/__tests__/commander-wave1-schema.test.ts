import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schema = (name: string) => readFileSync(join(here, "..", "schema", name), "utf8").replace(/\r\n/g, "\n");

describe("Commander Wave 1 schema", () => {
  it("defines company-scoped follows with V1 entity validation", () => {
    const source = schema("user_entity_follows.ts");
    expect(source).toContain('pgTable(\n  "user_entity_follows"');
    expect(source).toContain('uniqueIndex("user_entity_follows_user_company_entity_uq")');
    expect(source).toContain('index("user_entity_follows_company_entity_idx")');
    expect(source).toContain("entity_type IN ('task', 'project', 'goal')");
    expect(source).toContain('onDelete: "cascade"');
  });

  it("retains question identity when its task or asking agent is deleted", () => {
    const source = schema("work_questions.ts");
    expect(source).toContain('issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" })');
    expect(source).toContain('askingAgentId: uuid("asking_agent_id").references(() => agents.id, { onDelete: "set null" })');
    expect(source).toContain('issueIdentifierSnapshot: text("issue_identifier_snapshot")');
    expect(source).toContain('issueTitleSnapshot: text("issue_title_snapshot")');
    expect(source).toContain('askingAgentNameSnapshot: text("asking_agent_name_snapshot")');
    expect(source).toContain('sourceCommanderConversationId: uuid("source_commander_conversation_id")');
    expect(source).toContain('producerInvocationId: text("producer_invocation_id")');
    expect(source).toContain('producerPayloadFingerprint: text("producer_payload_fingerprint")');
    expect(source).toContain('uniqueIndex("work_questions_producer_invocation_uq")');
    expect(source).toContain('uniqueIndex("work_questions_open_payload_fingerprint_uq")');
  });

  it("defines an exactly-once continuation outbox", () => {
    const source = schema("work_question_continuation_requests.ts");
    expect(source).toContain('uniqueIndex("work_question_continuation_question_answer_uq")');
    expect(source).toContain('uniqueIndex("work_question_continuation_company_downstream_uq")');
    expect(source).toContain('index("work_question_continuation_pending_retry_idx")');
    expect(source).toContain("status IN ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')");
    expect(source).toContain("target_run_kind IN ('heartbeat', 'internal_agent')");
    expect(source).toContain('claimToken: uuid("claim_token")');
    expect(source).toContain('leaseExpiresAt: timestamp("lease_expires_at"');
    expect(source).toContain('continuationEnvelope: jsonb("continuation_envelope")');
  });

  it("adds downstream idempotency for both run targets", () => {
    expect(schema("agent_wakeup_requests.ts")).toContain("'work_question_continuation'");
    expect(schema("internal_agent.ts")).toContain('uniqueIndex("ia_runs_continuation_idempotency_uq")');
  });

  it("stores elapsed millisecond accounting in 64-bit columns", () => {
    for (const source of [schema("heartbeat_runs.ts"), schema("internal_agent.ts")]) {
      expect(source).toContain('bigint("active_execution_ms", { mode: "number" })');
      expect(source).toContain('bigint("human_question_wait_ms", { mode: "number" })');
      expect(source).toContain('bigint("runtime_permission_wait_ms", { mode: "number" })');
      expect(source).toContain('bigint("total_wall_clock_ms", { mode: "number" })');
    }
  });

  it("exports both new tables", () => {
    const index = schema("index.ts");
    expect(index).toContain('export { userEntityFollows } from "./user_entity_follows.js";');
    expect(index).toContain(
      'export { workQuestionContinuationRequests } from "./work_question_continuation_requests.js";',
    );
  });
});
