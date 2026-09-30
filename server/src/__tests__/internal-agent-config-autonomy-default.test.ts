// T10 fix — schema-default contract test.
//
// The per-company `internal_agent_config.autonomyLevel` default is Assist (1),
// not Manual (0). A fresh company (ensureInternalAgentConfig inserts just
// `{ companyId }` and relies on this column default) must therefore land at
// Assist so its crew can hand tasks to review out of the box — at Manual every
// crew run failed the completion guard (see aoa-runner-task-execution.test.ts).
//
// `@armyofagents/db` resolves to source (packages/db/package.json exports
// "." → ./src/index.ts), so this reads the live Drizzle column definition — no
// build step. Unmocked on purpose: the mocked-db suites cannot see the real
// default.

import { describe, expect, it } from "vitest";
import { internalAgentConfig } from "@armyofagents/db";

describe("internal_agent_config.autonomyLevel schema default", () => {
  it("defaults to 1 (Assist), not 0 (Manual)", () => {
    const col = internalAgentConfig.autonomyLevel as unknown as {
      hasDefault: boolean;
      default: unknown;
    };
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBe(1);
  });
});
