#!/usr/bin/env node

import { open } from "node:fs/promises";
import { resolve } from "node:path";

const output = process.argv[2];
if (!output) {
  console.error("Usage: node scripts/deploy/write-compose-env.mjs <output-path>");
  process.exit(2);
}

const requiredNames = [
  "AOA_POSTGRES_PASSWORD",
  "BETTER_AUTH_SECRET",
  "AOA_AGENT_JWT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

const missing = requiredNames.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required deployment environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Deployment mode is chosen per-deploy (deploy-testing.yml `deployment_mode`
// input → AOA_DEPLOYMENT_MODE_OVERRIDE). Defaults to `authenticated` so a normal
// deploy is byte-identical; set `cloud_auth` to run multi-tenant + E2B sandboxes.
const DEPLOYMENT_MODES = new Set(["authenticated", "cloud_auth"]);
const deploymentMode = process.env.AOA_DEPLOYMENT_MODE_OVERRIDE?.trim() || "authenticated";
if (!DEPLOYMENT_MODES.has(deploymentMode)) {
  console.error(
    `AOA_DEPLOYMENT_MODE_OVERRIDE must be one of ${[...DEPLOYMENT_MODES].join(", ")}; got "${deploymentMode}"`,
  );
  process.exit(1);
}

const values = new Map([
  ["AOA_BIND_ADDRESS", "127.0.0.1"],
  ["AOA_PORT", "3100"],
  ["AOA_INSTANCE_ID", "default"],
  ["AOA_DEPLOYMENT_MODE", deploymentMode],
  ["AOA_DEPLOYMENT_EXPOSURE", "public"],
  ["AOA_INSTALL_PROFILE", "remote_single_tenant"],
  ["AOA_CODEX_DEVICE_AUTH", "true"],
  ["AOA_CLAUDE_PASTE_AUTH", "true"],
  ["AOA_EXECUTION_TARGET_ID", "hetzner-qa"],
  ["AOA_SCOPED_CLI_AUTH", "true"],
  ["AOA_PUBLIC_URL", "https://testing.armyofagents.org"],
  ["AOA_AUTH_BASE_URL_MODE", "explicit"],
  ["AOA_AUTH_PUBLIC_BASE_URL", "https://testing.armyofagents.org"],
  ["AOA_ALLOWED_HOSTNAMES", "testing.armyofagents.org"],
  ["AOA_TRUST_PROXY", "1"],
  ["AOA_MIGRATION_AUTO_APPLY", "true"],
  ["AOA_MARKETPLACE_SKILLS_WRITE_ROOT", "legacy"],
  ["AOA_POSTGRES_USER", "paperclip"],
  ["AOA_POSTGRES_DB", "paperclip"],
  ...requiredNames.map((name) => [name, process.env[name]]),
]);

if (process.env.OPENAI_API_KEY) {
  values.set("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
}

// E2B sandbox provider key — required for cloud_auth execution isolation; inert
// and harmless in authenticated mode (nothing sandboxes there).
if (process.env.E2B_API_KEY) {
  values.set("E2B_API_KEY", process.env.E2B_API_KEY);
}

// E2B sandbox template alias (e.g. "aoa-base", pre-loaded with the claude/codex
// CLIs — see e2b/README.md). Optional: platform-default-environment.ts falls back
// to "base" (bare) when unset. Set it so sandboxed runs/probes start CLI-ready.
if (process.env.E2B_TEMPLATE) {
  values.set("E2B_TEMPLATE", process.env.E2B_TEMPLATE);
}

for (const [name, value] of values) {
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    console.error(`${name} must be a single-line value`);
    process.exit(1);
  }
}

const body = `${[...values]
  .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
  .join("\n")}\n`;

const handle = await open(resolve(output), "wx", 0o600);
try {
  await handle.writeFile(body, "utf8");
  await handle.chmod(0o600);
} finally {
  await handle.close();
}
