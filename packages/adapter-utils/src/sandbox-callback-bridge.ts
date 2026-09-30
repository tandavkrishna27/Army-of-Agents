import http, { type IncomingHttpHeaders } from "node:http";
import { URL } from "node:url";

const MAX_BRIDGE_BODY_BYTES = 2 * 1024 * 1024;

const ALLOWED_BRIDGE_REQUESTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/health$/],
  ["GET", /^\/api\/agents\/me$/],
  ["GET", /^\/api\/approvals\/[^/]+$/],
  ["GET", /^\/api\/approvals\/[^/]+\/issues$/],
  ["GET", /^\/api\/companies\/[^/]+\/issues$/],
  ["POST", /^\/api\/companies\/[^/]+\/issues$/],
  ["GET", /^\/api\/issues\/[^/]+$/],
  ["GET", /^\/api\/issues\/[^/]+\/comments$/],
  ["POST", /^\/api\/issues\/[^/]+\/comments$/],
  ["POST", /^\/api\/issues\/[^/]+\/checkout$/],
  ["PATCH", /^\/api\/issues\/[^/]+$/],
];

export function isAllowedAoaBridgeRequest(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (!pathname.startsWith("/api/")) return false;
  return ALLOWED_BRIDGE_REQUESTS.some(
    ([allowedMethod, pattern]) => allowedMethod === normalizedMethod && pattern.test(pathname),
  );
}

export interface SandboxCallbackBridgeServer {
  listenUrl: string;
  containerUrl: string;
  close: () => Promise<void>;
}

export async function startSandboxCallbackBridgeServer(input: {
  apiBaseUrl: string;
  authToken: string;
  runId: string;
  exposeToDocker?: boolean;
}): Promise<SandboxCallbackBridgeServer> {
  const bindHost = input.exposeToDocker ? "0.0.0.0" : "127.0.0.1";
  const apiBaseUrl = input.apiBaseUrl;
  const server = http.createServer((req, res) => {
    void handleBridgeRequest(req, res, {
      apiBaseUrl,
      authToken: input.authToken,
      runId: input.runId,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Sandbox callback bridge failed to bind to a TCP port");
  }

  return {
    listenUrl: `http://${bindHost}:${address.port}`,
    containerUrl: input.exposeToDocker
      ? `http://host.docker.internal:${address.port}`
      : `http://${bindHost}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleBridgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  input: { apiBaseUrl: string; authToken: string; runId: string },
): Promise<void> {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", "http://sandbox-bridge.local");
  if (!hasExpectedBearerAuth(req.headers, input.authToken)) {
    sendBridgeText(res, 401, "Missing or invalid bearer authorization");
    return;
  }
  if (!isAllowedAoaBridgeRequest(method, requestUrl.pathname)) {
    sendBridgeText(res, 403, "Disallowed callback path");
    return;
  }

  let body: Buffer;
  try {
    body = await readBridgeBody(req);
  } catch (err) {
    const code = err instanceof BridgeBodyTooLargeError ? 413 : 500;
    sendBridgeText(res, code, err instanceof Error ? err.message : "Failed to read request body");
    return;
  }

  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, input.apiBaseUrl);
  const headers = buildForwardHeaders(req.headers, input.authToken, input.runId);
  const requestBody =
    method === "GET" || method === "HEAD"
      ? undefined
      : bufferToArrayBuffer(body);
  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers,
      body: requestBody,
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding") res.setHeader(key, value);
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    res.end(responseBody);
  } catch (err) {
    sendBridgeText(
      res,
      502,
      `Sandbox callback bridge upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

function hasExpectedBearerAuth(headers: IncomingHttpHeaders, expectedToken: string): boolean {
  const value = headers.authorization;
  if (typeof value !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] === expectedToken;
}

function buildForwardHeaders(
  incoming: IncomingHttpHeaders,
  authToken: string,
  runId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.authorization = `Bearer ${authToken}`;
  headers["x-aoa-run-id"] = runId;
  return headers;
}

class BridgeBodyTooLargeError extends Error {}

async function readBridgeBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BRIDGE_BODY_BYTES) {
      throw new BridgeBodyTooLargeError("Callback bridge request body exceeds 2 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendBridgeText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

export function generateSandboxBridgeEntrypointInstallScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'target_file="${1:?target file required}"',
    'expected_sha256="${2:?sha256 required}"',
    'tmp_file="${target_file}.tmp.$$"',
    'lock_dir="${target_file}.lock"',
    "cleanup() {",
    '  rm -f "$tmp_file"',
    '  rmdir "$lock_dir" 2>/dev/null || true',
    "}",
    "trap cleanup EXIT INT TERM",
    'while ! mkdir "$lock_dir"; do',
    "  sleep 1",
    "done",
    'cat > "$tmp_file"',
    'actual_sha256="$(sha256sum "$tmp_file" | awk \'{print $1}\')"',
    'if [ "$actual_sha256" != "$expected_sha256" ]; then',
    '  echo "sha256 mismatch" >&2',
    "  exit 1",
    "fi",
    'mv "$tmp_file" "$target_file"',
    'chmod +x "$target_file"',
    "",
  ].join("\n");
}
