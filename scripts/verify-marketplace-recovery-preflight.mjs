#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeEvidenceFromDocker,
  evaluatePreflight,
  MARKETPLACE_RECOVERY_PREFLIGHT_REQUESTS,
  parseComposePs,
  sanitizePreflightError,
} from "./lib/marketplace-recovery-preflight.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const apiBase = (
  args.get("--api-base") ||
  process.env.AOA_API_URL ||
  ""
).replace(/\/+$/, "");
const expectedSha =
  args.get("--expected-sha") || process.env.AOA_DEPLOY_SHA || "";
const expectedInstanceId =
  args.get("--instance-id") || process.env.AOA_INSTANCE_ID || "default";
const expectedSelector =
  args.get("--write-root") ||
  process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT ||
  "legacy";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

if (!apiBase || !expectedSha) {
  console.error(
    "Usage: node scripts/verify-marketplace-recovery-preflight.mjs " +
      "--api-base <url> --expected-sha <sha> " +
      "[--instance-id default] [--write-root legacy]",
  );
  process.exit(2);
}
let parsedApiBase;
try {
  parsedApiBase = new URL(apiBase);
} catch {
  console.error("--api-base must be a valid HTTP(S) origin");
  process.exit(2);
}
if (
  !["http:", "https:"].includes(parsedApiBase.protocol) ||
  parsedApiBase.username ||
  parsedApiBase.password ||
  parsedApiBase.search ||
  parsedApiBase.hash ||
  parsedApiBase.pathname !== "/"
) {
  console.error(
    "--api-base must be a credential-free HTTP(S) origin without a path, query, or fragment",
  );
  process.exit(2);
}
if (!FULL_GIT_SHA.test(expectedSha)) {
  console.error("--expected-sha must be exactly 40 lowercase hexadecimal characters");
  process.exit(2);
}
if (!INSTANCE_ID.test(expectedInstanceId)) {
  console.error("--instance-id must contain only letters, numbers, underscores, and hyphens");
  process.exit(2);
}
if (!["legacy", "persistent"].includes(expectedSelector)) {
  console.error("--write-root must be legacy or persistent");
  process.exit(2);
}

function storedCredential() {
  if (process.env.AOA_API_KEY?.trim()) return process.env.AOA_API_KEY.trim();
  const home = process.env.AOA_HOME?.trim()
    ? path.resolve(process.env.AOA_HOME)
    : path.join(os.homedir(), ".aoa");
  const storePath = process.env.AOA_AUTH_STORE?.trim()
    ? path.resolve(process.env.AOA_AUTH_STORE)
    : path.join(home, "auth.json");
  if (!fs.existsSync(storePath)) return null;
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  return store?.credentials?.[apiBase]?.token ?? null;
}

const token = storedCredential();
if (!token) {
  console.error(
    "No board credential found for this API base. Run `pnpm aoa auth login --instance-admin`.",
  );
  process.exit(1);
}

async function getJson(endpoint, authenticated = false) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    headers: authenticated
      ? { authorization: `Bearer ${token}`, accept: "application/json" }
      : { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}`);
  }
  return body;
}

function composeEvidence() {
  const psRaw = execFileSync(
    "docker",
    ["compose", "ps", "--format", "json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const servers = parseComposePs(psRaw).filter(
    (entry) =>
      String(entry.Service ?? "").toLowerCase() === "server" &&
      String(entry.State ?? "").toLowerCase() === "running",
  );
  if (servers.length !== 1) {
    throw new Error(
      `Expected exactly one running server replica; found ${servers.length}`,
    );
  }
  const containerId = servers[0].ID || servers[0].Id || servers[0].Name;
  const inspectionRaw = execFileSync("docker", ["inspect", containerId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return composeEvidenceFromDocker(psRaw, inspectionRaw);
}

try {
  const responses = await Promise.all(
    MARKETPLACE_RECOVERY_PREFLIGHT_REQUESTS.map(async (request) => [
      request.key,
      await getJson(request.endpoint, request.authenticated),
    ]),
  );
  const { health, catalog, identity } = Object.fromEntries(responses);
  const compose = composeEvidence();
  const { ok, checks } = evaluatePreflight({
    health,
    catalog,
    identity,
    compose,
    expectedSha,
    expectedSelector,
    expectedInstanceId,
  });
  console.log(
    JSON.stringify(
      {
        ok,
        apiBase,
        expectedSha,
        checks,
        catalog: {
          source: catalog.source ?? null,
          schemaVersion: catalog.schemaVersion ?? null,
          itemCount: catalog.itemCount ?? null,
          lastSyncedAt: catalog.lastSyncedAt ?? null,
        },
        deployment: compose,
        actor: {
          userId: identity.userId ?? null,
          isInstanceAdmin: identity.isInstanceAdmin === true,
        },
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        error instanceof Error
          ? sanitizePreflightError(error.message)
          : "preflight failed",
    }),
  );
  process.exit(1);
}
