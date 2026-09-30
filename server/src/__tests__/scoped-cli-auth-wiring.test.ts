import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("scoped CLI authentication wiring", () => {
  it("does not discard the governed credential environment when applying mentioned skills", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../services/heartbeat.ts"),
      "utf8",
    );

    expect(source).toContain(
      "runScopedConfig = applyRunScopedMentionedSkillKeys(runScopedConfig, mentionedSkillKeys);",
    );
    expect(source).not.toContain(
      "runScopedConfig = applyRunScopedMentionedSkillKeys(resolvedConfigWithEnvironmentAcquisition, mentionedSkillKeys);",
    );
  });

  it("attempts governed binding resolution even when strict scoped auth is not enabled", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../services/heartbeat.ts"),
      "utf8",
    );
    const compact = source.replace(/\s+/g, " ");

    // P4 relocated the standalone subscription block into the `legacySubscriptionEnv`
    // closure of hbDeps. Intent is unchanged: for a subscription provider the
    // heartbeat must still ATTEMPT governed binding resolution
    // (resolveAgentSubscriptionEnvironment) regardless of whether strict scoped
    // CLI auth is enabled — the scoped flag governs only whether a resolution
    // FAILURE is tolerated (legacy host-login fallback) vs rethrown.
    expect(compact).toContain(
      "const boundEnv = await resolveAgentSubscriptionEnvironment(db, {",
    );
    // The scoped flag is read as `scopedRequired` and passed to the fallback gate,
    // not used to gate whether binding resolution is attempted.
    expect(compact).toContain(
      "if (!mayUseLegacySubscriptionHome(error, scopedRequired)) throw error;",
    );
    // Regression guard: the binding-resolution attempt is never itself wrapped in
    // a `scopedRequired` gate (that is exactly the pre-fix bug — no governed
    // binding when scoped auth was off). The scoped flag may only appear in the
    // dedicated-target throw (`&& scopedRequired`) and the fallback gate above.
    expect(compact).not.toContain("if (scopedRequired) {");
    expect(compact).not.toContain("if (scopedRequired &&");
  });
});
