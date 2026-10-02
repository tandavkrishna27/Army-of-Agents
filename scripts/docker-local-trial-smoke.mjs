import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.local.yml");
const healthTimeoutMs = Number(process.env.AOA_LOCAL_TRIAL_HEALTH_TIMEOUT_MS ?? 180_000);

export function createSmokeProjectName(pid, suffix) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) {
    throw new Error("Smoke project process id must be a positive integer");
  }
  const safeSuffix = String(suffix ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 12);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
  return `aoa-local-smoke-${Number(pid)}-${safeSuffix || "run"}-${nonce}`.slice(0, 63);
}

export function dockerComposeUpArgs(buildImage = true) {
  return buildImage ? ["up", "--build", "--detach"] : ["up", "--detach"];
}

export function assertOnlyLoopbackPortBindings(portBindings) {
  if (!portBindings || typeof portBindings !== "object" || Array.isArray(portBindings)) {
    throw new Error("Docker inspect returned invalid port binding data");
  }
  const entries = Object.entries(portBindings);
  if (entries.length === 0) throw new Error("Docker inspect reported no published port bindings");

  let count = 0;
  for (const [containerPort, bindings] of entries) {
    if (!/^\d+\/(tcp|udp)$/i.test(containerPort)) {
      throw new Error(`Docker inspect returned an invalid binding for ${containerPort}`);
    }
    // Docker reports exposed-but-unpublished container ports as null. They
    // have no host binding to validate (for example, AoA's internal 3100/tcp;
    // only the local relay on 3101/tcp is published by the trial Compose file).
    if (bindings === null) continue;
    if (!Array.isArray(bindings) || bindings.length === 0) {
      throw new Error(`Docker inspect returned an invalid binding for ${containerPort}`);
    }
    for (const binding of bindings) {
      if (
        !binding ||
        typeof binding !== "object" ||
        binding.HostIp !== "127.0.0.1" ||
        !/^\d+$/.test(String(binding.HostPort ?? "")) ||
        Number(binding.HostPort) < 1 ||
        Number(binding.HostPort) > 65535
      ) {
        throw new Error(`Published Docker port ${containerPort} is not bound exclusively to 127.0.0.1`);
      }
      count += 1;
    }
  }
  if (count === 0) throw new Error("Docker inspect reported no published port bindings");
  return true;
}

export function getPublishedHostPorts(portBindings) {
  if (!portBindings || typeof portBindings !== "object" || Array.isArray(portBindings)) {
    throw new Error("Docker inspect returned invalid port binding data");
  }
  return Object.values(portBindings)
    .filter((bindings) => Array.isArray(bindings))
    .flat()
    .map((binding) => Number(binding?.HostPort));
}

