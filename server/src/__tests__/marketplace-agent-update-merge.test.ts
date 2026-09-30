/**
 * T2.7 — the reviewed agent merge, against the REAL filesystem-backed
 * `agentInstructionsService`.
 *
 * The instructions service is deliberately not mocked: every claim this task
 * makes is about BYTES on disk surviving (or not surviving) a landing, and a
 * mocked writer can only prove that a function was called.
 *
 * Only the database and the two network fetches are stubbed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstreamState = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  entryFile: "AGENTS.md",
  body: "",
}));

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(async () => upstreamState.body),
}));
vi.mock("../services/marketplace-install/agent-create.js", () => ({
  loadMarketplaceInstructionFiles: vi.fn(async () => ({
    files: { ...upstreamState.files },
    entryFile: upstreamState.entryFile,
  })),
}));
vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (_t, prop) => (prop === "__table" ? name : Symbol(String(prop))) },
    );
  return {
    agents: table("agents"),
    aoaAgentTriggers: table("aoaAgentTriggers"),
    marketplacePendingUpdates: table("marketplacePendingUpdates"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { agentInstructionsService } from "../services/agent-instructions.js";
import {
  AgentMergeConflictError,
  computeAgentUpdateDiff,
  mergeAgentUpdate,
  readAgentInstructionSnapshot,
  type MergeableAgentRow,
} from "../services/marketplace-install/agent-update-merge.js";
import { applyCrewAgentUpdate } from "../services/marketplace-install/crew-updater.js";
import { agentSectionKey } from "../services/marketplace-agent-merge.js";

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * A published crew agent body. Shape mirrors
 * `__fixtures__/published-catalog/aoa-scout.agent.json` — `instructions` is a
 * `{ type: "file" }` reference (what all 9 published `aoa-curated` crew agents
 * use), triggers carry `enabled`, and `aoa.runtimeConfig.aoa` carries the
 * toolAllowlist.
 */
function agentBody(opts?: { skillKeys?: string[]; triggerEnabled?: boolean }) {
  return JSON.stringify({
    schemaVersion: "agent.v1",
    id: "aoa-scout",
    name: "Scout",
    description: "Internal-only research and investigation for threads.",
    instructions: { type: "file", path: "AGENTS.md" },
    aoa: {
      adapterType: "process",
      kind: "aoa",
      runtimeConfig: { aoa: { role: "member", toolAllowlist: ["query_threads", "post_entry"] } },
      skillKeys: opts?.skillKeys ?? ["research"],
      triggers: [{ kind: "mention", enabled: opts?.triggerEnabled ?? true, config: { role: "scout" } }],
    },
  });
}

const CATALOG_ITEM = {
  id: "agent:aoa-curated/aoa-scout",
  type: "agent" as const,
  name: "Scout",
  version: "0.3.0",
  description: "Internal-only research and investigation for threads.",
  source: { adapter: "aoa-curated", url: "https://example.com", locator: "aoa-scout", commitSha: "abc" },
  resourceUrl: "https://example.com/agent.json",
  trust: { tier: "verified" as const, source: "aoa-curated" },
  status: "active" as const,
  addedAt: "2026-01-01T00:00:00Z",
  category: "crew",
  tags: [],
  requires: [],
};

const INSTALLED_AGENTS_MD = `You are Scout — research and investigation for threads.

## Sources
find_similar_memory_hnsw
query_threads

## Output
Post ONE synthesis entry.
`;

const UPSTREAM_AGENTS_MD = `You are Scout — research and investigation for threads.

## Sources
find_similar_memory_hnsw
query_threads
search_discussions

## Output
Post ONE synthesis entry.

## Escalation
Hand back to Adjutant when blocked.
`;

const FOUNDER_EDITED_AGENTS_MD = `You are Scout — research and investigation for threads.

## Sources
find_similar_memory_hnsw
query_threads

## Output
Post ONE synthesis entry, and ALWAYS write it in Norwegian.
Cite the thread id of every precedent you used.
`;

// ── db harness ─────────────────────────────────────────────────────────────

interface DbHarness {
  db: unknown;
  agentSets: Record<string, unknown>[];
  pendingSets: Record<string, unknown>[];
  triggerInserts: Record<string, unknown>[];
  triggerDeletes: number;
}

