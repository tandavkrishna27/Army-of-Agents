#!/usr/bin/env node
// WRK-008 slice 2 — the daemon's vendored route paths must equal the server's routes.
//
// ★ WHY A SCRIPT AND NOT A TEST. `packages/worker-daemon` may import only
// `@armyofagents/worker-protocol`, `pino` and Node builtins (E4-D01), and `server` does
// not depend on worker-daemon — so NEITHER side can import the other's constant. A test
// living in either package would have to read the other's source as text and would skip
// silently wherever that file is absent. A repo-level guard has the whole tree by
// definition, and this repo already forces every `check-*.mjs` to be declared in
// `guard-inventory.json`, so it cannot quietly stop running.
//
// ★ WHY IT MATTERS MORE THAN A 404. The device proof is signed OVER the request path.
// If these drift, the symptom is not "route not found" — it is a signature that can never
// verify, on a request that reached the right handler. That failure reads as an auth bug
// and sends the reader to the crypto, not to a renamed route.

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/** Each pair: a constant in the daemon's client, and the Express route that serves it.
 * `mount` is the prefix the server router is mounted under — the daemon signs the FULL
 * path, so the prefix is part of the contract, not decoration. */
const PAIRS = [
  {
    name: "self-model read (WRK-008 slice 2)",
    daemonFile: "packages/worker-daemon/src/transport/client.ts",
    daemonConst: "SELF_MODEL_READ_PATH",
    serverFile: "server/src/routes/execution-targets.ts",
    mount: "/api",
    serverRoute: "/execution-targets/self/placement-profile",
  },
  {
    name: "session renewal (WRK-010 slice 2)",
    daemonFile: "packages/worker-daemon/src/transport/client.ts",
    daemonConst: "SESSION_RENEW_PATH",
    serverFile: "server/src/routes/worker-control.ts",
    mount: "/api",
    serverRoute: "/worker-control/session/renew",
  },
  {
    name: "self-hello refresh (WRK-011)",
    daemonFile: "packages/worker-daemon/src/transport/client.ts",
    daemonConst: "SELF_HELLO_PATH",
    serverFile: "server/src/routes/execution-targets.ts",
    mount: "/api",
    serverRoute: "/execution-targets/self/hello",
  },
  {
    name: "execution-secret resolve (DAT-008 slice 5)",
    daemonFile: "packages/worker-daemon/src/transport/client.ts",
    daemonConst: "EXECUTION_SECRET_RESOLVE_PATH",
    serverFile: "server/src/routes/worker-control.ts",
    mount: "/api",
    serverRoute: "/worker-control/execution-secrets/resolve",
    // ★ The LOCAL descriptor is hand-duplicated on both sides. The path is not the whole contract:
    // a one-sided edit to the size ceiling or timeout would drift SILENTLY (a worker body over the
    // server's ceiling → denyMalformed on every resolve). Cross-check the numbers too.
    daemonDescriptor: { file: "packages/worker-daemon/src/transport/client.ts", const: "EXECUTION_SECRET_RESOLVE_DESCRIPTOR" },
    serverDescriptor: { file: "server/src/services/execution-secret-resolve.ts", const: "EXECUTION_SECRET_RESOLVE_DESCRIPTOR" },
  },
  {
    name: "worker execution-target heartbeat (Wave-4 session-lifetime)",
    daemonFile: "packages/worker-daemon/src/transport/client.ts",
    daemonConst: "HEARTBEAT_PATH",
    serverFile: "server/src/routes/execution-targets.ts",
    mount: "/api",
    serverRoute: "/execution-targets/heartbeat",
  },
];

/** Evaluate a small integer expression (`4 * 1024`, `10_000`) — no `eval`, digits + `*` only. */
function evalIntExpr(expr) {
  const parts = String(expr).replace(/_/g, "").trim().split("*").map((p) => Number.parseInt(p.trim(), 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((a, b) => a * b, 1);
}

/** Extract `{maxRequestBytes, timeoutMs}` from a named descriptor const (values may be expressions). */
function readDescriptorNumbers(file, constName) {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const start = text.indexOf(`${constName} =`);
  if (start < 0) return null;
  const block = text.slice(start, start + 400);
  const maxM = block.match(/maxRequestBytes:\s*([0-9_ *]+)/);
  const toM = block.match(/timeoutMs:\s*([0-9_ *]+)/);
  if (!maxM || !toM) return null;
  return { maxRequestBytes: evalIntExpr(maxM[1]), timeoutMs: evalIntExpr(toM[1]) };
}

function readConstant(file, name) {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const m = text.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

function serverDeclaresRoute(file, route) {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  // The route string must appear as a router registration argument, not merely anywhere
  // in the file — a mention inside a comment is exactly the false positive this
  // programme has hit before (a comment naming a symbol read as a use of it).
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return withoutComments.includes(`"${route}"`);
}

const failures = [];
for (const pair of PAIRS) {
  const declared = readConstant(pair.daemonFile, pair.daemonConst);
  if (declared === null) {
    failures.push(`${pair.name}: ${pair.daemonConst} not found in ${pair.daemonFile}`);
    continue;
  }
  const expected = `${pair.mount}${pair.serverRoute}`;
  if (declared !== expected) {
    failures.push(
      `${pair.name}: the daemon signs ${JSON.stringify(declared)} but the server serves ` +
        `${JSON.stringify(expected)} — the device proof would never verify`,
    );
  }
  if (!serverDeclaresRoute(pair.serverFile, pair.serverRoute)) {
    failures.push(
      `${pair.name}: ${pair.serverFile} no longer registers ${JSON.stringify(pair.serverRoute)} ` +
        "(searched with comments stripped, so a mention in a comment does not count)",
    );
  }
  if (pair.daemonDescriptor && pair.serverDescriptor) {
    const d = readDescriptorNumbers(pair.daemonDescriptor.file, pair.daemonDescriptor.const);
    const s = readDescriptorNumbers(pair.serverDescriptor.file, pair.serverDescriptor.const);
    if (!d || !s) {
      failures.push(`${pair.name}: descriptor ${!d ? pair.daemonDescriptor.const : pair.serverDescriptor.const} not found/parseable`);
    } else if (d.maxRequestBytes !== s.maxRequestBytes || d.timeoutMs !== s.timeoutMs) {
      failures.push(
        `${pair.name}: descriptor DRIFT — daemon ${JSON.stringify(d)} vs server ${JSON.stringify(s)} ` +
          "(a one-sided ceiling/timeout edit; the daemon body would be refused or the timeout mismatched)",
      );
    }
  }
}

if (failures.length > 0) {
  console.error("worker route-path parity FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`worker route-path parity OK (${PAIRS.length} pair${PAIRS.length === 1 ? "" : "s"})`);
