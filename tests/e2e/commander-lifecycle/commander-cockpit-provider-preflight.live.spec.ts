import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { authenticatedRequest, loadState, requireCheckpoint, writeCheckpoint } from "./campaign.js";

function commandOutput(command: string, args: string[]) {
  let result;
  if (process.platform === "win32") {
    result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
  } else {
    result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

test("@commander-lifecycle verifies real providers and exact task-scoped adapters", async ({ browser }) => {
  await requireCheckpoint("lifecycle-setup");
  const state = await loadState();
  const claudeVersion = commandOutput(process.platform === "win32" ? "claude.cmd" : "claude", ["--version"]);
  const codexVersion = commandOutput(process.platform === "win32" ? "codex.cmd" : "codex", ["--version"]);
  const claudeAuth = commandOutput(process.platform === "win32" ? "claude.cmd" : "claude", ["auth", "status"]);
  const codexAuth = commandOutput(process.platform === "win32" ? "codex.cmd" : "codex", ["login", "status"]);
  expect(claudeAuth).toContain('"loggedIn": true');
  expect(codexAuth.toLowerCase()).toContain("logged in");

  const context = await authenticatedRequest(browser, state, "founder");
  try {
    const agentsResponse = await context.request.get(`/api/companies/${state.company.id}/agents`);
    expect(agentsResponse.ok(), await agentsResponse.text()).toBe(true);
    const agents = await agentsResponse.json() as Array<{ id: string; adapterType: string; parentId: string | null }>;
    expect(agents.find((agent) => agent.id === state.agents.claude.id)).toMatchObject({
      adapterType: "claude_local",
      parentId: state.actors.lead.userId,
    });
    expect(agents.find((agent) => agent.id === state.agents.codex.id)).toMatchObject({
      adapterType: "codex_local",
      parentId: state.actors.lead.userId,
    });

    const health = await context.request.get("/api/health");
    expect(health.ok(), await health.text()).toBe(true);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
    });
  } finally {
    await context.close();
  }

  await writeCheckpoint("provider-preflight", {
    claudeVersion,
    codexVersion,
    claudeAuth: "logged_in",
    codexAuth: "logged_in",
  });
});
