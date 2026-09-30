import { describe, expect, it, vi } from "vitest";
const { execMock, createEventMock, buildMcpMock, buildBridgeSpecMock, writeFileMock, resolveConnectorsMock, runLogStoreMock } = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({ mcpServers: {} })),
  // Task 2 (Plan 2): capture what the runner writes to the --mcp-config tmp file
  // so a connector test can prove the placeholder (never the plaintext secret)
  // lands on disk. Default no-op preserves the pre-task behavior for every other
  // test (they don't inspect writeFile).
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  // Task 2 (Plan 2): the crew connector delivery seam. Default = no connectors
  // so the existing claude tests (cl-1..cl-4) stay byte-identical; the connector
  // + regression tests override per-call with mockResolvedValueOnce.
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {} }),
  // T1: the runner opens a run transcript before adapter.execute. run-log-store
  // imports `node:fs` — a DIFFERENT specifier than the `node:fs/promises` this
  // file mocks — so without this the "mocked" runner would do REAL filesystem
  // I/O, scattering .ndjson files keyed on fixture ids (co-1/ext-1/run-1) that
  // repeat across test files. vitest runs files in parallel workers and begin()
  // TRUNCATES, so that is a latent cross-file flake, not just litter.
  runLogStoreMock: {
    begin: vi.fn().mockResolvedValue({ store: "local_file", logRef: "co-1/ext-1/run-1.ndjson" }),
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    read: vi.fn(),
  },
  // MX2: runner now also builds the provider-neutral bridge spec. Mock mirrors
  // buildMcpBridgeSpec's shape ({command:"node",args,env}) keyed off the params
  // the runner passes (companyId → AOA_SESSION_COMPANY_ID) so the contract is
  // observable without importing the real cli-mode module.
  buildBridgeSpecMock: vi.fn((p: any) => ({
    command: "node",
    args: ["/x/mcp-bridge.js"],
    env: { AOA_SESSION_COMPANY_ID: p?.companyId ?? "" },
  })),
}));
// Task 8: the runtime resolver now also looks up the company-level
// `provider:<id>` secret, so these harnesses must model `isNull` + the
// company_secrets tables. The stubbed row that comes back has no
// `status: "active"`, so it is skipped and no key is injected — these tests
// keep asserting exactly what they asserted before.
vi.mock("drizzle-orm", () => ({ and:(...a:unknown[])=>({and:a}), eq:(a:unknown,b:unknown)=>({eq:[a,b]}), isNull:(a:unknown)=>({isNull:a}) }));
vi.mock("@armyofagents/db", () => { const t=(n:string)=>new Proxy({},{get:(_x,p)=>typeof p==="string"?Symbol(`${n}.${p}`):undefined}); return { agents:t("a"), internalAgentRuns:t("iar"), discussionEntries:t("de"), memoryItems:t("mi"), discussions:t("disc"), discussionExtractedItems:t("dei"), embeddingQueue:t("eq"), memoryItemVersions:t("miv"), memoryRetrievals:t("mr"), suggestions:t("sug"), companySecrets:t("cs"), companySecretVersions:t("csv"), companySecretBindings:t("csb"), companySecretProviderConfigs:t("cspc"), runtimeProviderKeys:t("rpk"), secretAccessEvents:t("sae") }; });
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: createEventMock }) }));
// U4b: buildCodexAoaMcpSpec is the brokered-aware selector runner.ts now calls
// for ctx.mcpBridge. This suite exercises the desktop/non-sandbox path
// (acquireExecutionContext mocked to sandbox:null -> brokered:false), where
// buildCodexAoaMcpSpec falls through to plain buildMcpBridgeSpec — so the
// SAME mock produces byte-identical output. (brokered-mcp-no-db-url covers
// the brokered:true branch for real.)
vi.mock("../services/internal-agent/cli-mode.js", () => ({ buildMcpConfig: buildMcpMock, buildMcpBridgeSpec: buildBridgeSpecMock, buildCodexAoaMcpSpec: buildBridgeSpecMock }));
vi.mock("../services/heartbeat.js", () => ({ resolveAdapterExecutionContextUnguarded: () => ({ executionTarget:{}, runtimeCommandSpec:{} }), resolveGuardedAdapterExecutionContext: () => ({ executionTarget:{}, runtimeCommandSpec:{} }), applyEnvironmentAcquisitionConfig: (config: unknown) => config }));
// U4: crew now acquires a sandbox lease before buildMcpConfig. These tests
// exercise the desktop/local no-sandbox path (byte-identical), so the helper
// is stubbed to the real no-environment return shape rather than exercising
// the real orchestrator against this file's Proxy-mocked db.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));
vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({ resolveBridgeEntrypoint: () => "/x/mcp-bridge.js" }));
// T5: the runner now resolves an execution workspace before adapter.execute,
// which mkdir's the per-agent home and stat's candidate cwds through this same
// mocked module. `workspace-resolution.ts` imports the DEFAULT export, the
// runner the named writeFile/unlink — provide both shapes. Task 2 (Plan 2):
// `writeFile` is `writeFileMock` so the connector test can prove the placeholder
// (never the plaintext secret) lands on the --mcp-config tmp file.
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: writeFileMock,
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
  return { ...api, default: api };
});
// Phase 4: the runner now routes through the unified provider resolver before
// provider-status detection. These specs assert the exact delivered config.env,
// so mock the resolver to a passthrough (agent_env_override ⇒ applyResolvedCredential
// is a no-op) — keeps env byte-identical and never touches the mock DB.
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));
vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: resolveConnectorsMock,
  loadConnectorEgressHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: () => runLogStoreMock }));
