import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  assertHostPortAvailable,
  assertOnlyLoopbackPortBindings,
  createSmokeProjectName,
  dockerComposeUpArgs,
} from "./docker-local-trial-smoke.mjs";

test("builds the image by default and supports explicit no-build reruns", () => {
  assert.deepEqual(dockerComposeUpArgs(), ["up", "--build", "--detach"]);
  assert.deepEqual(dockerComposeUpArgs(false), ["up", "--detach"]);
});

test("creates unique, valid Compose project names", () => {
  const first = createSmokeProjectName(1234, "Run A");
  const second = createSmokeProjectName(1234, "Run A");

  assert.match(first, /^[a-z0-9][a-z0-9_-]*$/);
  assert.match(second, /^[a-z0-9][a-z0-9_-]*$/);
  assert.notEqual(first, second);
});

test("accepts only complete IPv4 loopback port bindings", () => {
  assert.doesNotThrow(() =>
    assertOnlyLoopbackPortBindings({
      "3101/tcp": [{ HostIp: "127.0.0.1", HostPort: "3100" }],
    }),
  );
});

test("allows internal-only exposed ports while validating published loopback ports", () => {
  assert.doesNotThrow(() =>
    assertOnlyLoopbackPortBindings({
      "3100/tcp": null,
      "3101/tcp": [{ HostIp: "127.0.0.1", HostPort: "3100" }],
    }),
  );
});

test("rejects wildcard, IPv6, absent, empty, and malformed port bindings", () => {
  for (const bindings of [
    { "3101/tcp": [{ HostIp: "0.0.0.0", HostPort: "3100" }] },
    { "3101/tcp": [{ HostIp: "::", HostPort: "3100" }] },
    { "3101/tcp": [{ HostIp: "::1", HostPort: "3100" }] },
    undefined,
    {},
    { "3101/tcp": [] },
    { "3101/tcp": null },
    { "3101/tcp": [{ HostIp: "127.0.0.1" }] },
  ]) {
    assert.throws(() => assertOnlyLoopbackPortBindings(bindings), /loopback|binding|invalid|exclusively/i);
  }
});

test("accepts a free loopback host port", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  await assertHostPortAvailable(port);
});

test("rejects an occupied loopback host port with a useful message", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(assertHostPortAvailable(address.port), /already in use|occupied/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects invalid host port numbers", async () => {
  await assert.rejects(assertHostPortAvailable(0), /valid TCP port/i);
  await assert.rejects(assertHostPortAvailable(65536), /valid TCP port/i);
});