function makeDb(opts?: { pendingClaimReturns?: unknown[]; agentUpdateReturns?: unknown[] }): DbHarness {
  const harness: DbHarness = {
    db: undefined,
    agentSets: [],
    pendingSets: [],
    triggerInserts: [],
    triggerDeletes: 0,
  };

  const tx = {
    update: (table: { __table: string }) => ({
      set: (values: Record<string, unknown>) => {
        const isPending = table.__table === "marketplacePendingUpdates";
        if (isPending) harness.pendingSets.push(values);
        else harness.agentSets.push(values);
        return {
          where: () => ({
            returning: async () =>
              isPending
                ? (opts?.pendingClaimReturns ?? [{ id: "pending-1" }])
                : (opts?.agentUpdateReturns ?? [{ id: "agent-1" }]),
          }),
        };
      },
    }),
    delete: () => ({
      where: async () => {
        harness.triggerDeletes += 1;
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        harness.triggerInserts.push(v);
      },
    }),
  };

  harness.db = {
    // `applyCrewAgentUpdate`'s single-row re-read (the ablation path).
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ instructionsCustomized: false }] }) }),
    }),
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return harness;
}

// ── environment ────────────────────────────────────────────────────────────

const AGENT_ID = "agent-1";
const COMPANY_ID = "company-1";

let tempHome: string;
const instructions = agentInstructionsService();

function managedRoot() {
  return path.resolve(tempHome, "instances", "t27", "companies", COMPANY_ID, "agents", AGENT_ID, "instructions");
}

async function readManaged(file: string) {
  return fs.readFile(path.join(managedRoot(), file), "utf8");
}

/**
 * Bring an agent into the state a marketplace install leaves it in, then
 * optionally let the founder edit a file — through the very editor route
 * (`writeFile`) that stamps `instructions_customized`.
 */
async function installAgent(opts?: {
  founderEdit?: string;
  extraFiles?: Record<string, string>;
  adapterConfigSeed?: Record<string, unknown>;
  name?: string;
}): Promise<MergeableAgentRow> {
  const base = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: opts?.name ?? "Scout",
    adapterConfig: opts?.adapterConfigSeed ?? {},
  };
  const materialized = await instructions.materializeManagedBundle(
    base,
    { "AGENTS.md": INSTALLED_AGENTS_MD, ...(opts?.extraFiles ?? {}) },
    { entryFile: "AGENTS.md", replaceExisting: true, clearLegacyPromptTemplate: false },
  );
  let adapterConfig = materialized.adapterConfig;

  if (opts?.founderEdit) {
    const written = await instructions.writeFile(
      { ...base, adapterConfig },
      "AGENTS.md",
      opts.founderEdit,
    );
    adapterConfig = written.adapterConfig;
  }

  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: base.name,
    adapterType: "claude_local",
    adapterConfig,
    runtimeConfig: { aoa: { toolAllowlist: ["old_tool"] } },
    skillKeys: ["old-skill"],
    templateOrigin: CATALOG_ITEM.id,
    templateVersion: "0.2.0",
    instructionsCustomized: opts?.founderEdit ? true : false,
  };
}

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-t27-"));
  process.env.AOA_HOME = tempHome;
  process.env.AOA_INSTANCE_ID = "t27";
  upstreamState.body = agentBody();
  upstreamState.files = { "AGENTS.md": UPSTREAM_AGENTS_MD };
  upstreamState.entryFile = "AGENTS.md";
});