vi.mock("../middleware/logger.js", () => ({ logger:{ child:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()}) } }));
// T5: crew workspace resolution reads the instance experimental flags. Without
// this stub the access THROWS and the resolver's tolerant catch absorbs it —
// the suite would then only ever exercise the failure branch, and the fs/table
// stubs above would be dead.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
}));

import { discussionEntries } from "@armyofagents/db";
import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";
function ch(ret:unknown[]){const c:any={};c.values=()=>c;c.set=()=>c;c.where=()=>c;c.from=()=>c;c.returning=()=>Promise.resolve(ret);c.then=(r:(v:unknown[])=>unknown)=>Promise.resolve(ret).then(r);return c;}
it("happy: bridge attached via adapterConfig.args, run completed, cost emitted, agentId stamped", async () => {
  const insertedRuns:any[]=[];
  const db:any = {
    select:()=>ch([{ id:"ext-1", companyId:"co-1", name:"Scribe", adapterType:"process", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:(v:any)=>{ insertedRuns.push(v); return { returning:()=>Promise.resolve([{id:"run-1"}]) }; } }),
    update:()=>ch([{ id:"e1" }]), // claim returns non-empty (claimed)
  };
  await runAoaAgent(db, "ext-1", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  expect(buildMcpMock).toHaveBeenCalled();
  const execArg = execMock.mock.calls[0][0];
  // MX2: superseded-test update (controller-authorized). The old assertion
  // `execArg.config.args).toContain("--mcp-config")` pinned the pre-MX2
  // claude-only-for-ALL-adapters delivery this milestone deliberately
  // generalizes. The real contract is now two-pronged and re-asserted here:
  //  (a) non-claude adapters (this agent is adapterType:"process") must NOT
  //      get the bogus claude --mcp-config flag leaked into config.args;
  //  (b) the neutral mcpBridge spec is handed to every adapter via ctx.
  // process adapter has no adapterConfig.args, so config.args is absent; the
  // contract is simply "the bogus claude flag never appears". Default to []
  // so the assertion is robust whether args is absent or a real array.
  expect(execArg.config.args ?? []).not.toContain("--mcp-config");
  expect(execArg.mcpBridge).toMatchObject({ command:"node" });
  expect(Array.isArray(execArg.mcpBridge.args)).toBe(true);
  expect(execArg.mcpBridge.env).toMatchObject({ AOA_SESSION_COMPANY_ID:"co-1" });
  // T1: the run transcript is opened for the agent+run, and the sink is REALLY
  // wired to the adapter — the pre-T1 bug was two literal no-op callbacks that
  // silently discarded every byte, so asserting the callbacks reach the store is
  // the whole point.
  expect(runLogStoreMock.begin).toHaveBeenCalledWith({ companyId:"co-1", agentId:"ext-1", runId:"run-1" });
  await execArg.onLog("stdout", "transcript chunk");
  expect(runLogStoreMock.append.mock.calls.at(-1)?.[1]).toMatchObject({ stream:"stdout", chunk:"transcript chunk" });
  expect(insertedRuns[0].agentId).toBe("ext-1");          // Finding R1: run attributed to the agent
  expect(createEventMock).toHaveBeenCalledTimes(1);
  expect(createEventMock.mock.calls[0][1].agentId).toBe("ext-1");
  expect(createEventMock.mock.calls[0][1].costCents).toBe(0); // §16.3 zeroed
});
it("claude-family: --mcp-config tmp file kept (byte-identical) AND mcpBridge also set", async () => {
  execMock.mockClear();
  const db:any = {
    select:()=>ch([{ id:"cl-1", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-c"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-1", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const execArg = execMock.mock.calls[0][0];
  // claude_local keeps the pre-MX2 delivery BYTE-IDENTICAL: --mcp-config
  // followed by the aoa-mcp-<agentId>-<runId>.json tmp path, prepended to args.
  expect(execArg.config.args[0]).toBe("--mcp-config");
  expect(String(execArg.config.args[1])).toMatch(/aoa-mcp-cl-1-run-c\.json$/);
  // ...and the neutral bridge spec is ALSO handed over (MX3 consumes it).
  expect(execArg.mcpBridge).toMatchObject({ command:"node" });
  expect(execArg.mcpBridge.env).toMatchObject({ AOA_SESSION_COMPANY_ID:"co-1" });
});
it("claude-family: user-injected --mcp-config in adapterConfig.args is stripped, AoA's own survives (Task 12, args key)", async () => {
  execMock.mockClear();
  const db:any = {
    // adapterConfig.ARGS carries the injection (no extraArgs set) → AoA's prefix
    // lands in `args` (the adapter-preferred key when extraArgs is absent).
    select:()=>ch([{ id:"cl-2", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{ args:["--mcp-config","C:/evil.json","--strict-mcp-config","--model","opus"] }, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-c2"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-2", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const args = execMock.mock.calls[0][0].config.args as string[];
  // Property 1 — hole closed: the smuggled external config is gone.
  expect(args).not.toContain("C:/evil.json");
  expect(args.filter((a)=>a==="--mcp-config")).toHaveLength(1);       // only AoA's own
  expect(args.filter((a)=>a==="--strict-mcp-config")).toHaveLength(1); // only AoA's own
  // Property 2 — AoA's own injection SURVIVES (the anti-regression trap).
  expect(args[0]).toBe("--mcp-config");
  expect(String(args[1])).toMatch(/aoa-mcp-cl-2-run-c2\.json$/);
  expect(args[2]).toBe("--strict-mcp-config");
  // The user's benign, unrelated args are preserved.
  expect(args).toContain("--model");
  expect(args).toContain("opus");
});
it("claude-family: user-injected --mcp-config in adapterConfig.EXTRAARGS is stripped, AoA lands in the adapter-preferred key (Task 12, extraArgs escape hatch)", async () => {
  // THE MISSING REGRESSION. The UI "Extra args" box writes adapterConfig.extraArgs
  // (build-config.ts), and the claude-local adapter PREFERS extraArgs over args
  // (execute.ts). A founder sets Extra args to `--mcp-config,C:\evil.json`. AoA
  // MUST inject into extraArgs (the key the adapter reads) with the user tail
  // sanitized — else the evil config is delivered AND AoA's own config (if it
  // went to `args`) is shadowed. Mutation check: revert runner to hardcoded
  // `args:` and this test fails (extraArgs still holds evil.json, no AoA prefix).
  execMock.mockClear();
  const db:any = {
    select:()=>ch([{ id:"cl-3", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{ extraArgs:["--mcp-config","C:/evil.json"] }, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-c3"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-3", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const delivered = execMock.mock.calls[0][0].config;
  // AoA's prefix must land in the ADAPTER-PREFERRED key (extraArgs), NOT args.
  const extraArgs = delivered.extraArgs as string[];
  // Property 1 — hole closed: the smuggled external config is gone from extraArgs.
  expect(extraArgs).not.toContain("C:/evil.json");
  expect(extraArgs.filter((a)=>a==="--mcp-config")).toHaveLength(1);       // only AoA's own
  expect(extraArgs.filter((a)=>a==="--strict-mcp-config")).toHaveLength(1); // only AoA's own
  // Property 2 — AoA's own injection SURVIVES in the key the adapter reads.
  expect(extraArgs[0]).toBe("--mcp-config");
  expect(String(extraArgs[1])).toMatch(/aoa-mcp-cl-3-run-c3\.json$/);
  expect(extraArgs[2]).toBe("--strict-mcp-config");
});
it("claude-family: enabled http connector delivered to crew — spec threaded into --mcp-config (placeholder), real secret ONLY in config.env (Plan 2 Task 2)", async () => {
  execMock.mockClear(); buildMcpMock.mockClear(); writeFileMock.mockClear(); resolveConnectorsMock.mockClear();
  // The crew connector seam: this agent has ONE enabled http connector. The
  // env carries the REAL token; the spec header carries only the placeholder.
  resolveConnectorsMock.mockResolvedValueOnce({
    extraMcpServers: { notion: { kind:"http", url:"https://mcp.notion.com/mcp", headers:{ Authorization:"Bearer ${AOA_MCP_NOTION_TOKEN}" } } },
    connectorEnv: { AOA_MCP_NOTION_TOKEN: "secret-abc" },
  });
  // buildMcpConfig is mocked; reflect extraMcpServers into the built config so the
  // written FILE models the real mergeExternalMcpServers output (the real merge is
  // unit-tested in the pure connector module — here we prove the runner THREADS +
  // WRITES it, and that the plaintext secret never reaches disk).
  buildMcpMock.mockImplementationOnce((p:any) => ({ mcpServers: { aoa: {}, ...(p?.extraMcpServers ?? {}) } }));
  const db:any = {
    select:()=>ch([{ id:"cl-conn", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-conn"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-conn", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });

  // (a) per-agent opt-in: resolved with the REAL agentId (not null) + companyId.
  expect(resolveConnectorsMock).toHaveBeenCalledTimes(1);
  expect(resolveConnectorsMock.mock.calls[0][1]).toMatchObject({ companyId:"co-1", agentId:"cl-conn" });

  // (b) threading: buildMcpConfig received the connector spec with the PLACEHOLDER
  // header — never the plaintext secret.
  const builtArg = buildMcpMock.mock.calls[buildMcpMock.mock.calls.length-1][0];
  expect(builtArg.extraMcpServers.notion.headers.Authorization).toBe("Bearer ${AOA_MCP_NOTION_TOKEN}");
  expect(JSON.stringify(builtArg.extraMcpServers)).not.toContain("secret-abc");

  // (c) on disk: the written --mcp-config file has notion + placeholder, NEVER the token.
  const written = writeFileMock.mock.calls.map((c:any)=>String(c[1])).join("\n");
  expect(written).toContain("notion");
  expect(written).toContain("${AOA_MCP_NOTION_TOKEN}");
  expect(written).not.toContain("secret-abc");

  // (d) the REAL token rides ONLY in the delivered spawn env.
  const execArg = execMock.mock.calls[0][0];
  expect(execArg.config.env.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");

  // (e) Task-12 mcp-config args preserved.
  expect(execArg.config.args[0]).toBe("--mcp-config");
  expect(execArg.config.args).toContain("--strict-mcp-config");
});
it("claude-family: NO connectors → delivered config.env byte-identical (no AOA_MCP keys added) — Plan 2 regression guard", async () => {
  execMock.mockClear(); resolveConnectorsMock.mockClear();
  // Default seam returns empty; assert the runner adds NOTHING to env vs the
  // pre-task delivery. resolvedBaseConfig.env is {} for an empty adapterConfig
  // (resolveAdapterConfigForRuntime always sets env = {}), so the merge is a
  // no-op and env stays exactly {}.
  resolveConnectorsMock.mockResolvedValueOnce({ extraMcpServers: {}, connectorEnv: {} });
  const db:any = {
    select:()=>ch([{ id:"cl-noconn", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-nc"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-noconn", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const execArg = execMock.mock.calls[0][0];
  // env unchanged (no connector token merged in).
  expect(execArg.config.env).toEqual({});
  // Task-12 delivery still intact.
  expect(execArg.config.args[0]).toBe("--mcp-config");
});
it("claude-family: benign non-empty extraArgs → AoA prefix lands in extraArgs, benign args preserved (Task 12, shadow guard)", async () => {
  // Even a BENIGN extraArgs (e.g. --model opus) would be preferred by the adapter
  // and shadow AoA's config if AoA injected into `args`. AoA must land in
  // extraArgs so its --mcp-config is the one the adapter actually reads.
  execMock.mockClear();
  const db:any = {
    select:()=>ch([{ id:"cl-4", companyId:"co-1", name:"Scribe", adapterType:"claude_local", adapterConfig:{ extraArgs:["--model","opus"] }, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-c4"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cl-4", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const extraArgs = execMock.mock.calls[0][0].config.extraArgs as string[];
  // AoA's --mcp-config cfgPath --strict-mcp-config lands in extraArgs (adapter-read key).
  expect(extraArgs[0]).toBe("--mcp-config");
  expect(String(extraArgs[1])).toMatch(/aoa-mcp-cl-4-run-c4\.json$/);
  expect(extraArgs[2]).toBe("--strict-mcp-config");
  // The benign user flag is preserved, and `opus` is NOT mistaken for a config value.
  expect(extraArgs).toContain("--model");
  expect(extraArgs).toContain("opus");
  expect(extraArgs.filter((a)=>a==="--mcp-config")).toHaveLength(1);
});
it("failure isolated: adapter throws → never rethrows", async () => {
  execMock.mockRejectedValueOnce(new Error("boom"));
  const db:any = { select:()=>ch([{ id:"ext-1", companyId:"co-1", name:"Scribe", adapterType:"process", adapterConfig:{}, runtimeConfig:{} }]), insert:()=>ch([{id:"run-2"}]), update:()=>ch([{id:"e2"}]) };
  // T1.0: runner now returns AoaRunResult instead of void. Adapter threw,
  // so we expect status='failed' with the thrown message.
  const r1 = await runAoaAgent(db,"ext-1",{ companyId:"co-1", source:"discussion_entry_pending", entryId:"e2" });
  expect(r1.status).toBe("failed");
  expect(r1.errorMessage).toBe("boom");
});
it("SECURITY (Layer C): agent.companyId !== payload.companyId → refuses (failed), no run/mcpParams/adapter built", async () => {
  execMock.mockClear();
  buildMcpMock.mockClear();
  buildBridgeSpecMock.mockClear();
  // The loaded agent belongs to "co-OTHER" but the run's company (from the
  // trusted wakeup row) is "co-1". A company-A agent must never execute in
  // another company's context — the backstop refuses before any run row,
  // mcpParams, or adapter execution is built.
  const insertedRuns: any[] = [];
  const db: any = {
    select: () => ch([{ id: "ext-1", companyId: "co-OTHER", name: "Scribe", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }]),
    insert: () => ({ values: (v: any) => { insertedRuns.push(v); return { returning: () => Promise.resolve([{ id: "run-x" }]) }; } }),
    update: () => ch([{ id: "e1" }]),
  };
  const r = await runAoaAgent(db, "ext-1", { companyId: "co-1", source: "agent.dispatch" });
  expect(r.status).toBe("failed");
  expect(r.errorMessage).toBe("aoa agent company mismatch");
  expect(r.runId).toBeNull();
  // Refused before the run row insert, the mcp bridge build, and adapter exec.
  expect(insertedRuns).toHaveLength(0);
  expect(buildMcpMock).not.toHaveBeenCalled();
  expect(buildBridgeSpecMock).not.toHaveBeenCalled();
  expect(execMock).not.toHaveBeenCalled();
});
it("not claimable (concurrent): atomic claim empty → adapter NOT called, returns", async () => {
  execMock.mockClear();
  const claimChain:any = { set:()=>claimChain, where:()=>claimChain, returning:()=>Promise.resolve([]) }; // claim RETURNING empty
  const db:any = {
    select:()=>ch([{ id:"ext-1", companyId:"co-1", name:"Scribe", adapterType:"process", adapterConfig:{}, runtimeConfig:{} }]),
    insert:()=>ch([{ id:"run-9" }]),
    // Discriminate by TABLE, not by call order: the runner now also writes the
    // run-log pointer (internal_agent_runs.log_store/log_ref) before the claim,
    // so a positional "1st update === the claim" harness silently handed the
    // claim a non-empty result and the run proceeded past the abort.
    update:(tbl:unknown)=> (tbl === discussionEntries ? claimChain : ch([{ id:"run-9" }])),
  };
  // T1.0: not-claimable returns succeeded (it's a concurrent race, not a
  // failure — another run owns this entry). Pre-T1.0 this was undefined.
  // P1-C: claim gate requires source="outbox". Other sources skip the claim
  // (and therefore the not-claimable abort path). Using "outbox" preserves
  // the test's original intent: claim attempted, empty result → adapter NOT
  // called, function returns early.
  const r9 = await runAoaAgent(db,"ext-1",{ companyId:"co-1", source:"outbox", entryId:"e9" });
  expect(r9.status).toBe("succeeded");
  expect(execMock).not.toHaveBeenCalled();
});
it("NON-claude crew (codex_local): connectorEnv merged into delivered config.env AND specs handed over on ctx.mcpServers (Plan 2b Task 3)", async () => {
  execMock.mockClear(); resolveConnectorsMock.mockClear();
  // The Plan-2b widening: a codex crew agent is connector-capable, so the loader
  // runs for it and BOTH halves of the delivery must arrive — the real token in
  // config.env (every adapter copies config.env into its spawn env) and the
  // specs on the ctx.mcpServers carrier that Tasks 4-6 will read.
  resolveConnectorsMock.mockResolvedValueOnce({
    extraMcpServers: { notion: { kind:"http", url:"https://mcp.notion.com/mcp", headers:{ Authorization:"Bearer ${AOA_MCP_NOTION_TOKEN}" } } },
    connectorEnv: { AOA_MCP_NOTION_TOKEN: "secret-abc" },
  });
  const db:any = {
    select:()=>ch([{ id:"cx-conn", companyId:"co-1", name:"Scribe", adapterType:"codex_local", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-cx"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cx-conn", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });

  // (a) the gate widened: the loader ran for a NON-claude adapter, per-agent.
  expect(resolveConnectorsMock).toHaveBeenCalledTimes(1);
  expect(resolveConnectorsMock.mock.calls[0][1]).toMatchObject({ companyId:"co-1", agentId:"cx-conn" });

  const execArg = execMock.mock.calls[0][0];
  // (b) the REAL token rides in the delivered config.env (→ child spawn env).
  expect(execArg.config.env.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");
  // (c) the specs reach the adapter on the previously-inert carrier.
  expect(execArg.mcpServers).toBeDefined();
  expect(execArg.mcpServers.notion).toMatchObject({ kind:"http", url:"https://mcp.notion.com/mcp" });
  // (d) claude-only delivery must NOT leak into a codex argv.
  expect(execArg.config.args ?? []).not.toContain("--mcp-config");
  expect(execArg.config.extraArgs ?? []).not.toContain("--mcp-config");
});
it("NON-claude crew (codex_local): NO connectors → delivered config.env byte-identical (Plan 2b regression guard)", async () => {
  execMock.mockClear(); resolveConnectorsMock.mockClear();
  resolveConnectorsMock.mockResolvedValueOnce({ extraMcpServers: {}, connectorEnv: {} });
  const db:any = {
    select:()=>ch([{ id:"cx-noconn", companyId:"co-1", name:"Scribe", adapterType:"codex_local", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-cxn"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "cx-noconn", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  const execArg = execMock.mock.calls[0][0];
  // No connector token merged in; env stays exactly what the runtime resolver set.
  expect(execArg.config.env).toEqual({});
  // And still no claude-only args on a codex delivery.
  expect(execArg.config.args ?? []).not.toContain("--mcp-config");
});
it("NON-connector-capable crew (process): the connector DB read is skipped entirely (Plan 2b Task 3)", async () => {
  execMock.mockClear(); resolveConnectorsMock.mockClear();
  const db:any = {
    select:()=>ch([{ id:"px-1", companyId:"co-1", name:"Scribe", adapterType:"process", adapterConfig:{}, runtimeConfig:{ aoa:{ instruction:"do extraction", role:"scribe" } } }]),
    insert:()=>({ values:()=>({ returning:()=>Promise.resolve([{id:"run-px"}]) }) }),
    update:()=>ch([{ id:"e1" }]),
  };
  await runAoaAgent(db, "px-1", { companyId:"co-1", source:"discussion_entry_pending", entryId:"e1" });
  // `process` has no MCP client at all — widening the gate must not make it pay
  // for a connector lookup (wasted I/O + a needless per-run failure surface).
  expect(resolveConnectorsMock).not.toHaveBeenCalled();
  expect(execMock.mock.calls[0][0].mcpServers).toBeUndefined();
});
