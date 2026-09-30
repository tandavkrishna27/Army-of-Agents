import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORWARDER_PATH = path.resolve(__dirname, "../server/hook-forward.mjs");

const SAMPLE_HOOK_PAYLOAD = JSON.stringify({
  hookEventName: "PreToolUse",
  toolName: "Bash",
  toolInput: { command: "ls -la" },
});

const DENY_DECISION = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "hook-forward error",
  },
};

function runForwarder(
  url: string,
  token: string,
  stdin: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [FORWARDER_PATH], {
      env: {
        ...process.env,
        AOA_RUNTIME_HOOK_URL: url,
        AOA_RUNTIME_HOOK_TOKEN: token,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);

    proc.on("close", (code: number | null) => {
      resolve({ stdout: stdout.trim(), exitCode: code ?? 0 });
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function startStubServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on("error", reject);
  });
}

describe("hook-forward.mjs", () => {
  it("echoes the allow decision when the stub returns a valid allow response", async () => {
    const allowDecision = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "approved",
      },
    };

    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowDecision));
    });

    try {
      const { stdout, exitCode } = await runForwarder(stub.url, "test-token", SAMPLE_HOOK_PAYLOAD);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(allowDecision);
    } finally {
      await stub.close();
    }
  });

  it("emits deny and exits 0 when the stub returns HTTP 500", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });

    try {
      const { stdout, exitCode } = await runForwarder(stub.url, "test-token", SAMPLE_HOOK_PAYLOAD);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(DENY_DECISION);
    } finally {
      await stub.close();
    }
  });

  it("emits deny and exits 0 when the stub returns malformed/empty body", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(""); // empty body
    });

    try {
      const { stdout, exitCode } = await runForwarder(stub.url, "test-token", SAMPLE_HOOK_PAYLOAD);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(DENY_DECISION);
    } finally {
      await stub.close();
    }
  });

  it("emits deny and exits 0 when the stub returns non-JSON body with 200", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json at all");
    });

    try {
      const { stdout, exitCode } = await runForwarder(stub.url, "test-token", SAMPLE_HOOK_PAYLOAD);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(DENY_DECISION);
    } finally {
      await stub.close();
    }
  });

  it("reads the bearer token from the argv[2] FILE (F1), authenticating with NO env token", async () => {
    // F1: the token is delivered via a file path passed as argv[2], NOT via
    // AOA_RUNTIME_HOOK_TOKEN (which a connector child would inherit). Prove the
    // forwarder reads the file and sends the right bearer even with the env var
    // absent — the exact scenario a connector run creates.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hook-forward-tokenfile-"));
    const tokenFilePath = path.join(dir, "aoa-runtime-hook-token");
    const TOKEN = "FILE-DELIVERED-TOKEN-abc123";
    await fs.promises.writeFile(tokenFilePath, TOKEN, "utf8");

    let seenAuth: string | undefined;
    const stub = await startStubServer((req, res) => {
      seenAuth = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "ok",
          },
        }),
      );
    });

    try {
      const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number }>(
        (resolve, reject) => {
          const env: NodeJS.ProcessEnv = { ...process.env, AOA_RUNTIME_HOOK_URL: stub.url };
          delete env.AOA_RUNTIME_HOOK_TOKEN; // the token must come from the file, not env
          const proc = spawn("node", [FORWARDER_PATH, tokenFilePath], { env });
          let stdout = "";
          proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          proc.on("error", reject);
          proc.on("close", (code: number | null) =>
            resolve({ stdout: stdout.trim(), exitCode: code ?? 0 }),
          );
          proc.stdin.write(SAMPLE_HOOK_PAYLOAD);
          proc.stdin.end();
        },
      );
      expect(exitCode).toBe(0);
      // The forwarder authenticated with the FILE token, not env.
      expect(seenAuth).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      await stub.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("emits deny and exits 0 when the stub refuses connection (unused port)", async () => {
    // Find an unused port by briefly listening then closing
    const unusedPort = await new Promise<number>((resolve) => {
      const tmp = http.createServer();
      tmp.listen(0, "127.0.0.1", () => {
        const port = (tmp.address() as { port: number }).port;
        tmp.close(() => resolve(port));
      });
    });

    const url = `http://127.0.0.1:${unusedPort}`;

    const { stdout, exitCode } = await runForwarder(url, "test-token", SAMPLE_HOOK_PAYLOAD);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual(DENY_DECISION);
  }, 15_000);
});
