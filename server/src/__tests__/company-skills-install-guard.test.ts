/**
 * T2.9 — the non-catalog (github / url / local) install + reinstall paths must
 * honour `company_skills.customized`, exactly as the catalog auto-apply path
 * already does (`skill-auto-updater.ts:100-133`).
 *
 * Two entry points reach an existing row's `markdown` from a source re-read:
 *   1. `POST /companies/:cid/skills/:skillId/install-update` → `installUpdate`
 *   2. `POST /companies/:cid/skills/import`                  → `importFromSource`
 *                                                            → `upsertImportedSkills`
 *
 * Every "refuses" case here is paired with an "uncustomized still updates" case:
 * without that discriminator a change that simply blocked all reinstalls would
 * pass the suite.
 */
import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted before the service import) ────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((x: unknown) => x),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  companySkills: new Proxy({}, { get: (_t, k) => `companySkills.${String(k)}` }),
  agents: new Proxy({}, { get: (_t, k) => `agents.${String(k)}` }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../adapters/registry.js", () => ({ findActiveServerAdapter: vi.fn() }));

const projectListMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../services/projects.js", () => ({ projectService: () => ({ list: projectListMock }) }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    getById: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  }),
}));

const httpBodies = vi.hoisted(() => new Map<string, string>());

vi.mock("../services/outbound-url-guard.js", () => ({
  validateAndResolveFetchUrl: vi.fn(async (url: string) => ({ url })),
  executePinnedRequest: vi.fn(async (target: { url: string }) => {
    const body = httpBodies.get(target.url);
    if (body === undefined) return { status: 404, body: "" };
    return { status: 200, body };
  }),
}));

import { companySkillService } from "../services/company-skills.js";

// ── Minimal in-memory Drizzle stand-in ───────────────────────────────────────

type Row = Record<string, any>;

function evalCond(cond: any, row: Row): boolean {
  if (cond === undefined || cond === null) return true;
  if (Array.isArray(cond)) return cond.every((c) => evalCond(c, row));
  if (cond.and) return (cond.and as unknown[]).every((c) => evalCond(c, row));
  if (cond.eq) {
    const [col, value] = cond.eq as [string, unknown];
    const column = String(col).split(".")[1]!;
    return row[column] === value;
  }
  return true;
}

interface FakeDb {
  db: any;
  rows: Row[];
  /** Every `update(...).set(values)` that actually matched at least one row. */
  appliedUpdates: Array<{ values: Row; ids: string[] }>;
  /** Every `update(...).set(values)` issued, matched or not. */
  attemptedUpdates: Array<{ values: Row; ids: string[] }>;
  inserted: Row[];
  afterNextSelect?: () => void;
  beforeInsertCommit?: (row: Row) => void;
}