export async function assertHostPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AOA_PORT must be a valid TCP port from 1 to 65535");
  }
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`Host port ${port} is already in use; choose another loopback port with AOA_PORT=<port>`));
      } else {
        reject(error);
      }
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function run(command, args, { cwd = repoRoot, env = process.env, quiet = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      finish(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0) {
        const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-8000);
        finish(new Error(`${command} ${args.join(" ")} exited with ${signal ?? `code ${result.code}`}${detail ? `:\n${detail}` : ""}`));
        return;
      }
      finish(null, result);
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        finish(new Error(`${command} preflight timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    }
  });
}

function smokeEnvironment(port, baseUrl, companyName, imageTag) {
  const env = { ...process.env, AOA_PORT: String(port) };
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "AOA_IMAGE",
    "AOA_IMAGE_REVISION",
    "USER_UID",
    "USER_GID",
  ]) {
    delete env[key];
  }
  env.AOA_RELEASE_SMOKE_BASE_URL = baseUrl;
  env.AOA_LOCAL_TRIAL_COMPANY_NAME = companyName;
  env.AOA_IMAGE = imageTag;
  return env;
}

function composeArgs(projectName, envFile, args) {
  return [
    "compose",
    "--env-file",
    envFile,
    "--project-name",
    projectName,
    "--file",
    composeFile,
    ...args,
  ];
}

async function chooseHostPort() {
  if (process.env.AOA_PORT !== undefined && process.env.AOA_PORT.trim() !== "") {
    const port = Number(process.env.AOA_PORT);
    await assertHostPortAvailable(port);
    return port;
  }

  const start = 32_000 + (process.pid % 20_000);
  let lastError;
  for (let offset = 0; offset < 50 && start + offset <= 65_535; offset += 1) {
    try {
      await assertHostPortAvailable(start + offset);
      return start + offset;
    } catch (error) {
      lastError = error;
      if (!String(error?.message).includes("already in use")) throw error;
    }
  }
  throw new Error(`Could not find a free local trial port: ${lastError?.message ?? "no ports tried"}`);
}

async function waitForHealthy(baseUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastIssue = "no response yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = await response.json();
        if (body.deploymentMode !== "local_trusted") {
          throw new Error(`Health endpoint reported unexpected deployment mode: ${body.deploymentMode}`);
        }
        return body;
      }
      lastIssue = `health returned HTTP ${response.status}`;
    } catch (error) {
      if (String(error?.message).includes("unexpected deployment mode")) throw error;
      lastIssue = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`AoA did not become healthy at ${baseUrl}/api/health within ${deadlineMs} ms (${lastIssue})`);
}

async function getCompanyByName(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/companies`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not list local companies after onboarding: HTTP ${response.status}`);
  const companies = await response.json();
  const company = Array.isArray(companies) ? companies.find((entry) => entry.name === name) : null;
  if (!company?.id || !company?.issuePrefix) {
    throw new Error(`Smoke-created company ${JSON.stringify(name)} was not returned by /api/companies`);
  }
  return company;
}

async function captureFailure(compose, projectOwned) {
  if (!projectOwned) return;
  console.error("\n==> Local Docker trial failed; collecting isolated stack diagnostics before cleanup");
  for (const args of [["ps", "--all"]]) {
    try {
      await compose(...args);
    } catch (error) {
      console.error(String(error?.message ?? error));
    }
  }
  try {
    const logs = await compose("logs", "--no-color", "--tail=120");
    const lines = logs.stdout.split(/\r?\n/);
    const errorIndexes = lines.flatMap((line, index) =>
      /\b(error|exception|uncaught|TypeError|ReferenceError|failed)\b|\b500\b|internal-agent\/verify|crew|marketplace|install/i.test(line)
        ? [index]
        : [],
    );
    const relevantIndexes = new Set();
    for (const index of errorIndexes.slice(-12)) {
      for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(lines.length - 1, index + 4); neighbor += 1) {
        relevantIndexes.add(neighbor);
      }
    }
    console.error("==> Relevant isolated container error logs");
    console.error([...relevantIndexes].sort((a, b) => a - b).map((index) => lines[index]?.slice(0, 600)).join("\n"));
  } catch (error) {
    console.error(String(error?.message ?? error));
  }
}

async function main() {
  let projectName;
  let imageTag;
  let envDir;
  let envFile;
  let projectOwned = false;
  let imageBuildRequested = false;
  let passed = false;
  let compose;
  const cleanupErrors = [];
  const smokeId = randomBytes(4).toString("hex");

  try {
    await run("docker", ["--version"], { quiet: true, timeoutMs: 15_000 });
    await run("docker", ["compose", "version"], { quiet: true, timeoutMs: 15_000 });
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { quiet: true, timeoutMs: 20_000 });
  } catch (error) {
    throw new Error(`Docker Desktop/Engine with Compose v2 must be installed and running. ${error.message}`);
  }

  try {
  const port = await chooseHostPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  projectName = createSmokeProjectName(process.pid, smokeId);
  const companyName = `AoA Local Trial ${smokeId}`;
  const buildImage = !process.argv.includes("--no-build");
  imageBuildRequested = buildImage;
  imageTag = buildImage ? `aoa-local-smoke:${process.pid}-${smokeId}` : "aoa:local";
  const env = smokeEnvironment(port, baseUrl, companyName, imageTag);
  envDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-local-trial-smoke-"));
  envFile = path.join(envDir, "empty.env");
  await fs.writeFile(envFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  compose = (...args) => run("docker", composeArgs(projectName, envFile, args), {
    env,
    quiet: args[0] === "config" || args[0] === "logs",
  });

  console.log(`==> Local trial smoke (${projectName}) at ${baseUrl}`);
  const existing = await compose("ps", "--all", "--quiet");
  if (existing.stdout.trim()) {
    throw new Error(`Refusing to use Compose project ${projectName}: it already has resources`);
  }
  projectOwned = true;

  const resolved = await compose("config", "--format", "json");
  const config = JSON.parse(resolved.stdout);
  const service = config.services?.aoa;
  if (!service) throw new Error("Resolved local Compose config has no aoa service");
  if (service.environment?.GOOGLE_CLIENT_ID || service.environment?.GOOGLE_CLIENT_SECRET || service.environment?.DATABASE_URL) {
    throw new Error("Local trial resolved Compose config unexpectedly contains Google OAuth or DATABASE_URL");
  }
  if (
    service.environment?.HOST !== "127.0.0.1" ||
    service.environment?.AOA_INSTALL_PROFILE !== "local_single_user" ||
    service.environment?.AOA_MARKETPLACE_SKILLS_WRITE_ROOT !== "persistent" ||
    service.ports?.length !== 1 ||
    service.ports[0]?.host_ip !== "127.0.0.1" ||
    Number(service.ports[0]?.target) !== 3101
  ) {
    throw new Error("Resolved Compose settings do not match the expected loopback-only local-trial contract");
  }

  console.log(buildImage ? "==> Building the local image" : "==> Reusing the existing local image (--no-build)");
  await compose(...dockerComposeUpArgs(buildImage));
  await waitForHealthy(baseUrl, healthTimeoutMs);
  const containerId = (await compose("ps", "--quiet", "aoa")).stdout.trim().split(/\s+/)[0];
  if (!containerId) throw new Error("Compose started without returning the AoA container id");
  const inspected = await run(
    "docker",
    ["inspect", "--format", "{{json .NetworkSettings.Ports}}", containerId],
    { env, quiet: true },
  );
  const bindings = JSON.parse(inspected.stdout.trim());
  assertOnlyLoopbackPortBindings(bindings);
  const published = getPublishedHostPorts(bindings);
  if (!published.includes(port)) throw new Error(`Docker did not publish the requested loopback port ${port}`);

  console.log("==> Checking runtime identity and writable persistent home");
  await compose("exec", "-T", "--user", "node", "aoa", "sh", "-lc", "id; ls -ld /aoa /aoa/.codex 2>&1 || true; test -w /aoa");

  console.log("==> Checking bundled Codex and Claude CLI executables");
  await compose("exec", "-T", "--user", "node", "aoa", "sh", "-lc", "codex --version && claude --version");

  console.log("==> Running browser onboarding and provider-capability checks");
  await run(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config=tests/release-smoke/playwright.config.ts",
      "tests/release-smoke/docker-local-trial-onboarding.spec.ts",
    ],
    { env },
  );

  const beforeRestart = await getCompanyByName(baseUrl, companyName);
  console.log("==> Stopping and recreating the stack to verify named-volume persistence");
  await compose("down", "--timeout", "30");
  const remainingVolumes = await run(
    "docker",
    ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`],
    { env, quiet: true },
  );
  if (!remainingVolumes.stdout.trim()) {
    throw new Error("Compose down removed the local trial volume; expected data to persist without --volumes");
  }
  await compose("up", "--detach");
  await waitForHealthy(baseUrl, healthTimeoutMs);
  const afterRestart = await getCompanyByName(baseUrl, companyName);
  if (afterRestart.id !== beforeRestart.id || afterRestart.issuePrefix !== beforeRestart.issuePrefix) {
    throw new Error("Company identity changed after Compose down/up; local trial persistence check failed");
  }

  passed = true;
  console.log(`PASS: local Docker trial onboarding, loopback binding, provider capability, and down/up persistence (${companyName})`);
} catch (error) {
  await captureFailure(compose, projectOwned);
  throw error;
} finally {
  if (projectOwned && /^aoa-local-smoke-[a-z0-9_-]+$/.test(projectName ?? "")) {
    try {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "30");
      if (!passed) console.log("Cleaned up only the uniquely named local-trial smoke project and volume.");
    } catch (error) {
      cleanupErrors.push(`Compose cleanup failed for ${projectName}: ${error?.message ?? error}`);
      console.error(`Could not clean up smoke project ${projectName}: ${error?.message ?? error}`);
    }
  }
  if (imageBuildRequested && /^aoa-local-smoke:\d+-[a-f0-9]{8}$/.test(imageTag ?? "")) {
    try {
      await run("docker", ["image", "rm", imageTag], { quiet: true });
      console.log(`Removed generated smoke image ${imageTag}.`);
    } catch (error) {
      cleanupErrors.push(`Generated image cleanup failed for ${imageTag}: ${error?.message ?? error}`);
      console.error(`Could not remove generated smoke image ${imageTag}: ${error?.message ?? error}`);
    }
  }
  if (envDir) {
    try {
      await fs.rm(envDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`Temporary env cleanup failed: ${error?.message ?? error}`);
    }
  }
  if (cleanupErrors.length > 0) {
    console.error(`Smoke cleanup was incomplete: ${cleanupErrors.join("; ")}`);
    process.exitCode = 1;
  }
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Local Docker trial smoke failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
