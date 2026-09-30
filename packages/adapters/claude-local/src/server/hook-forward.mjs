#!/usr/bin/env node
/**
 * hook-forward.mjs — PreToolUse hook forwarder for the AoA permission bridge.
 *
 * Spawned as a subprocess by the Claude CLI's PreToolUse hook (type:"command").
 * Reads the hook event JSON from stdin, POSTs it to the AoA permission
 * endpoint, and writes the response body to stdout.
 *
 * Fail-CLOSED: any failure (network error, non-2xx, malformed body, timeout,
 * thrown exception) writes a deny decision to stdout and exits 0.  The CLI
 * interprets exit 0 + deny as "block the tool call".  We must never hang or
 * crash the hook subprocess.
 *
 * Env vars (injected by the adapter at CLI spawn time — Task 6):
 *   AOA_RUNTIME_HOOK_URL   — full URL to POST to
 *   AOA_RUNTIME_HOOK_TOKEN — Bearer token for Authorization header
 */

import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

/** Slightly under the 300-second block timeout so the hook never outlives it. */
const SOCKET_TIMEOUT_MS = 295_000;

const DENY_OUTPUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "hook-forward error",
  },
});

function writeDenyAndExit() {
  process.stdout.write(DENY_OUTPUT + "\n");
  process.exit(0);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const bodyBuf = Buffer.from(body, "utf-8");

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": bodyBuf.length,
        "authorization": `Bearer ${token}`,
      },
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") });
      });
      res.on("error", reject);
    });

    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error("socket timeout"));
    });

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  const url = process.env.AOA_RUNTIME_HOOK_URL;
  // F1: the bearer token is delivered via a file whose path is argv[2], so it
  // never rides in AOA_RUNTIME_HOOK_TOKEN (which a stdio connector child would
  // inherit, and which stripConnectorRunBearers removes on connector runs).
  // Fall back to the env var for backward compatibility (no-connector runs that
  // still inject it, or older callers).
  let token = "";
  const tokenFilePath = process.argv[2];
  if (tokenFilePath) {
    try {
      token = readFileSync(tokenFilePath, "utf-8").trim();
    } catch {
      token = "";
    }
  }
  if (!token) {
    token = process.env.AOA_RUNTIME_HOOK_TOKEN ?? "";
  }

  if (!url) {
    // No endpoint configured — fail closed
    writeDenyAndExit();
    return;
  }

  let stdinBody;
  try {
    stdinBody = await readStdin();
  } catch {
    writeDenyAndExit();
    return;
  }

  let response;
  try {
    response = await postJson(url, token, stdinBody);
  } catch {
    writeDenyAndExit();
    return;
  }

  // Non-2xx → deny
  if (response.statusCode < 200 || response.statusCode >= 300) {
    writeDenyAndExit();
    return;
  }

  // Empty body → deny
  const raw = response.body.trim();
  if (!raw) {
    writeDenyAndExit();
    return;
  }

  // Attempt to parse — if malformed → deny
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeDenyAndExit();
    return;
  }

  // Validate minimum expected shape
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.hookSpecificOutput ||
    typeof parsed.hookSpecificOutput !== "object"
  ) {
    writeDenyAndExit();
    return;
  }

  // Everything looks good — echo the server response to stdout
  process.stdout.write(JSON.stringify(parsed) + "\n");
  process.exit(0);
}

main().catch(() => {
  writeDenyAndExit();
});