afterEach(async () => {
  delete process.env.AOA_HOME;
  delete process.env.AOA_INSTANCE_ID;
  await fs.rm(tempHome, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("computeAgentUpdateDiff", () => {
  it("produces a section-level diff over the agent's instruction files", async () => {
    const agent = await installAgent({ founderEdit: FOUNDER_EDITED_AGENTS_MD });
    const { diff, identical } = await computeAgentUpdateDiff({
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
    });

    expect(identical).toBe(false);
    const bySection = Object.fromEntries(diff.map((s) => [s.section, s.state]));
    expect(bySection.Sources).toBe("changed");
    expect(bySection.Output).toBe("changed");
    expect(bySection.Escalation).toBe("added");
    // Every key is file-scoped, which is what makes a multi-file bundle
    // reviewable at all.
    expect(diff.every((s) => s.header.startsWith("AGENTS.md::"))).toBe(true);
  });

  it("reports `identical` for a bundle that matches the catalog byte-for-byte", async () => {
    upstreamState.files = { "AGENTS.md": INSTALLED_AGENTS_MD };
    const agent = await installAgent();
    const { identical } = await computeAgentUpdateDiff({
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
    });
    expect(identical).toBe(true);
  });
});

describe("mergeAgentUpdate — keep mine", () => {
  it("leaves the founder's section BYTE-IDENTICAL on disk while taking upstream elsewhere", async () => {
    const agent = await installAgent({ founderEdit: FOUNDER_EDITED_AGENTS_MD });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {
        [agentSectionKey("AGENTS.md", "Sources")]: "theirs",
        [agentSectionKey("AGENTS.md", "Output")]: "mine",
        [agentSectionKey("AGENTS.md", "Escalation")]: "theirs",
      },
    });

    const onDisk = await readManaged("AGENTS.md");
    // The founder's two lines, verbatim and adjacent — not "contains the word
    // Norwegian somewhere".
    expect(onDisk).toContain(
      "Post ONE synthesis entry, and ALWAYS write it in Norwegian.\nCite the thread id of every precedent you used.",
    );
    // …and the sections they gave away really did move.
    expect(onDisk).toContain("search_discussions");
    expect(onDisk).toContain("Hand back to Adjutant when blocked.");

    expect(outcome.pureUpstream).toBe(false);
    expect(outcome.instructionsCustomized).toBe(true);
    expect(harness.agentSets[0]).toMatchObject({
      instructionsCustomized: true,
      templateVersion: "0.3.0",
    });
  });

  it("ABLATION: the pre-T2.7 landing path annihilates exactly those bytes", async () => {
    // Same founder edit, same catalog bump — but landed the only way an agent
    // update COULD land before this task: `applyCrewAgentUpdate`'s
    // full-replacement. (D22 normally refuses to run it on an edited row; this
    // presents a `false` row so the destruction is observable rather than
    // merely blocked, which is the whole reason D22 exists.)
    const agent = await installAgent({ founderEdit: FOUNDER_EDITED_AGENTS_MD });
    const harness = makeDb();

    await applyCrewAgentUpdate({
      db: harness.db as never,
      agentRow: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
        runtimeConfig: agent.runtimeConfig,
        skillKeys: agent.skillKeys ?? [],
        templateVersion: agent.templateVersion,
        instructionsCustomized: false,
      },
      catalogItem: CATALOG_ITEM,
      instructionsService: instructions,
    });

    const onDisk = await readManaged("AGENTS.md");
    expect(onDisk).not.toContain("Norwegian");
    expect(onDisk).not.toContain("Cite the thread id");
    expect(onDisk).toBe(UPSTREAM_AGENTS_MD);
  });

  it("keeps a founder-added sibling file that upstream does not carry", async () => {
    const agent = await installAgent({ extraFiles: { "NOTES.md": "## Scratch\nmine\n" } });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {}, // defaults: keep everything of mine, take new upstream material
    });

    expect(await readManaged("NOTES.md")).toBe("## Scratch\nmine\n");
    expect(outcome.pureUpstream).toBe(false);
    expect(outcome.instructionsCustomized).toBe(true);
  });
});

describe("mergeAgentUpdate — accept upstream", () => {
  it("lands upstream verbatim and re-opens the agent to auto-update", async () => {
    const agent = await installAgent({ founderEdit: FOUNDER_EDITED_AGENTS_MD });
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    expect(await readManaged("AGENTS.md")).toBe(UPSTREAM_AGENTS_MD);
    expect(outcome.pureUpstream).toBe(true);
    // The flag describes the CURRENT bundle. It now holds nothing but catalog
    // content, so freezing it out of auto-update forever would be a lie.
    expect(outcome.instructionsCustomized).toBe(false);
    expect(harness.agentSets[0]).toMatchObject({ instructionsCustomized: false });
  });

  it("DISCRIMINATOR: keeping one section is enough to stay customized", async () => {
    const agent = await installAgent({ founderEdit: FOUNDER_EDITED_AGENTS_MD });
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "theirs" as const]));
    decisions[agentSectionKey("AGENTS.md", "Output")] = "mine";
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions,
    });

    expect(outcome.instructionsCustomized).toBe(true);
    expect(await readManaged("AGENTS.md")).toContain("Norwegian");
  });

  it("drains a NULL-provenance agent by accepting upstream", async () => {
    // The T2.6 backlog: `instructions_customized IS NULL` (unknown → treated as
    // customized) on a bundle that is in fact untouched catalog content of the
    // PREVIOUS version. Reviewing it once and taking upstream has to be enough
    // to make it provably clean, or the backlog is permanent — every one of
    // these agents is frozen out of auto-update forever otherwise.
    const agent = await installAgent();
    agent.instructionsCustomized = null;
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    expect(outcome.instructionsCustomized).toBe(false);
    expect(await readManaged("AGENTS.md")).toBe(UPSTREAM_AGENTS_MD);
  });

  it("drains a NULL-provenance agent with NO decisions when the bundle already matches", async () => {
    // The other half of the backlog, and the cheaper one: the catalog bumped
    // only metadata, so the installed bytes are already the new bytes. The
    // default decisions are all "mine" — `pureUpstream` still has to come out
    // true, because it is computed from the resulting bytes, not the clicks.
    upstreamState.files = { "AGENTS.md": INSTALLED_AGENTS_MD };
    const agent = await installAgent();
    agent.instructionsCustomized = null;
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    expect(outcome.pureUpstream).toBe(true);
    expect(outcome.instructionsCustomized).toBe(false);
    expect(await readManaged("AGENTS.md")).toBe(INSTALLED_AGENTS_MD);
  });

  it("materializes an upstream-added sibling file onto disk", async () => {
    upstreamState.files = { "AGENTS.md": UPSTREAM_AGENTS_MD, "TOOLS.md": "## Tools\nnew\n" };
    const agent = await installAgent();
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    expect(await readManaged("TOOLS.md")).toBe("## Tools\nnew\n");
    expect(outcome.pureUpstream).toBe(true);
  });
});

