import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";
import {
  writeFakeClaudeControl,
  readFakeClaudeInvocations,
  clearFakeClaudeInvocations,
} from "./helpers/fake-claude";

/**
 * Agent context delivery — the last mile the composer work depends on:
 * when a task comment @mentions an agent, the agent must actually WAKE and
 * its CLI prompt must actually CONTAIN the triggering comment and the task.
 *
 * This also live-proves review fix F3 (2026-07-16): the mentioned agent has
 * a MULTI-WORD name, which the old whitespace tokenizer could never resolve
 * — the wake only happens at all because findMentionedAgents now runs the
 * @full-name pass. Uses the deterministic fake-claude CLI, which records
 * every invocation's argv+stdin so the exact prompt is assertable.
 *
 * The Workspace chatbar posts through the same route (issuesApi.addComment),
 * so this covers both the Comments tab and the chatbar send path.
 */

const CONTEXT_MARKER = "CONTEXT-MARKER-77419";
const AGENT_NAME = "Quality Auditor"; // multi-word on purpose (F3)

async function jsonOrThrow<T>(res: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }, what: string): Promise<T> {
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`${what} failed: ${res.status()} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await probe();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test.describe("agent context delivery", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CtxDelivery-/);
  });

  test("a comment @mentioning a multi-word agent wakes it with the comment + task in its prompt", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CtxDelivery-${Date.now()}`);

    // Hire a claude_local agent — heartbeat runs resolve `claude` to the
    // PATH-prepended fake CLI, so the run is deterministic and recorded.
    const hire = await jsonOrThrow<{ agent: { id: string; name: string } }>(
      await request.post(`/api/companies/${company.id}/agent-hires`, {
        data: {
          name: AGENT_NAME,
          role: "general",
          title: AGENT_NAME,
          adapterType: "claude_local",
          runtimeConfig: { injectCompanyContext: true, contextMode: "standard" },
          adapterConfig: {},
        },
      }),
      "hire agent",
    );

    const issue = await jsonOrThrow<{ id: string; title: string }>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Verify the unified composer context pipeline",
          description: "Context-delivery e2e task.",
          status: "todo",
          priority: "medium",
          workMode: "standard",
        },
      }),
      "create issue",
    );

    clearFakeClaudeInvocations();
    writeFakeClaudeControl({ text: "Acknowledged — auditing now." });

    // The ONLY trigger: an @mention of the multi-word agent name in a task
    // comment (the exact string the composer @ picker inserts).
    await jsonOrThrow(
      await request.post(`/api/issues/${issue.id}/comments?companyId=${company.id}`, {
        data: { body: `@${AGENT_NAME} please verify ${CONTEXT_MARKER} before merge.` },
      }),
      "post mention comment",
    );

    // The mention must wake the agent: a heartbeat run appears and finishes.
    await waitFor(async () => {
      const res = await request.get(
        `/api/companies/${company.id}/heartbeat-runs?limit=5`,
      );
      if (!res.ok()) return null;
      const runs = (await res.json()) as Array<{ agentId: string; status: string }>;
      const run = runs.find(
        (r) => r.agentId === hire.agent.id && (r.status === "succeeded" || r.status === "failed"),
      );
      return run ?? null;
    }, "mention-triggered heartbeat run to finish", 90_000);

    // The definitive assertion: the CLI's recorded prompt carries the
    // triggering comment text AND the task identity.
    const invocations = readFakeClaudeInvocations();
    expect(invocations.length).toBeGreaterThan(0);
    const payload = invocations
      .map((inv) => `${inv.argv.join(" ")}\n${inv.stdin}`)
      .join("\n---\n");
    expect(payload).toContain(CONTEXT_MARKER); // the comment content reached the agent
    expect(payload).toContain("Verify the unified composer context pipeline"); // task context reached the agent
  });
});
