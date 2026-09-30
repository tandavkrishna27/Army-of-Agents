import { describe, expect, it } from "vitest";

import { CleanupAuthority } from "../supervisor/cleanup-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { hashResourceLabels } from "../supervisor/provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = { jobId: "job-1", attempt: 1, leaseId: "lease-1", fenceToken: "f".repeat(40), deviceGeneration: 1, observedSeq: 0 };

const SENSITIVE_KEYS = ["command", "env", "logs", "secrets", "workspaceBytes", "objectGrants"] as const;

describe("cleanup-redaction — same-resource inspect returns ONLY the redacted management projection", () => {
  it("the projection carries no command/env/logs/secrets/bytes/grants (but the raw provider detail does)", async () => {
    const labels = sampleLabels();
    const fake = createFakeSandboxProvider();
    const id = (
      await fake.create({ resourceLabels: labels, command: "codex --dangerous", args: ["--secret"], env: { API_KEY: "sk-live-xyz" }, workloadType: "batch" }, makeCtx())
    ).sandboxId;
    const cleanup = new CleanupAuthority({
      provider: fake,
      resourceLabels: labels,
      targetGeneration: labels.deviceGeneration,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });

    const projection = await cleanup.inspect(id, makeCtx());

    // Management-safe fields ARE present.
    expect(projection.sandboxId).toBe(id);
    expect(projection.state).toBe("running");
    expect(projection.resourceLabelsHash).toBe(hashResourceLabels(labels));
    expect(typeof projection.providerOpId).toBe("string");

    // NO sensitive field leaks.
    for (const key of SENSITIVE_KEYS) {
      expect(key in projection).toBe(false);
    }
    // Labels are HASHED, never raw.
    expect(JSON.stringify(projection)).not.toContain("sk-live-xyz");
    expect(JSON.stringify(projection)).not.toContain("codex --dangerous");
    expect(JSON.stringify(projection)).not.toContain(labels.organizationId);

    // Non-vacuous: the RAW provider detail the authority reads internally DOES
    // carry the sensitive bytes — the projection is a real redaction, not an
    // empty object.
    const raw = await fake.inspect(id, makeCtx());
    expect(raw.command).toBe("codex --dangerous");
    expect(raw.env.API_KEY).toBe("sk-live-xyz");
  });
});