describe("mergeAgentUpdate — legacy adapterConfig prompt fields", () => {
  it("keeps promptTemplate by default and blocks the pure-upstream claim", async () => {
    const agent = await installAgent({
      adapterConfigSeed: { promptTemplate: "legacy founder prompt" },
    });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    const written = harness.agentSets[0]!.adapterConfig as Record<string, unknown>;
    expect(written.promptTemplate).toBe("legacy founder prompt");
    expect(outcome.instructionsCustomized).toBe(true);
  });

  it("drops promptTemplate only when the founder accepts upstream for it", async () => {
    const agent = await installAgent({
      adapterConfigSeed: { promptTemplate: "legacy founder prompt" },
    });
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    const written = harness.agentSets[0]!.adapterConfig as Record<string, unknown>;
    expect(written.promptTemplate).toBeUndefined();
    expect(outcome.pureUpstream).toBe(true);
  });
});

describe("mergeAgentUpdate — catalog-owned fields and D23", () => {
  it("moves skillKeys, toolAllowlist and triggers with the templateVersion", async () => {
    const agent = await installAgent();
    const harness = makeDb();

    await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    const set = harness.agentSets[0]!;
    expect(set.skillKeys).toEqual(["research"]);
    expect(set.templateVersion).toBe("0.3.0");
    expect((set.runtimeConfig as { aoa: { toolAllowlist: string[] } }).aoa.toolAllowlist).toEqual([
      "query_threads",
      "post_entry",
    ]);
    expect(harness.triggerDeletes).toBe(1);
    expect(harness.triggerInserts).toHaveLength(1);
    expect(harness.triggerInserts[0]).toMatchObject({ kind: "mention", enabled: true });
  });

  it("honours a catalog trigger marked disabled (T2.3d composition)", async () => {
    upstreamState.body = agentBody({ triggerEnabled: false });
    const agent = await installAgent();
    const harness = makeDb();

    await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    expect(harness.triggerInserts[0]).toMatchObject({ enabled: false });
  });

  it("D23: a protected AoA agent keeps its triggers through a reviewed merge", async () => {
    const agent = await installAgent({ name: "Steward" });
    const harness = makeDb();

    await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    // D22 decides WHETHER an update lands; D23 narrows WHAT it writes. The
    // reviewed path must compose with D23 exactly as the auto path does, or a
    // founder-approved merge becomes the way to silently stop Steward.
    expect(harness.triggerDeletes).toBe(0);
    expect(harness.triggerInserts).toHaveLength(0);
  });
});

