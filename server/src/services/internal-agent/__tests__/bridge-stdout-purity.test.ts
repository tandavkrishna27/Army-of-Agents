/**
 * STRICT STDOUT-PURITY REGRESSION — second, independent "Transport closed" cause.
 *
 * WHY THIS EXISTS (the bug, in one paragraph):
 *   The MCP stdio bridge owns stdout for JSON-RPC frames — the MCP client parses
 *   EVERY stdout line as a protocol message. At boot, `startBridge()` calls
 *   `createServiceContainer(db)`, which eagerly constructs the embeddings service;
 *   when `OPENAI_API_KEY` is unset that path logs a WARN ("OPENAI_API_KEY is not
 *   set …") through the project's pino `logger`, which (in the normal server
 *   config) writes to STDOUT (fd 1). That WARN lands ahead of the JSON-RPC
 *   `initialize` response; a real MCP client (codex's rmcp) parses the
 *   "[HH:MM:ss] WARN …" line as the response, fails to parse it, and the
 *   transport dies → "Transport closed" → the agent posts nothing. The bridge
 *   subprocess never receives OPENAI_API_KEY (buildMcpBridgeSpec doesn't forward
 *   it), so this fired on EVERY real codex/opencode/gemini run.
 *
 *   The fix: buildMcpBridgeSpec sets AOA_LOG_STDOUT=0, and middleware/logger.ts
 *   routes ALL pino output to stderr (fd 2) in that mode — stdout stays JSON-RPC
 *   only. This test proves the invariant directly, with a REAL bridge subprocess
 *   and OPENAI_API_KEY explicitly UNSET:
 *     • EVERY non-empty stdout line parses as a JSON-RPC 2.0 message (a single
 *       non-JSON line on stdout FAILS the test — NOT a filter-and-find).
 *     • "OPENAI_API_KEY is not set" appears NOWHERE in stdout …
 *     • … but DOES appear in stderr (the WARN was rerouted, not suppressed —
 *       the log is preserved for debugging).
 *     • the id-3 tool response still lands (the transport works end-to-end).
 *
 *   The existing lifecycle integration tests MISSED this bug because they parse
 *   stdout with `try{JSON.parse(l)}catch{return null}` and FILTER non-JSON lines,
 *   masking the corruption. A real client does not filter — and neither does this
 *   test. (Teeth check: if AOA_LOG_STDOUT=0 is NOT set, the WARN corrupts stdout
 *   and the strict per-line assertion fails. Verified once during development.)
 *
 * GATING: F5 "skip loudly if no DB reachable" — without the QA DB the bridge can't
 * serve thread.listEntries, so there is no transport to exercise. Windows teardown
 * uses `taskkill /PID <pid> /T /F` so no tsx/bridge orphans survive.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const BRIDGE = path.resolve(__dirname, "../mcp-bridge.ts");
const DB_URL = process.env.AOA_TEST_DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip";
const COMPANY = process.env.AOA_TEST_COMPANY_ID ?? "8d7569f2-43e9-4b57-8709-2a4687364e44";
const THREAD = process.env.AOA_TEST_THREAD_ID ?? "376592a2-91e6-4327-81fb-8fb7e498b6c4";

const OPENAI_WARN = "OPENAI_API_KEY is not set";

/**
 * F5 robustness: probe the DB host:port parsed from DB_URL. If the DB is unreachable
 * the bridge can't answer the tools/call, so we skip LOUDLY.
 *
 * ★★★ THE PROBE MUST PROVE IT FOUND POSTGRES, NOT JUST THAT SOMETHING ACCEPTED.
 * This gate used to resolve `true` on the bare `connect` event, and that admitted on
 * nothing: on 2026-09-09 the required `verify (3)` shard went red here on a run whose
 * SIBLING suites (mcp-bridge-lifecycle) printed "[skip] no DB reachable" for this very
 * URL six minutes earlier, and whose tree touches neither the bridge nor
 * `internal_agent_config`. The port is 54440, inside Linux's default ephemeral range
 * (32768-60999), so a loopback `connect()` there can be accepted by something that is
 * not a database at all -- a TCP self-connect (source port lands on the destination
 * port) or an unrelated worker socket. The bridge then started, connected, and died on
 * `select ... from internal_agent_config`, failing the assertion with an empty stdout.
 *
 * So: after the connect, send a PostgreSQL SSLRequest (the 8-byte startup packet every
 * server answers before authentication) and require a single-byte 'S' or 'N' reply. A
 * self-connect echoes the request bytes back and a foreign listener says something else
 * or nothing -- both now SKIP, which is the honest outcome, instead of failing a real
 * regression test on an environment accident.
 */
function probeDb(url: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 5432;
    try {
      const u = new URL(url);
      host = u.hostname || host;
      port = u.port ? Number(u.port) : port;
    } catch {
      resolve(false);
      return;
    }
    // int32 length = 8, int32 code = 80877103 (1234 << 16 | 5679) — the SSLRequest.
    const sslRequest = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => sock.write(sslRequest));
    sock.once("data", (chunk: Buffer) => {
      // A real server replies with exactly one byte: 'S' (0x53) or 'N' (0x4e).
      done(chunk.length > 0 && (chunk[0] === 0x53 || chunk[0] === 0x4e));
    });
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.once("close", () => done(false));
  });
}

