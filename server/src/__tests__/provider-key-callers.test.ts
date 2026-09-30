/**
 * Task 8 — every runtime caller of `resolveAdapterConfigForRuntime` passes a
 * REAL adapter type.
 *
 * `adapterType` is a required positional parameter with NO default: the adapter
 * cannot be inferred from the config (several adapters share `env`, `model`,
 * `cwd`, `command`), so a wrong or missing value would either put the wrong
 * credential into a CLI or silently skip the fallback. `pnpm -r typecheck` is
 * the arity gate; this file is the VALUE gate — a site could satisfy the
 * compiler with `""` or a hardcoded guess and typecheck would say nothing.
 *
 * Structural pinning (reading the source) is this repo's established pattern
 * for callers that have no unit harness — see
 * services/internal-agent/aoa-agents/__tests__/runner-binding-resolution.test.ts.
 *
 * Behaviour (the key actually landing in the resolved env) is proven once at the
 * choke point in provider-key-fallback.test.ts, since all seven sites funnel
 * through the same service method. The behavioural halves of the three sites
 * that DO have a harness are asserted in their own suites:
 *   - commander-verify        → commander-probe-config.test.ts
 *   - agents.ts `:type` route → agents-adapter-test-environment-route.test.ts
 *   - company-skills.usage    → company-skills-dispatcher.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { AGENT_ADAPTER_TYPES } from "@armyofagents/shared";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = join(here, "..");

const CALL = "resolveAdapterConfigForRuntime(";

/**
 * Split the argument list of the call whose "(" is at `open`, respecting
 * nesting. Type-argument lists count as nesting too — `as Record<string,
 * unknown>` contains a comma that is NOT an argument separator.
 */
function args(src: string, open: number): string[] {
  let depth = 0;
  let angle = 0;
  let start = open + 1;
  const out: string[] = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        out.push(src.slice(start, i).trim());
        break;
      }
    } else if (ch === "<" && /[A-Za-z0-9_>]/.test(src[i - 1] ?? "")) angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "," && depth === 1 && angle === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  // A trailing comma before ")" yields an empty final slice — not an argument.
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Every call site in a file, as its parsed argument list. */
function callSites(relPath: string): string[][] {
  const src = readFileSync(join(serverSrc, relPath), "utf8");
  const sites: string[][] = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(CALL, from);
    if (i === -1) break;
    sites.push(args(src, i + CALL.length - 1));
    from = i + CALL.length;
  }
  return sites;
}

const EXPECTED: Array<{ file: string; adapterTypeArgs: string[] }> = [
  // The opencode_local constraint check + the `:type` probe route + claude-login.
  { file: "routes/agents.ts", adapterTypeArgs: ["adapterType", "type", "agent.adapterType"] },
  { file: "services/commander-verify.ts", adapterTypeArgs: ["adapterType"] },
  // Task 9 — the Providers tab probe. Triaged: `descriptor.adapterType` is the
  // catalog descriptor being probed, and it is the SAME value passed to
  // `findServerAdapter` two lines above, so the adapter that runs and the
  // credential that is resolved cannot diverge.
  { file: "routes/providers.ts", adapterTypeArgs: ["descriptor.adapterType"] },
  { file: "services/company-skills.ts", adapterTypeArgs: ["adapterType"] },
  {
    // ONE site since the crew provider-precedence fix: the `legacyResolveConfig`
    // strangler-fallback closure bound into the unified provider resolver (crew's
    // Step-4 company-key fallback). The former up-front base-config resolution was
    // replaced by `resolveEnvBindings` (agent env only) so the legacy company key
    // no longer pre-injects into currentEnv and mask provider_assignments. Threads
    // `agent.adapterType` second.
    file: "services/internal-agent/aoa-agents/runner.ts",
    adapterTypeArgs: ["agent.adapterType"],
  },
];

