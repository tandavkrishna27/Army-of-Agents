import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown>): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

describe("agent instructions service", () => {
  const originalAoaHome = process.env.AOA_HOME;
  const originalAoaInstanceId = process.env.AOA_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalAoaHome === undefined) delete process.env.AOA_HOME;
    else process.env.AOA_HOME = originalAoaHome;
    if (originalAoaInstanceId === undefined) delete process.env.AOA_INSTANCE_ID;
    else process.env.AOA_INSTANCE_ID = originalAoaInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("copies the existing bundle into the managed root when switching to managed mode", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const externalRoot = await makeTempDir("paperclip-agent-instructions-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, { mode: "managed" });

    expect(result.bundle.mode).toBe("managed");
    expect(result.bundle.managedRootPath).toBe(
      path.join(
        paperclipHome,
        "instances",
        "test-instance",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "instructions",
      ),
    );
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# External Agent\n");
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("creates the target entry file when switching to a new external root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    const externalRoot = await makeTempDir("paperclip-agent-instructions-new-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, {
      mode: "external",
      rootPath: externalRoot,
      entryFile: "docs/AGENTS.md",
    });

    expect(result.bundle.mode).toBe("external");
    expect(result.bundle.rootPath).toBe(externalRoot);
    await expect(fs.readFile(path.join(externalRoot, "docs", "AGENTS.md"), "utf8")).resolves.toBe("# Managed Agent\n");
  });

  it("filters junk files, dependency bundles, and python caches from bundle listings and exports", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-ignore-");
    cleanupDirs.add(externalRoot);

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".DS_Store"), "junk", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "module.pyc"), "compiled", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "._TOOLS.md"), "appledouble", "utf8");
    await fs.mkdir(path.join(externalRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "node_modules", "pkg", "index.js"), "export {};\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "python", "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "python", "__pycache__", "module.cpython-313.pyc"),
      "compiled",
      "utf8",
    );
    await fs.mkdir(path.join(externalRoot, ".pytest_cache"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, ".pytest_cache", "README.md"), "cache", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "AGENTS.md", "docs/TOOLS.md"]);
    expect(Object.keys(exported.files).sort((left, right) => left.localeCompare(right))).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/TOOLS.md",
    ]);
  });

  it("recovers a managed bundle from disk when bundle config metadata is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-recover-");
    cleanupDirs.add(paperclipHome);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Recovered Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Recovered Agent\n" });
  });

  it("prefers the managed bundle on disk when managed metadata points at a stale root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-stale-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("heals stale managed metadata when writing bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-write-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-write-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.writeFile(agent, "docs/TOOLS.md", "## Tools\n");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("heals stale managed metadata when deleting bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-delete-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-delete-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.deleteFile(agent, "docs/TOOLS.md");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).rejects.toThrow();
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("recovers the managed bundle when stale root metadata is present but mode is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-partial-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-partial-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });
  // ── D22 / F1 ablation: what a catalog update actually destroys ─────────────
  //
  // `applyCrewAgentUpdate` calls `materializeManagedBundle(..., {
  // replaceExisting: true, clearLegacyPromptTemplate: true })`. This pins the
  // exact adapterConfig keys that call annihilates, which is what the
  // instruction-bearing key list in `routes/agents.ts` has to cover. If this
  // test's expectations change, that list must change with it.
  it("a catalog-update materialize deletes BOTH legacy prompt templates and overwrites the bundle keys", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    cleanupDirs.add(paperclipHome);
    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const agent = makeAgent({
      // Everything a founder can set through PATCH /agents/:id that the bundle
      // touches, plus one key it must leave alone.
      promptTemplate: "# my custom heartbeat prompt",
      bootstrapPromptTemplate: "# my first-run prompt",
      instructionsFilePath: "/tmp/mine/AGENTS.md",
      instructionsRootPath: "/tmp/mine",
      instructionsEntryFile: "PLAYBOOK.md",
      instructionsBundleMode: "external",
      model: "claude-sonnet-4-20250514",
    });

    const { adapterConfig } = await svc.materializeManagedBundle(
      agent,
      { "AGENTS.md": "# Catalog content\n" },
      { entryFile: "AGENTS.md", replaceExisting: true, clearLegacyPromptTemplate: true },
    );

    // DELETED outright — unrecoverable, and neither has a revision row.
    expect(adapterConfig).not.toHaveProperty("promptTemplate");
    expect(adapterConfig).not.toHaveProperty("bootstrapPromptTemplate");

    // OVERWRITTEN with catalog-derived values.
    expect(adapterConfig.instructionsBundleMode).toBe("managed");
    expect(adapterConfig.instructionsEntryFile).toBe("AGENTS.md");
    expect(adapterConfig.instructionsRootPath).not.toBe("/tmp/mine");
    expect(adapterConfig.instructionsFilePath).not.toBe("/tmp/mine/AGENTS.md");

    // UNTOUCHED — proves the destruction set is bounded, so the key list does
    // not need to cover every adapterConfig key.
    expect(adapterConfig.model).toBe("claude-sonnet-4-20250514");
  });

  it("rejects an external bundle rootPath inside the managed marketplace-skills tree (T2.8c(b))", async () => {
    const aoaHome = await makeTempDir("paperclip-agent-instructions-jail-");
    cleanupDirs.add(aoaHome);
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    // A path the catalog installer owns. updateBundle would otherwise mkdir +
    // write (and deleteFile would `fs.rm`) inside it.
    const insideManagedRoot = path.join(
      process.cwd(),
      ".aoa",
      "marketplace-skills",
      "company-1",
      "skill_x",
      "1.0.0",
    );

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    await expect(
      svc.updateBundle(agent, { mode: "external", rootPath: insideManagedRoot }),
    ).rejects.toThrow(/managed marketplace-skills/);

    // The guard fires before any filesystem work, so nothing was created there.
    await expect(fs.stat(insideManagedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects deleting a file that resolves inside the managed tree via an ANCESTOR external root (Codex #302 writable-sink)", async () => {
    const aoaHome = await makeTempDir("paperclip-agent-instructions-sink-");
    cleanupDirs.add(aoaHome);
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    // `.aoa` is an ANCESTOR of `.aoa/marketplace-skills`, so it passes the
    // updateBundle inside-check — but a relative path resolves into the managed
    // tree, which the sink guard in deleteFile must catch before fs.rm.
    const ancestorRoot = path.join(process.cwd(), ".aoa");
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: ancestorRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(ancestorRoot, "AGENTS.md"),
    });

    const svc = agentInstructionsService();
    await expect(
      svc.deleteFile(agent, "marketplace-skills/company-1/skill_x/1.0.0/evil.md"),
    ).rejects.toThrow(/managed marketplace-skills/);
  });

  it("rejects an external bundle rootPath that is an ANCESTOR of the managed tree (Codex #302 overlap)", async () => {
    const aoaHome = await makeTempDir("paperclip-agent-instructions-overlap-");
    cleanupDirs.add(aoaHome);
    process.env.AOA_HOME = aoaHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    // `.aoa` contains the managed tree; rejecting it at set time closes the
    // ancestor-root + `marketplace-skills/...` entryFile bypass.
    const ancestorRoot = path.join(process.cwd(), ".aoa");
    const svc = agentInstructionsService();
    const agent = makeAgent({});

    await expect(
      svc.updateBundle(agent, { mode: "external", rootPath: ancestorRoot }),
    ).rejects.toThrow(/managed marketplace-skills/);
  });

  it("refuses to materialize a managed bundle whose root overlaps the marketplace-skills tree (Codex #302)", async () => {
    // Pathological AOA_HOME rooted INSIDE the catalog-owned tree: the managed
    // instructions root then resolves inside marketplace-skills, so
    // materialize's replaceExisting fs.rm would delete catalog bytes. It must
    // refuse before any destructive action (this path writes directly, not via
    // the jailed writeBundleFiles).
    const evilHome = path.join(process.cwd(), ".aoa", "marketplace-skills", "__evil_home__");
    process.env.AOA_HOME = evilHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    await expect(
      svc.materializeManagedBundle(agent, { "AGENTS.md": "# hijack" }, { replaceExisting: true }),
    ).rejects.toThrow(/overlaps the managed marketplace-skills/);

    // The guard fired before any filesystem work — nothing was created there.
    await expect(fs.stat(evilHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses ensureWritableBundle (PUT /file) when the managed root overlaps the marketplace-skills tree (Codex #302)", async () => {
    // Codex's scenario: an unconfigured agent with legacy prompt content hits
    // ensureWritableBundle via writeFile, which would mkdir + write the legacy
    // content into the overlapping managed root BEFORE writeFile's target jail.
    const evilHome = path.join(process.cwd(), ".aoa", "marketplace-skills", "__evil_home2__");
    process.env.AOA_HOME = evilHome;
    process.env.AOA_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const agent = makeAgent({ promptTemplate: "# legacy instructions" });

    await expect(svc.writeFile(agent, "docs/extra.md", "# new")).rejects.toThrow(
      /overlaps the managed marketplace-skills/,
    );

    await expect(fs.stat(evilHome)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