/**
 * Spawn the REAL bridge with OPENAI_API_KEY explicitly UNSET (deleted from the
 * child env — this is the whole point: the absent key is what fires the WARN)
 * and AOA_LOG_STDOUT=0 set. Resolve as soon as the id-3 response lands, then
 * reap the whole process tree (Windows: taskkill /T; POSIX: SIGKILL the group).
 */
function runBridge(input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Build the child env, then DELETE OPENAI_API_KEY so the embeddings WARN
    // fires — the exact condition a real run hits (the bridge spec never forwards
    // the key). AOA_LOG_STDOUT=0 is what the fix relies on to reroute it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AOA_LOG_STDOUT: "0",
      AOA_SESSION_COMPANY_ID: COMPANY,
      AOA_SESSION_USER_ID: "aoa-subagent",
      AOA_SESSION_USER_ROLE: "founder",
      AOA_SESSION_ENABLED_CAPABILITIES: "discussion_processing,system_actions",
      AOA_AGENT_KIND: "aoa",
      AOA_TOOL_ALLOWLIST: "thread.listEntries,get_thread_summary,thread.updateSummary",
      AOA_EFFECTIVE_AUTONOMY: "2",
      DATABASE_URL: DB_URL,
    };
    delete env.OPENAI_API_KEY;

    // shell:true so the launcher resolves `tsx.cmd` on Windows; JSON.stringify
    // quotes the bridge path so a path with spaces survives shell concatenation.
    const proc = spawn("tsx", [JSON.stringify(BRIDGE)], { env, shell: true });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (process.platform === "win32") {
        if (proc.pid !== undefined) {
          try { spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]); } catch { /* best-effort */ }
        }
      } else {
        try { proc.kill("SIGKILL"); } catch { /* best-effort */ }
      }
      resolve({ stdout, stderr });
    };

    const sawId3 = () =>
      stdout.split("\n").some((l) => { try { return JSON.parse(l).id === 3; } catch { return false; } });

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (sawId3()) finish();
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", finish);

    proc.stdin.write(input);
    setTimeout(() => proc.stdin.end(), 5);
    // Safety: resolve + tree-kill even if id 3 never arrives (e.g. bridge wedged).
    setTimeout(finish, 30_000);
  });
}

describe("mcp-bridge stdout purity (pino must not corrupt the JSON-RPC stream)", () => {
  it(
    "keeps stdout JSON-RPC-only with OPENAI_API_KEY unset; the WARN is on stderr",
    async () => {
      const reachable = await probeDb(DB_URL);
      if (!reachable) {
        console.warn(
          `[skip] no DB reachable at ${DB_URL} — the bridge needs the QA database to answer ` +
            `thread.listEntries; skipping the stdout-purity regression (not failing).`,
        );
        return;
      }

      const input =
        JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "thread.listEntries", arguments: { threadId: THREAD } } }) + "\n";

      const { stdout, stderr } = await runBridge(input);

      // ── Assertion 1 (the whole point): EVERY non-empty stdout line is a valid
      // JSON-RPC 2.0 message. This is NOT a filter-and-find — a single non-JSON
      // line (e.g. a stray "[HH:MM:ss] WARN …") FAILS the test, exactly as a real
      // MCP client would choke on it.
      const stdoutLines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      expect(
        stdoutLines.length,
        `Bridge stdout was empty — expected at least the initialize + id-3 JSON-RPC frames.\n` +
          `stderr head:\n${stderr.slice(0, 1200)}`,
      ).toBeGreaterThan(0);

      for (const line of stdoutLines) {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(
            `Non-JSON line on bridge STDOUT — this corrupts the MCP protocol (the client ` +
              `parses every stdout line as a JSON-RPC message → "Transport closed").\n` +
              `Offending line: ${JSON.stringify(line)}\n` +
              `Full stdout:\n${stdout}`,
          );
        }
        expect(
          parsed.jsonrpc,
          `A stdout line parsed as JSON but is not a JSON-RPC 2.0 message: ${line}`,
        ).toBe("2.0");
      }

      // ── Assertion 2: the embeddings WARN must NOT appear on stdout. (Redundant
      // with the per-line check, but it pins the exact regression in the message.)
      expect(
        stdout.includes(OPENAI_WARN),
        `The "${OPENAI_WARN}" WARN leaked onto bridge STDOUT — it must be routed to stderr ` +
          `(AOA_LOG_STDOUT=0). This is the second Transport-closed cause.\nFull stdout:\n${stdout}`,
      ).toBe(false);

      // ── Assertion 3: the WARN must appear on STDERR — proving it was REROUTED
      // (preserved for debugging), not merely suppressed. With OPENAI_API_KEY
      // unset the embeddings warn-once path is guaranteed to fire at bridge boot.
      expect(
        stderr.includes(OPENAI_WARN),
        `Expected the "${OPENAI_WARN}" WARN on bridge STDERR (the log must be preserved, ` +
          `just rerouted off stdout). It was absent — the warn was lost, not rerouted.\n` +
          `stderr head:\n${stderr.slice(0, 2000)}`,
      ).toBe(true);

      // ── Assertion 4: the id-3 tool response still lands — the transport works.
      const id3 = stdoutLines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((f) => f?.id === 3);
      expect(
        id3,
        `The id-3 (thread.listEntries) response never arrived — the bridge transport did not ` +
          `deliver it. Full stdout:\n${stdout}`,
      ).toBeDefined();
    },
    40_000,
  );
});