function makeFakeDb(rows: Row[]): FakeDb {
  const state: FakeDb = {
    db: null,
    rows,
    appliedUpdates: [],
    attemptedUpdates: [],
    inserted: [],
  };
  let seq = 0;

  const selectChain = (cond?: any) => {
    const run = () => {
      const snapshot = state.rows.filter((r) => evalCond(cond, r)).map((r) => ({ ...r }));
      const afterSelect = state.afterNextSelect;
      state.afterNextSelect = undefined;
      afterSelect?.();
      return snapshot;
    };
    return {
      orderBy: () => Promise.resolve(run()),
      limit: () => Promise.resolve(run()),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
  };

  state.db = {
    select: (_cols?: unknown) => ({
      from: () => ({
        where: (cond: any) => selectChain(cond),
        ...selectChain(),
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: (cond: any) => {
          let matched: Row[] | null = null;
          const run = () => {
            if (matched !== null) return matched;
            matched = state.rows.filter((r) => evalCond(cond, r));
            for (const r of matched) Object.assign(r, values);
            const record = { values, ids: matched.map((r) => r.id) };
            state.attemptedUpdates.push(record);
            if (matched.length > 0) state.appliedUpdates.push(record);
            return matched;
          };
          return {
            returning: () => Promise.resolve(run().map((r) => ({ ...r }))),
            then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
          };
        },
      }),
    }),
    insert: () => ({
      values: (values: Row) => {
        const row: Row = {
          id: `inserted-${++seq}`,
          customized: false,
          createdAt: new Date("2026-07-24T00:00:00Z"),
          updatedAt: new Date("2026-07-24T00:00:00Z"),
          ...values,
        };
        const commit = () => {
          state.beforeInsertCommit?.(row);
          if (state.rows.some((existing) =>
            existing.companyId === row.companyId && existing.key === row.key
          )) {
            throw Object.assign(new Error("duplicate company skill key"), {
              code: "23505",
              constraint_name: "company_skills_company_key_idx",
            });
          }
          state.rows.push(row);
          state.inserted.push(row);
          return [{ ...row }];
        };
        return {
          returning: () => Promise.resolve(commit()),
          then: (res: any, rej: any) => Promise.resolve(commit()).then(res, rej),
        };
      },
    }),
    transaction: async (action: (tx: any) => Promise<any>) => action(state.db),
    delete: () => ({
      where: (cond: any) => {
        const keep = state.rows.filter((r) => !evalCond(cond, r));
        state.rows.length = 0;
        state.rows.push(...keep);
        return Promise.resolve([]);
      },
    }),
  };

  return state;
}

const FOUNDER_MARKDOWN = "---\nname: Brainstorming\n---\n\n# Brainstorming (founder's edit)\n";
const UPSTREAM_MARKDOWN = "---\nname: Brainstorming\n---\n\n# Brainstorming (upstream v2)\n";

function urlSkillRow(overrides: Row = {}): Row {
  return {
    id: "skill-1",
    companyId: "co-1",
    key: "url/example-com/deadbeef/brainstorming",
    slug: "brainstorming",
    name: "Brainstorming",
    description: "Think first",
    markdown: FOUNDER_MARKDOWN,
    sourceType: "url",
    sourceLocator: "https://example.com/SKILL.md",
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: { sourceKind: "url" },
    customized: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

const cleanupDirs = new Set<string>();

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

beforeEach(() => {
  httpBodies.clear();
  vi.clearAllMocks();
  projectListMock.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

// ── 1. installUpdate (POST /skills/:id/install-update) ───────────────────────

describe("installUpdate — customized guard", () => {
  it("refuses to overwrite a CUSTOMIZED url skill", async () => {
    httpBodies.set("https://example.com/SKILL.md", UPSTREAM_MARKDOWN);
    const fake = makeFakeDb([urlSkillRow({ customized: true })]);
    const svc = companySkillService(fake.db);

    await expect(svc.installUpdate("co-1", "skill-1")).rejects.toMatchObject({
      status: 409,
    });

    // The founder's bytes survive — the assertion is on stored content, not a status.
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
    expect(fake.appliedUpdates).toHaveLength(0);
  });

  it("still updates an UNCUSTOMIZED url skill (discriminator)", async () => {
    httpBodies.set("https://example.com/SKILL.md", UPSTREAM_MARKDOWN);
    const fake = makeFakeDb([urlSkillRow({ customized: false })]);
    const svc = companySkillService(fake.db);

    const updated = await svc.installUpdate("co-1", "skill-1");

    expect(updated?.markdown).toBe(UPSTREAM_MARKDOWN);
    expect(fake.rows[0]!.markdown).toBe(UPSTREAM_MARKDOWN);
    expect(fake.appliedUpdates).toHaveLength(1);
  });

  it("refuses to overwrite a CUSTOMIZED github skill", async () => {
    httpBodies.set("https://api.github.com/repos/acme/skills/commits/main", JSON.stringify({ sha: "f".repeat(40) }));
    httpBodies.set(
      `https://raw.githubusercontent.com/acme/skills/${"f".repeat(40)}/brainstorming/SKILL.md`,
      UPSTREAM_MARKDOWN,
    );
    const fake = makeFakeDb([
      urlSkillRow({
        key: "acme/skills/brainstorming",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/skills/tree/main/brainstorming",
        sourceRef: "main",
        metadata: { sourceKind: "github", owner: "acme", repo: "skills", skillPath: "brainstorming", ref: "main" },
        customized: true,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await expect(svc.installUpdate("co-1", "skill-1")).rejects.toMatchObject({ status: 409 });
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
  });

  it("still updates an UNCUSTOMIZED github skill (discriminator)", async () => {
    httpBodies.set("https://api.github.com/repos/acme/skills/commits/main", JSON.stringify({ sha: "f".repeat(40) }));
    httpBodies.set(
      `https://raw.githubusercontent.com/acme/skills/${"f".repeat(40)}/brainstorming/SKILL.md`,
      UPSTREAM_MARKDOWN,
    );
    const fake = makeFakeDb([
      urlSkillRow({
        key: "acme/skills/brainstorming",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/skills/tree/main/brainstorming",
        sourceRef: "main",
        metadata: { sourceKind: "github", owner: "acme", repo: "skills", skillPath: "brainstorming", ref: "main" },
        customized: false,
      }),
    ]);
    const svc = companySkillService(fake.db);

    const updated = await svc.installUpdate("co-1", "skill-1");
    expect(updated?.markdown).toBe(UPSTREAM_MARKDOWN);
  });

  it("optimistic lock: a concurrent founder edit between the read and the write still refuses", async () => {
    httpBodies.set("https://example.com/SKILL.md", UPSTREAM_MARKDOWN);
    const row = urlSkillRow({ customized: false });
    const fake = makeFakeDb([row]);
    const svc = companySkillService(fake.db);

    // Simulate the founder committing `customized = true` after installUpdate has
    // read the row but before it issues the UPDATE.
    const originalUpdate = fake.db.update;
    fake.db.update = (...args: unknown[]) => {
      row.customized = true;
      fake.db.update = originalUpdate;
      return originalUpdate(...args);
    };

    await expect(svc.installUpdate("co-1", "skill-1")).rejects.toMatchObject({ status: 409 });
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
  });

  it("a refused install leaves the on-disk skill directory byte-identical", async () => {
    const skillDir = await makeTempDir("aoa-t29-local-skill-");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), UPSTREAM_MARKDOWN, "utf8");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "notes.md"), "keep me", "utf8");

    const fake = makeFakeDb([
      urlSkillRow({
        key: "company/co-1/brainstorming",
        sourceType: "local_path",
        sourceLocator: skillDir,
        metadata: { sourceKind: "managed_local" },
        customized: true,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await expect(svc.installUpdate("co-1", "skill-1")).rejects.toMatchObject({ status: 409 });

    // Bytes, not a status string.
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(UPSTREAM_MARKDOWN);
    expect(await fs.readFile(path.join(skillDir, "references", "notes.md"), "utf8")).toBe("keep me");
    expect((await fs.readdir(skillDir)).sort()).toEqual(["SKILL.md", "references"]);
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
  });
});

// ── 2. importFromSource (POST /skills/import) ────────────────────────────────

describe("importFromSource — customized guard", () => {
  const SOURCE_URL = "https://example.com/skills/brainstorming/SKILL.md";

  /** Import once into an empty company so the canonical key is derived, not guessed. */
  async function seedImportedRow(): Promise<Row> {
    httpBodies.set(SOURCE_URL, FOUNDER_MARKDOWN);
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);
    await svc.importFromSource("co-1", SOURCE_URL);
    expect(fake.inserted).toHaveLength(1);
    return { ...fake.inserted[0]!, id: "skill-1", markdown: FOUNDER_MARKDOWN };
  }

  it("refuses to overwrite a CUSTOMIZED row on re-import", async () => {
    const seeded = await seedImportedRow();
    httpBodies.set(SOURCE_URL, UPSTREAM_MARKDOWN);

    const fake = makeFakeDb([{ ...seeded, customized: true }]);
    const svc = companySkillService(fake.db);

    const result = await svc.importFromSource("co-1", SOURCE_URL);

    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
    expect(fake.appliedUpdates).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.refusedCustomized).toEqual([
      expect.objectContaining({ skillId: "skill-1", reason: "customized" }),
    ]);
    expect(result.warnings.join(" ")).toMatch(/edit/i);
  });

  it("still updates an UNCUSTOMIZED row on re-import (discriminator)", async () => {
    const seeded = await seedImportedRow();
    httpBodies.set(SOURCE_URL, UPSTREAM_MARKDOWN);

    const fake = makeFakeDb([{ ...seeded, customized: false }]);
    const svc = companySkillService(fake.db);

    const result = await svc.importFromSource("co-1", SOURCE_URL);

    expect(fake.rows[0]!.markdown).toBe(UPSTREAM_MARKDOWN);
    expect(result.imported).toHaveLength(1);
    expect(result.refusedCustomized).toEqual([]);
    expect(fake.inserted).toHaveLength(0); // updated in place, not duplicated
  });
});

// ── 3. F1 — an authoritative overwrite must clear the now-stale flag ─────────

describe("caller_is_authoritative clears `customized` (F1)", () => {
  const PACKAGE_V1 = "---\nname: Playbook\n---\n\n# Playbook v1\n";
  const PACKAGE_V2 = "---\nname: Playbook\n---\n\n# Playbook v2\n";

  // importPackageFiles writes under resolveAoaInstanceRoot(); point that at a
  // temp dir so the test never touches the developer's real ~/.aoa.
  let previousAoaHome: string | undefined;
  beforeEach(async () => {
    previousAoaHome = process.env.AOA_HOME;
    process.env.AOA_HOME = await makeTempDir("aoa-t29-home-");
  });
  afterEach(() => {
    if (previousAoaHome === undefined) delete process.env.AOA_HOME;
    else process.env.AOA_HOME = previousAoaHome;
  });

  /**
   * The reviewer's four-step sequence, end to end:
   *   1. package import  → local_path row, customized=false
   *   2. founder edits SKILL.md → customized=true
   *   3. package re-upload (authoritative) → markdown=v2
   *   4. a LATER install must still succeed — before F1 the row was permanently
   *      refused and told it had "local edits" it no longer had.
   */
  it("a package re-upload after a founder edit does not permanently block later installs", async () => {
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);

    // 1. first package import
    const created = await svc.importPackageFiles("co-1", { "SKILL.md": PACKAGE_V1 });
    const row = fake.rows.find((r) => r.id === created.id)!;
    expect(row.customized).toBe(false);
    // Guard the isolation: this must live under the temp AOA_HOME, not ~/.aoa.
    expect(row.sourceLocator.startsWith(path.resolve(process.env.AOA_HOME!))).toBe(true);

    // 2. founder edits it in the UI — local_path is editable
    await svc.updateFile("co-1", created.id, "SKILL.md", "# my own words\n");
    expect(row.customized).toBe(true);

    // 3. package v2 replaces the bytes wholesale
    await svc.importPackageFiles("co-1", { "SKILL.md": PACKAGE_V2 });
    expect(row.markdown).toBe(PACKAGE_V2);
    // The founder's edit is gone, so the flag describing it must be gone too.
    expect(row.customized).toBe(false);

    // 4. the row is not frozen: a later reinstall from its source still lands.
    const updated = await svc.installUpdate("co-1", created.id);
    expect(updated).not.toBeNull();
    expect(fake.rows[0]!.markdown).toBe(PACKAGE_V2);
  });

  it("preserve_founder_edits does NOT clear the flag (discriminator)", async () => {
    const SOURCE_URL = "https://example.com/f1/SKILL.md";
    httpBodies.set(SOURCE_URL, UPSTREAM_MARKDOWN);
    const fake = makeFakeDb([
      urlSkillRow({ key: "url/example-com/x/brainstorming", customized: true }),
    ]);
    const svc = companySkillService(fake.db);

    await expect(svc.installUpdate("co-1", "skill-1")).rejects.toMatchObject({ status: 409 });

    // Refusing must never be a back door to clearing the flag.
    expect(fake.rows[0]!.customized).toBe(true);
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
  });
});

// ── 4. F2 — the project scan is a third source-re-read path ──────────────────

describe("createLocalSkill — collision guard (T2.9b)", () => {
  let previousAoaHome: string | undefined;

  beforeEach(async () => {
    previousAoaHome = process.env.AOA_HOME;
    process.env.AOA_HOME = await makeTempDir("aoa-t29b-home-");
  });

  afterEach(() => {
    if (previousAoaHome === undefined) delete process.env.AOA_HOME;
    else process.env.AOA_HOME = previousAoaHome;
  });

  it("returns a distinct 409 and preserves a customized row plus its bytes", async () => {
    const skillDir = path.join(
      path.resolve(process.env.AOA_HOME!),
      "instances",
      "default",
      "skills",
      "co-1",
      "brainstorming",
    );
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), FOUNDER_MARKDOWN, "utf8");
    const fake = makeFakeDb([
      urlSkillRow({
        key: "company/co-1/brainstorming",
        slug: "brainstorming",
        sourceType: "local_path",
        sourceLocator: skillDir,
        customized: true,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await expect(svc.createLocalSkill("co-1", {
      name: "Brainstorming",
      slug: "brainstorming",
      markdown: UPSTREAM_MARKDOWN,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "SKILL_NAME_TAKEN" },
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
    expect(fake.rows[0]!.customized).toBe(true);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(FOUNDER_MARKDOWN);
  });

  it("rejects an existing normalized slug even when another source owns a different key", async () => {
    const fake = makeFakeDb([
      urlSkillRow({
        key: "github/example/skills/brainstorming",
        slug: "brainstorming",
        sourceType: "github",
        sourceLocator: "https://github.com/example/skills",
      }),
    ]);
    const svc = companySkillService(fake.db);

    await expect(svc.createLocalSkill("co-1", {
      name: "Brainstorming",
      slug: "BRAINSTORMING",
      markdown: UPSTREAM_MARKDOWN,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "SKILL_NAME_TAKEN",
        key: "github/example/skills/brainstorming",
      },
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.inserted).toHaveLength(0);
  });

  it("lets exactly one of two concurrent creates claim a fresh key", async () => {
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);
    const input = {
      name: "Brainstorming",
      slug: "brainstorming",
      markdown: UPSTREAM_MARKDOWN,
    };

    const outcomes = await Promise.allSettled([
      svc.createLocalSkill("co-1", input),
      svc.createLocalSkill("co-1", input),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      details: { code: "SKILL_NAME_TAKEN" },
    });
    expect(fake.rows.filter((candidate) =>
      candidate.key === "company/co-1/brainstorming"
    )).toHaveLength(1);
  });

  it("does not insert a row when an orphan final directory blocks publication", async () => {
    const managedRoot = path.join(
      path.resolve(process.env.AOA_HOME!),
      "instances",
      "default",
      "skills",
      "co-1",
    );
    const skillDir = path.join(managedRoot, "brainstorming");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), FOUNDER_MARKDOWN, "utf8");
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);

    await expect(svc.createLocalSkill("co-1", {
      name: "Brainstorming",
      slug: "brainstorming",
      markdown: UPSTREAM_MARKDOWN,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "SKILL_NAME_TAKEN" },
    });

    expect(fake.rows).toHaveLength(0);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(
      FOUNDER_MARKDOWN,
    );
    expect((await fs.readdir(managedRoot)).filter(
      (entry) => entry.startsWith(".brainstorming-create-"),
    )).toEqual([]);
  });

  it("publishes SKILL.md before making the database row visible", async () => {
    const fake = makeFakeDb([]);
    fake.beforeInsertCommit = (row) => {
      expect(existsSync(path.join(row.sourceLocator, "SKILL.md"))).toBe(true);
    };
    const svc = companySkillService(fake.db);

    const created = await svc.createLocalSkill("co-1", {
      name: "Published First",
      slug: "published-first",
      markdown: "# Published first\n",
    });

    expect(created.id).toBe("inserted-1");
    expect(fake.rows).toHaveLength(1);
  });

  it("removes an owned managed directory so a deleted slug can be recreated", async () => {
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);
    const first = await svc.createLocalSkill("co-1", {
      name: "Reusable",
      slug: "reusable",
      markdown: "# First\n",
    });
    const firstDirectory = first.sourceLocator!;

    await expect(svc.deleteSkill("co-1", first.id)).resolves.toMatchObject({
      id: first.id,
    });
    expect(existsSync(firstDirectory)).toBe(false);

    const recreated = await svc.createLocalSkill("co-1", {
      name: "Reusable",
      slug: "reusable",
      markdown: "# Second\n",
    });
    expect(recreated.id).not.toBe(first.id);
    expect(await fs.readFile(path.join(recreated.sourceLocator!, "SKILL.md"), "utf8")).toBe(
      "# Second\n",
    );
  });

  it("does not delete an imported local_path directory with the database row", async () => {
    const importedDirectory = await makeTempDir("aoa-imported-local-delete-");
    await fs.writeFile(path.join(importedDirectory, "SKILL.md"), FOUNDER_MARKDOWN, "utf8");
    const fake = makeFakeDb([
      urlSkillRow({
        sourceType: "local_path",
        sourceLocator: importedDirectory,
        metadata: { sourceKind: "local" },
      }),
    ]);
    const svc = companySkillService(fake.db);

    await svc.deleteSkill("co-1", "skill-1");

    expect(fake.rows).toHaveLength(0);
    expect(await fs.readFile(path.join(importedDirectory, "SKILL.md"), "utf8")).toBe(
      FOUNDER_MARKDOWN,
    );
  });

  it("still creates a fresh slug", async () => {
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);

    const created = await svc.createLocalSkill("co-1", {
      name: "Fresh Skill",
      slug: "fresh-skill",
      markdown: "# Fresh\n",
    });

    expect(created.key).toBe("company/co-1/fresh-skill");
    expect(fake.rows).toHaveLength(1);
    expect(await fs.readFile(
      path.join(created.sourceLocator!, "SKILL.md"),
      "utf8",
    )).toBe("# Fresh\n");
  });

  it("preserves founder-authored Unicode bytes in the managed SKILL.md", async () => {
    const fake = makeFakeDb([]);
    const svc = companySkillService(fake.db);
    const markdown = "---\nname: 研究 🚀\n---\n\n# 研究 🚀\n";

    const created = await svc.createLocalSkill("co-1", {
      name: "研究 🚀",
      slug: "research",
      markdown,
    });

    expect(await fs.readFile(
      path.join(created.sourceLocator!, "SKILL.md"),
      "utf8",
    )).toBe(markdown);
  });
});

describe("updateFile — byte-derived customized companion", () => {
  it("keeps an uncustomized SKILL.md uncustomized on a byte-identical save", async () => {
    const skillDir = await makeTempDir("aoa-t29-edit-");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), UPSTREAM_MARKDOWN, "utf8");
    const fake = makeFakeDb([
      urlSkillRow({
        sourceType: "local_path",
        sourceLocator: skillDir,
        markdown: UPSTREAM_MARKDOWN,
        customized: false,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await svc.updateFile("co-1", "skill-1", "SKILL.md", UPSTREAM_MARKDOWN);

    expect(fake.rows[0]!.customized).toBe(false);
  });

  it("does not rewrite the filesystem on a byte-identical DB save", async () => {
    const skillDir = await makeTempDir("aoa-t29-edit-disk-race-");
    const concurrentDiskBytes = "# newer filesystem bytes\n";
    await fs.writeFile(path.join(skillDir, "SKILL.md"), concurrentDiskBytes, "utf8");
    const fake = makeFakeDb([
      urlSkillRow({
        sourceType: "local_path",
        sourceLocator: skillDir,
        markdown: UPSTREAM_MARKDOWN,
        customized: false,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await svc.updateFile("co-1", "skill-1", "SKILL.md", UPSTREAM_MARKDOWN);

    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(
      concurrentDiskBytes,
    );
    expect(fake.attemptedUpdates).toHaveLength(0);
  });

  it("keeps an already-customized SKILL.md sticky on a byte-identical re-save", async () => {
    const skillDir = await makeTempDir("aoa-t29-edit-sticky-");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), FOUNDER_MARKDOWN, "utf8");
    const fake = makeFakeDb([
      urlSkillRow({
        sourceType: "local_path",
        sourceLocator: skillDir,
        markdown: FOUNDER_MARKDOWN,
        customized: true,
      }),
    ]);
    const svc = companySkillService(fake.db);

    await svc.updateFile("co-1", "skill-1", "SKILL.md", FOUNDER_MARKDOWN);

    expect(fake.rows[0]!.customized).toBe(true);
  });

  it("preserves a concurrent ancillary-file customization on a byte-identical save", async () => {
    const skillDir = await makeTempDir("aoa-t29-edit-concurrent-");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), UPSTREAM_MARKDOWN, "utf8");
    const row = urlSkillRow({
      sourceType: "local_path",
      sourceLocator: skillDir,
      markdown: UPSTREAM_MARKDOWN,
      customized: false,
    });
    const fake = makeFakeDb([row]);
    const svc = companySkillService(fake.db);

    // updateFile has already captured its pristine row snapshot when this hook
    // runs. Model an ancillary-file request committing customized=true before
    // the byte-identical SKILL.md path decides whether to write.
    fake.afterNextSelect = () => {
      row.customized = true;
    };

    await svc.updateFile("co-1", "skill-1", "SKILL.md", UPSTREAM_MARKDOWN);

    expect(row.customized).toBe(true);
    expect(fake.attemptedUpdates).toHaveLength(0);
  });

  it("does not restore a stale snapshot over a concurrent upstream update", async () => {
    const skillDir = await makeTempDir("aoa-t29-edit-upstream-race-");
    await fs.writeFile(path.join(skillDir, "SKILL.md"), UPSTREAM_MARKDOWN, "utf8");
    const row = urlSkillRow({
      sourceType: "local_path",
      sourceLocator: skillDir,
      markdown: UPSTREAM_MARKDOWN,
      sourceRef: "v1",
      customized: false,
    });
    const fake = makeFakeDb([row]);
    const svc = companySkillService(fake.db);
    fake.afterNextSelect = () => {
      row.markdown = "# upstream v2\n";
      row.sourceRef = "v2";
      row.customized = false;
    };

    await svc.updateFile("co-1", "skill-1", "SKILL.md", UPSTREAM_MARKDOWN);

    expect(row).toMatchObject({
      markdown: "# upstream v2\n",
      sourceRef: "v2",
      customized: false,
    });
    expect(fake.attemptedUpdates).toHaveLength(0);
  });
});

describe("scanProjectWorkspaces — customized guard (F2)", () => {
  const ON_DISK = "---\nname: Scanned\n---\n\n# from the repo\n";

  async function makeScannedWorkspace() {
    const workspaceCwd = await makeTempDir("aoa-t29-scan-ws-");
    const skillDir = path.join(workspaceCwd, "skills", "scanned");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), ON_DISK, "utf8");
    projectListMock.mockResolvedValue([
      {
        id: "proj-1",
        name: "Core",
        workspaces: [{ id: "ws-1", name: "main", cwd: workspaceCwd }],
      },
    ]);
    return { workspaceCwd, skillDir: path.resolve(skillDir) };
  }

  function scannedRow(skillDir: string, overrides: Row = {}): Row {
    return urlSkillRow({
      id: "skill-scan-1",
      key: "company/co-1/scanned",
      slug: "scanned",
      name: "Scanned",
      sourceType: "local_path",
      sourceLocator: skillDir,
      metadata: { sourceKind: "project_scan" },
      ...overrides,
    });
  }

  it("refuses a CUSTOMIZED row, reports it in conflicts[], and leaves the founder's bytes", async () => {
    const { skillDir } = await makeScannedWorkspace();
    const fake = makeFakeDb([scannedRow(skillDir, { customized: true })]);
    const svc = companySkillService(fake.db);

    const result = await svc.scanProjectWorkspaces("co-1", {});

    expect(result.updated).toHaveLength(0);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        existingSkillId: "skill-scan-1",
        path: skillDir,
        reason: expect.stringMatching(/local edits/i),
      }),
    ]);
    // The stored bytes, not a status string.
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
    expect(fake.appliedUpdates).toHaveLength(0);
  });

  it("still re-syncs an UNCUSTOMIZED row (discriminator)", async () => {
    const { skillDir } = await makeScannedWorkspace();
    const fake = makeFakeDb([scannedRow(skillDir, { customized: false })]);
    const svc = companySkillService(fake.db);

    const result = await svc.scanProjectWorkspaces("co-1", {});

    expect(result.conflicts).toHaveLength(0);
    expect(result.updated).toHaveLength(1);
    expect(fake.rows[0]!.markdown).toBe(ON_DISK);
  });

  it("optimistic lock: a founder edit landing mid-sweep is reported, not clobbered", async () => {
    const { skillDir } = await makeScannedWorkspace();
    const row = scannedRow(skillDir, { customized: false });
    const fake = makeFakeDb([row]);
    const svc = companySkillService(fake.db);

    const originalUpdate = fake.db.update;
    fake.db.update = (...args: unknown[]) => {
      row.customized = true;
      fake.db.update = originalUpdate;
      return originalUpdate(...args);
    };

    const result = await svc.scanProjectWorkspaces("co-1", {});

    expect(result.updated).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(fake.rows[0]!.markdown).toBe(FOUNDER_MARKDOWN);
  });
});