describe("mergeAgentUpdate — trim-equal divergence (F2)", () => {
  // `computeSectionDiff` calls a section `unchanged` on `.trim()` equality,
  // while the merge's wholesale-upstream relaxation requires BYTE equality. A
  // bundle differing from the catalog only by trailing whitespace therefore
  // produced an all-`unchanged` diff — reported to the founder as "no local
  // changes found" — that nonetheless merged to `instructions_customized =
  // true`. And with every section `unchanged` the pane rendered no per-section
  // buttons, so there was no control that could resolve it to upstream: a
  // permanent freeze-out announced as a success.
  const CLEAN = "You are Scout.\n\n## Output\nPost one entry.\n";
  const TRAILING_WS = `${CLEAN}\n`;

  beforeEach(() => {
    upstreamState.files = { "AGENTS.md": CLEAN };
  });

  it("reports `identical: false` for a whitespace-only divergence", async () => {
    const agent = await installAgent({ founderEdit: TRAILING_WS });
    const { diff, identical } = await computeAgentUpdateDiff({
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
    });

    // Every section still reads `unchanged` — that is the trap.
    expect(diff.every((s) => s.state === "unchanged")).toBe(true);
    // …but the honest byte test disagrees, and the modal copy follows this.
    expect(identical).toBe(false);
  });

  it("reaches customized = false once the founder accepts upstream", async () => {
    const agent = await installAgent({ founderEdit: TRAILING_WS });
    agent.instructionsCustomized = null;
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    expect(await readManaged("AGENTS.md")).toBe(CLEAN);
    expect(outcome.pureUpstream).toBe(true);
    expect(outcome.instructionsCustomized).toBe(false);
  });

  it("keeps the founder's exact bytes when they decline", async () => {
    const agent = await installAgent({ founderEdit: TRAILING_WS });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: {},
    });

    expect(await readManaged("AGENTS.md")).toBe(TRAILING_WS);
    expect(outcome.instructionsCustomized).toBe(true);
  });
});

describe("mergeAgentUpdate — byte fidelity through the real filesystem", () => {
  // The pure-function sweep covered these shapes; this pushes three of them
  // through the actual `agentInstructionsService` so an encoding assumption in
  // the writer cannot hide behind an in-memory stub.
  const SHAPES: [name: string, content: string][] = [
    ["BOM", "﻿# Scout\n\n## Output\nPost one entry.\n"],
    ["CRLF", "# Scout\r\n\r\n## Output\r\nPost one entry.\r\n"],
    ["no trailing newline + tabs", "# Scout\n\n## Output\n\tPost one entry.   "],
  ];

  for (const [name, content] of SHAPES) {
    it(`round-trips ${name} unchanged when the founder keeps everything`, async () => {
      upstreamState.files = { "AGENTS.md": UPSTREAM_AGENTS_MD };
      const agent = await installAgent({ founderEdit: content });
      const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
      const harness = makeDb();

      await mergeAgentUpdate({
        db: harness.db as never,
        instructions,
        agent,
        catalogItem: CATALOG_ITEM,
        pendingUpdateId: "pending-1",
        decisions: Object.fromEntries(diff.map((s) => [s.header, "mine" as const])),
      });

      expect(await readManaged("AGENTS.md")).toBe(content);
    });

    it(`writes ${name} verbatim when it is the upstream content and the founder accepts`, async () => {
      upstreamState.files = { "AGENTS.md": content };
      const agent = await installAgent({ founderEdit: "# Something else entirely\n" });
      const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
      const harness = makeDb();

      const outcome = await mergeAgentUpdate({
        db: harness.db as never,
        instructions,
        agent,
        catalogItem: CATALOG_ITEM,
        pendingUpdateId: "pending-1",
        decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
      });

      expect(await readManaged("AGENTS.md")).toBe(content);
      expect(outcome.instructionsCustomized).toBe(false);
    });
  }
});

