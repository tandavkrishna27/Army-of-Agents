import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LIVE_SCENARIO_IDS, type CampaignState } from "../commander-lifecycle/campaign.js";

interface Options {
  campaignId: string;
  port: number;
  dbPort: number;
  leaveRunning: boolean;
}

function readOptions(): Options {
  const value = (name: string) => {
    const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(`--${name}=`.length);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const campaignId = value("campaign-id") ?? `commander-lifecycle-${Date.now()}`;
  const port = Number(value("port") ?? 3224);
  const dbPort = Number(value("db-port") ?? 54424);
  if (!Number.isInteger(port) || !Number.isInteger(dbPort)) throw new Error("port and db-port must be integers");
  return { campaignId, port, dbPort, leaveRunning: process.argv.includes("--leave-running-on-success") };
}

function executable(command: string): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command, prefix: [] };
  return { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", command] };
}

function spawnCommand(command: string, args: string[], env: NodeJS.ProcessEnv, stdio: "inherit" | "pipe" = "inherit") {
  const resolved = executable(command);
  return spawn(resolved.command, [...resolved.prefix, ...args], {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio,
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "not attempted";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health: ${lastError}`);
}

async function stopProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function createBootstrapInvite(
  baseUrl: string,
  dbPort: number,
  env: NodeJS.ProcessEnv,
  serverLog: NodeJS.WritableStream,
): Promise<string> {
  const child = spawnCommand(
    "pnpm",
    ["aoa", "auth", "bootstrap-ceo", "--force", "--base-url", baseUrl],
    {
      ...env,
      DATABASE_URL: `postgres://paperclip:paperclip@127.0.0.1:${dbPort}/paperclip`,
    },
    "pipe",
  );
  let output = "";
  const token = await new Promise<string>((resolveToken, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Bootstrap invite timed out: ${output.trim()}`)), 30_000);
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      output += stripAnsi(text);
      serverLog.write(text);
      const match = output.match(/Invite URL:\s+https?:\/\/[^\s]+\/invite\/([^\s]+)/i);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveToken(match[1]);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output.match(/Invite URL:/i)) {
        clearTimeout(timeout);
        reject(new Error(`Bootstrap invite exited ${code}: ${output.trim()}`));
      }
    });
  });
  await stopProcessTree(child);
  return token;
}

function stripAnsi(value: string) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function main() {
  const options = readOptions();
  const root = resolve(".aoa-qa", "commander", options.campaignId);
  const lifecycleDir = resolve(root, "lifecycle");
  const resultsDir = resolve(root, "results");
  const home = resolve(root, "home");
  await mkdir(lifecycleDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const serverLogPath = resolve(lifecycleDir, "server.log");
  const serverLog = createWriteStream(serverLogPath, { flags: "a" });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(options.port),
    AOA_HOME: home,
    AOA_INSTANCE_ID: options.campaignId,
    AOA_BIND: "loopback",
    AOA_DEPLOYMENT_MODE: "authenticated",
    AOA_DEPLOYMENT_EXPOSURE: "private",
    AOA_ALLOWED_HOSTNAMES: "127.0.0.1,localhost",
    AOA_AUTH_BASE_URL_MODE: "explicit",
    AOA_AUTH_PUBLIC_BASE_URL: baseUrl,
    BETTER_AUTH_SECRET: "commander-lifecycle-auth-secret-2026-minimum-32-bytes",
    AOA_ENABLE_COMPANY_DELETION: "true",
    AOA_EMBEDDED_POSTGRES_PORT: String(options.dbPort),
    AOA_EMBEDDED_POSTGRES_STRICT_PORT: "1",
    AOA_VITE_HMR_PORT: String(options.port + 10_000),
    AOA_UI_DEV_MIDDLEWARE: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    DATABASE_URL: "",
  };

  let serverOutput = "";
  const server = spawnCommand("pnpm", ["aoa", "onboard", "--yes", "--run"], env, "pipe");
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    serverLog.write(text);
    serverOutput += stripAnsi(text);
    if (serverOutput.length > 100_000) serverOutput = serverOutput.slice(-50_000);
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);

  let testExit = 1;
  try {
    const health = await waitForHealth(baseUrl, 180_000);
    const inviteToken = await createBootstrapInvite(baseUrl, options.dbPort, env, serverLog);

    const startupManifest = {
      version: 1,
      campaignId: options.campaignId,
      baseUrl,
      port: options.port,
      dbPort: options.dbPort,
      health,
      providers: {
        claude: spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).stdout?.trim(),
        codex: spawnSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).stdout?.trim(),
      },
      startedAt: new Date().toISOString(),
    };
    await writeFile(resolve(lifecycleDir, "startup-manifest.json"), `${JSON.stringify(startupManifest, null, 2)}\n`);

    const testEnv = {
      ...env,
      AOA_COMMANDER_LIFECYCLE_CAMPAIGN_ID: options.campaignId,
      AOA_COMMANDER_LIFECYCLE_DIR: lifecycleDir,
      AOA_COMMANDER_LIFECYCLE_BASE_URL: baseUrl,
      AOA_COMMANDER_LIFECYCLE_BOOTSTRAP_TOKEN: inviteToken,
      AOA_E2E_REAL_PROVIDER: "1",
      AOA_E2E_REAL_CREW_TIMEOUT_MS: process.env.AOA_E2E_REAL_CREW_TIMEOUT_MS ?? "600000",
    };
    testExit = await new Promise<number>((resolveExit, reject) => {
      const child = spawnCommand(
        "pnpm",
        ["exec", "playwright", "test", "--config=tests/e2e/playwright.commander-lifecycle.config.ts", "--grep", "@commander-lifecycle"],
        testEnv,
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });

    let state: CampaignState | null = null;
    try {
      state = JSON.parse(await readFile(resolve(lifecycleDir, "STATE.json"), "utf8")) as CampaignState;
    } catch {
      state = null;
    }
    const entries = LIVE_SCENARIO_IDS.map((id) => ({
      id,
      actor: "live_campaign",
      layer: "real_provider",
      result: state?.scenarios[id]?.status ?? "NOT_RUN",
      durationMs: 0,
      detail: state?.scenarios[id]?.detail ?? "Scenario did not record a result",
      provenanceLinks: state?.scenarios[id]?.evidence ?? [],
    }));
    const evidenceManifest = {
      version: 1,
      campaignId: options.campaignId,
      mode: "live",
      startedAt: startupManifest.startedAt,
      finishedAt: new Date().toISOString(),
      entries,
    };
    await writeFile(resolve(resultsDir, "test-execution-manifest.json"), `${JSON.stringify(evidenceManifest, null, 2)}\n`);
    const missing = entries.filter((entry) => entry.result !== "PASS");
    if (missing.length > 0) {
      console.error(`Live campaign did not qualify: ${missing.map((entry) => `${entry.id}=${entry.result}`).join(", ")}`);
      testExit ||= 1;
    }
    if (testExit === 0 && state) {
      console.log(`\nCommander lifecycle campaign qualified: ${options.campaignId}`);
      console.log(`Review URL: ${baseUrl}/${state.company.issuePrefix}/commander`);
    }

    if (testExit === 0 && options.leaveRunning) {
      console.log("Lifecycle instance left running for user acceptance. Press Ctrl+C to stop it.");
      await new Promise<void>((resolveWait) => {
        const stop = () => resolveWait();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
  } finally {
    serverLog.end();
    if (!(testExit === 0 && options.leaveRunning)) await stopProcessTree(server);
  }
  process.exitCode = testExit;
}

await main();