/** Every .ts file under server/src, excluding tests. */
function sourceFiles(dir = serverSrc, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * REPO-WIDE inventory. The previous version of this test summed call sites over
 * the four files it already knew about and called the result "exactly six" —
 * which is vacuous: a seventh site anywhere else was invisible to it. That is
 * precisely why it failed to notice that the org-agent heartbeat assembles its
 * runtime config by hand and never reaches this method at all.
 */
describe("repo-wide inventory of runtime config resolution", () => {
  const files = sourceFiles();

  it("resolveAdapterConfigForRuntime is called from exactly the seven known sites", () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = readFileSync(file, "utf8").split(CALL).length - 1;
      if (n) found[relative(serverSrc, file).replace(/\\/g, "/")] = n;
    }
    expect(found).toEqual({
      "routes/agents.ts": 3,
      // Settings -> Providers probe (Task 9), company_default and agent scopes.
      "routes/providers.ts": 1,
      "services/commander-verify.ts": 1,
      "services/company-skills.ts": 1,
      // ONE call since the crew provider-precedence fix: the legacyResolveConfig
      // strangler-fallback closure inside the unified provider resolver. The
      // former up-front base-config resolution was replaced by resolveEnvBindings
      // (agent env only) so the legacy company key no longer masks assignments.
      "services/internal-agent/aoa-agents/runner.ts": 1,
      // Cloud one-shot CLIs (readiness probe / discussion+file-import extraction /
      // Commander compaction): the legacyResolveConfig binding inside
      // resolveCompanyProviderCredential, so those paths actually read the
      // company `provider:<id>` key. Was the identity stub → a stored key
      // resolved to a false "no provider key configured" on cloud_auth.
      "services/one-shot-provider-credential.ts": 1,
      // The declaration itself, not a call — a call from here would recurse.
      "services/secrets.ts": 1,
    });
  });

  it("the company-key fallback is applied from exactly the two known entry points", () => {
    // secrets.ts (inside resolveAdapterConfigForRuntime) and heartbeat.ts (the
    // org-agent path, which bypasses that method). A third caller appearing
    // here means a new runtime path exists and must be triaged.
    const found: string[] = [];
    for (const file of files) {
      if (readFileSync(file, "utf8").includes("applyCompanyKeyFallbackForRuntime(")) {
        found.push(relative(serverSrc, file).replace(/\\/g, "/"));
      }
    }
    expect(found.sort()).toEqual(["services/heartbeat.ts", "services/secrets.ts"]);
  });
});

/**
 * Per-site argument pinning.
 *
 * HONEST SCOPE: this compares identifier SPELLING in the source. It catches an
 * omitted or reordered argument and a hardcoded literal; it cannot catch a site
 * that binds the name `adapterType` to the wrong agent's type. Behavioural
 * coverage carries that weight for the sites that have a harness
 * (commander-verify, the `:type` route, company-skills, and the heartbeat in
 * provider-key-heartbeat.test.ts); `pnpm -r typecheck` carries the arity.
 */
describe("every resolveAdapterConfigForRuntime call site threads its adapter type", () => {
  for (const { file, adapterTypeArgs } of EXPECTED) {
    describe(file, () => {
      const sites = callSites(file);

      it("passes companyId first and the adapter type SECOND at every site", () => {
        // Subsumes the site count: an added, removed or reordered site changes
        // this array.
        expect(sites.map((s) => s[1])).toEqual(adapterTypeArgs);
      });

      it("passes four arguments (companyId, adapterType, config, context) at every site", () => {
        for (const site of sites) expect(site).toHaveLength(4);
      });

      it("never passes a literal or a placeholder as the adapter type", () => {
        for (const site of sites) {
          // A string literal here would be a hardcoded guess; `undefined`/`null`
          // would silently disable the fallback while satisfying nothing.
          expect(site[1]).not.toMatch(/^["'`]/);
          expect(site[1]).not.toMatch(/^(undefined|null)$/);
        }
      });
    });
  }
});

describe("the Commander probe helper takes its adapter type from its caller", () => {
  const svc = readFileSync(join(serverSrc, "services/commander-verify.ts"), "utf8");
  const route = readFileSync(join(serverSrc, "routes/commander-verify.ts"), "utf8");

  it("resolveCommanderProbeConfig declares an adapterType parameter", () => {
    expect(svc).toMatch(/export async function resolveCommanderProbeConfig\([\s\S]*?adapterType:\s*string/);
  });

  it("the route passes the adapterType it already resolved (not a second resolution)", () => {
    expect(route).toMatch(/resolveCommanderProbeConfig\(\s*db,\s*companyId,\s*adapterType\s*,/);
    // `resolveCommanderAdapterType` must still be called exactly once — the
    // adapter the probe RUNS must be the one whose credential it resolves.
    expect(route.match(/resolveCommanderAdapterType\(/g)).toHaveLength(1);
  });

  it("cliToolToAdapterType only ever yields real adapter types", () => {
    // The helper the route's resolution ultimately funnels through.
    const literals = [...svc.matchAll(/return "([a-z_]+)";/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(AGENT_ADAPTER_TYPES as readonly string[]).toContain(literal);
    }
  });
});

describe("the service signature admits no default adapter type", () => {
  const src = readFileSync(join(serverSrc, "services/secrets.ts"), "utf8");
  const i = src.indexOf("async resolveAdapterConfigForRuntime(");
  const signature = src.slice(i, src.indexOf(")", i));

  it("declares adapterType as a required parameter", () => {
    expect(i).toBeGreaterThan(-1);
    expect(signature).toMatch(/adapterType:\s*string\s*,/);
  });

  it("gives adapterType no default value and does not mark it optional", () => {
    // A default would silently reintroduce the guessing problem the explicit
    // parameter exists to remove; TypeScript failing the build until all six
    // sites are updated IS the safety net.
    expect(signature).not.toMatch(/adapterType[^,]*=/);
    expect(signature).not.toMatch(/adapterType\?/);
  });
});