describe("mergeAgentUpdate — no-op write suppression (F5)", () => {
  it("does not rewrite a file whose merged content already matches disk", async () => {
    upstreamState.files = { "AGENTS.md": UPSTREAM_AGENTS_MD, "TOOLS.md": "## Tools\nshared\n" };
    const agent = await installAgent({ extraFiles: { "TOOLS.md": "## Tools\nshared\n" } });
    const harness = makeDb();
    const before = await fs.stat(path.join(managedRoot(), "TOOLS.md"));

    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });

    // A delegating wrapper rather than a spy: `writeMergedAgentBundle` holds the
    // service by reference, and this records exactly what the merge asked to be
    // written without changing any behaviour.
    const written: string[] = [];
    const recording = {
      ...instructions,
      writeFile: async (a: Parameters<typeof instructions.writeFile>[0], p: string, c: string) => {
        written.push(p);
        return instructions.writeFile(a, p, c);
      },
    };

    await mergeAgentUpdate({
      db: harness.db as never,
      instructions: recording,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      // AGENTS.md genuinely changes; TOOLS.md is byte-identical on both sides.
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    // AGENTS.md diverges and is rewritten; TOOLS.md is byte-identical on both
    // sides and must be left alone — `writeFile` round-trips through a UTF-8
    // decode/encode, which churns mtime and would mangle a non-UTF-8 file.
    expect(written).toContain("AGENTS.md");
    expect(written).not.toContain("TOOLS.md");
    const after = await fs.stat(path.join(managedRoot(), "TOOLS.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("readAgentInstructionSnapshot — virtual-path collision (F7)", () => {
  it("excludes a REAL on-disk promptTemplate.legacy.md from review entirely", async () => {
    // `agentInstructionsService.readFile` short-circuits on this exact path and
    // returns `adapterConfig.promptTemplate` rather than the file's bytes, so
    // the merge genuinely cannot see the real content. It therefore refuses to
    // act on the path in either direction rather than writing the config value
    // over the founder's file.
    const agent = await installAgent({
      extraFiles: { "promptTemplate.legacy.md": "# a real file the founder wrote\n" },
      adapterConfigSeed: { promptTemplate: "the adapterConfig value" },
    });

    const snapshot = await readAgentInstructionSnapshot(instructions, agent);
    expect(snapshot.files).not.toHaveProperty("promptTemplate.legacy.md");
    expect(snapshot.virtualPaths.has("promptTemplate.legacy.md")).toBe(false);
    expect(snapshot.shadowedPaths.has("promptTemplate.legacy.md")).toBe(true);
  });

  it("a shadowed file blocks the pure-upstream claim and survives the merge", async () => {
    upstreamState.files = { "AGENTS.md": UPSTREAM_AGENTS_MD };
    const agent = await installAgent({
      extraFiles: { "promptTemplate.legacy.md": "# a real file the founder wrote\n" },
      adapterConfigSeed: { promptTemplate: "the adapterConfig value" },
    });
    const { diff } = await computeAgentUpdateDiff({ instructions, agent, catalogItem: CATALOG_ITEM });
    const harness = makeDb();

    const outcome = await mergeAgentUpdate({
      db: harness.db as never,
      instructions,
      agent,
      catalogItem: CATALOG_ITEM,
      pendingUpdateId: "pending-1",
      decisions: Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
    });

    // Untouched on disk, and the adapterConfig value untouched too.
    expect(await readManaged("promptTemplate.legacy.md")).toBe("# a real file the founder wrote\n");
    expect((harness.agentSets[0]!.adapterConfig as Record<string, unknown>).promptTemplate)
      .toBe("the adapterConfig value");
    // Fails closed: unaccounted local content means this is not pure upstream.
    expect(outcome.pureUpstream).toBe(false);
    expect(outcome.instructionsCustomized).toBe(true);
  });

  it("treats promptTemplate as virtual when no such file exists on disk", async () => {
    const agent = await installAgent({ adapterConfigSeed: { promptTemplate: "legacy value" } });
    const snapshot = await readAgentInstructionSnapshot(instructions, agent);
    expect(snapshot.files["promptTemplate.legacy.md"]).toBe("legacy value");
    expect(snapshot.virtualPaths.has("promptTemplate.legacy.md")).toBe(true);
    expect(snapshot.shadowedPaths.size).toBe(0);
  });
});

describe("mergeAgentUpdate — concurrency", () => {
  it("refuses when the pending row was already applied or dismissed elsewhere", async () => {
    const agent = await installAgent();
    const harness = makeDb({ pendingClaimReturns: [] });

    await expect(
      mergeAgentUpdate({
        db: harness.db as never,
        instructions,
        agent,
        catalogItem: CATALOG_ITEM,
        pendingUpdateId: "pending-1",
        decisions: {},
      }),
    ).rejects.toBeInstanceOf(AgentMergeConflictError);

    // The claim runs BEFORE the agent write, so a losing session must not have
    // stamped a new templateVersion on the row.
    expect(harness.agentSets).toHaveLength(0);
  });

  it("refuses when the agent row vanished", async () => {
    const agent = await installAgent();
    const harness = makeDb({ agentUpdateReturns: [] });

    await expect(
      mergeAgentUpdate({
        db: harness.db as never,
        instructions,
        agent,
        catalogItem: CATALOG_ITEM,
        pendingUpdateId: "pending-1",
        decisions: {},
      }),
    ).rejects.toBeInstanceOf(AgentMergeConflictError);
  });
});
