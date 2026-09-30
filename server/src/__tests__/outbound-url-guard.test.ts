import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  buildPinnedRequestOptions,
  executePinnedRequest,
  isPrivateIP,
  PinnedRequestBodyCapError,
  validateAndResolveFetchUrl,
  type ValidatedFetchTarget,
} from "../services/outbound-url-guard.js";

describe("isPrivateIP", () => {
  it("rejects IPv4 RFC 1918 ranges", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.20.5.5")).toBe(true);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });
  it("rejects loopback", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });
  it("rejects link-local IPv4 (169.254/16)", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateIP("169.254.0.1")).toBe(true);
  });
  it("rejects 0.0.0.0", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });
  it.each([
    "0.1.2.3",
    "100.64.0.0",
    "100.127.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("rejects reserved IPv4 range address %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });
  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "192.0.1.1",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("does not over-block adjacent public IPv4 address %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(false);
  });
  it("rejects IPv6 loopback + ULA + link-local", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("::")).toBe(true);
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd00::1")).toBe(true);
    expect(isPrivateIP("fe80::1")).toBe(true);
  });
  it("rejects IPv4-mapped IPv6 (::ffff:127.0.0.1)", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIP("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIP("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateIP("::ffff:808:808")).toBe(false);
  });
  it.each([
    "ff02::1",
    "ffff::1",
    "2001:db8::1",
    "fe90::1",
    "febf::1",
    "fec0::1",
    "64:ff9b::7f00:1",
    "100::1",
    "2002:7f00:1::1",
    "3fff::1",
  ])(
    "rejects reserved IPv6 address %s",
    (ip) => {
      expect(isPrivateIP(ip)).toBe(true);
    },
  );
  it("does NOT reject 172.15.x.x or 172.32.x.x (boundary)", () => {
    expect(isPrivateIP("172.15.255.255")).toBe(false);
    expect(isPrivateIP("172.32.0.0")).toBe(false);
  });
  it("does NOT reject public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS IPv6
  });
});

describe("validateAndResolveFetchUrl — protocol gate", () => {
  it("rejects file://", async () => {
    await expect(validateAndResolveFetchUrl("file:///etc/passwd"))
      .rejects.toThrow(/Disallowed protocol/);
  });
  it("rejects gopher://", async () => {
    await expect(validateAndResolveFetchUrl("gopher://example.com/"))
      .rejects.toThrow(/Disallowed protocol/);
  });
  it("rejects javascript:", async () => {
    await expect(validateAndResolveFetchUrl("javascript:alert(1)"))
      .rejects.toThrow(/Disallowed protocol/);
  });
  it("rejects malformed URL", async () => {
    await expect(validateAndResolveFetchUrl("not-a-url"))
      .rejects.toThrow(/Invalid URL/);
  });
});

describe("validateAndResolveFetchUrl — private IP gate (literal IPs in hostname)", () => {
  it("rejects loopback", async () => {
    await expect(validateAndResolveFetchUrl("http://127.0.0.1/"))
      .rejects.toThrow(/private/);
  });
  it("rejects cloud metadata (169.254.169.254)", async () => {
    await expect(validateAndResolveFetchUrl("http://169.254.169.254/latest/meta-data/"))
      .rejects.toThrow(/private/);
  });
  it("rejects RFC 1918 (10.0.0.1)", async () => {
    await expect(validateAndResolveFetchUrl("http://10.0.0.1/"))
      .rejects.toThrow(/private/);
  });
  it("rejects IPv6 loopback ([::1])", async () => {
    await expect(validateAndResolveFetchUrl("http://[::1]/"))
      .rejects.toThrow(/private/);
  });
  it.each([
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://203.0.113.1/",
    "http://224.0.0.1/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[2002:7f00:1::1]/",
  ])("rejects reserved literal target %s", async (url) => {
    await expect(validateAndResolveFetchUrl(url)).rejects.toThrow(/private/);
  });
});

describe("executePinnedRequest", () => {
  it("connects to the pinned IP and returns status + body, forwarding the original Host header", async () => {
    // Spin up a tiny HTTP server on 127.0.0.1
    let seenHost: string | undefined;
    const server = createServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    // Construct ValidatedFetchTarget manually (bypasses validate-private-IP gate).
    // Pretend the URL was http://example.test/whatever and the resolved IP is 127.0.0.1.
    const target: ValidatedFetchTarget = {
      parsedUrl: new URL(`http://example.test:${port}/`),
      resolvedAddress: "127.0.0.1",
      hostHeader: `example.test:${port}`,
      tlsServername: undefined,
      useTls: false,
    };

    const controller = new AbortController();
    try {
      const res = await executePinnedRequest(target, { method: "GET" }, controller.signal);
      expect(res.status).toBe(200);
      expect(res.body).toBe("pinned-ok");
      // Wire-level proof of DNS-rebind defense: connect went to 127.0.0.1 (server's
      // listen address) but the Host header still carries the original hostname.
      expect(seenHost).toBe(`example.test:${port}`);
    } finally {
      server.close();
    }
  });

  it("respects maxBodyBytes cap by destroying the response when body exceeds limit", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("a".repeat(100)); // 100 bytes
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    const target: ValidatedFetchTarget = {
      parsedUrl: new URL(`http://example.test:${port}/`),
      resolvedAddress: "127.0.0.1",
      hostHeader: `example.test:${port}`,
      tlsServername: undefined,
      useTls: false,
    };

    const controller = new AbortController();
    try {
      const promise = executePinnedRequest(
        target,
        { method: "GET" },
        controller.signal,
        { maxBodyBytes: 10 },
      );
      await expect(promise).rejects.toThrow(/exceeded 10 bytes/);
      await expect(promise).rejects.toBeInstanceOf(PinnedRequestBodyCapError);
    } finally {
      server.close();
    }
  });

  it("throws PinnedRequestBodyCapError with capBytes on body-cap exceeded", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("z".repeat(500));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    const target: ValidatedFetchTarget = {
      parsedUrl: new URL(`http://example.test:${port}/`),
      resolvedAddress: "127.0.0.1",
      hostHeader: `example.test:${port}`,
      tlsServername: undefined,
      useTls: false,
    };

    const controller = new AbortController();
    try {
      let caught: unknown;
      try {
        await executePinnedRequest(
          target,
          { method: "GET" },
          controller.signal,
          { maxBodyBytes: 64 },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PinnedRequestBodyCapError);
      expect((caught as PinnedRequestBodyCapError).capBytes).toBe(64);
      expect((caught as PinnedRequestBodyCapError).name).toBe("PinnedRequestBodyCapError");
    } finally {
      server.close();
    }
  });

  it("does not forward URL-embedded credentials to the pinned request (no Authorization header, no auth field)", async () => {
    let seenAuthHeader: string | undefined;
    const server = createServer((req, res) => {
      seenAuthHeader = req.headers.authorization;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    // Validate a URL with embedded credentials.
    // `127.0.0.1` is private, so we have to spoof the resolved target by
    // building a fake target with creds in parsedUrl directly — that
    // exercises buildPinnedRequestOptions's belt-and-suspenders defense.
    const targetWithCreds: ValidatedFetchTarget = {
      parsedUrl: new URL(`http://user:pass@example.test:${port}/path`),
      resolvedAddress: "127.0.0.1",
      hostHeader: `example.test:${port}`,
      tlsServername: undefined,
      useTls: false,
    };

    const { options } = buildPinnedRequestOptions(targetWithCreds, { method: "GET" });
    // Belt-and-suspenders: even with creds in parsedUrl, options.auth must be undefined.
    expect(options.auth).toBeUndefined();

    const controller = new AbortController();
    try {
      const res = await executePinnedRequest(targetWithCreds, { method: "GET" }, controller.signal);
      expect(res.status).toBe(200);
      // No Authorization header should leak from URL-embedded credentials.
      expect(seenAuthHeader).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("validateAndResolveFetchUrl strips embedded credentials from parsedUrl", async () => {
    // Use a public-resolving DNS name so validate doesn't reject.
    // We're only checking that the returned parsedUrl has no creds.
    const target = await validateAndResolveFetchUrl("https://user:pass@example.com/path?q=1");
    expect(target.parsedUrl.username).toBe("");
    expect(target.parsedUrl.password).toBe("");
    // Other fields must remain intact.
    expect(target.parsedUrl.hostname).toBe("example.com");
    expect(target.parsedUrl.pathname).toBe("/path");
    expect(target.parsedUrl.search).toBe("?q=1");
    expect(target.hostHeader).toBe("example.com");
  });

  it("sends the request body when init.body is provided", async () => {
    let receivedBody = "";
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(201);
        res.end("created");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const port = address.port;

    const target: ValidatedFetchTarget = {
      parsedUrl: new URL(`http://example.test:${port}/`),
      resolvedAddress: "127.0.0.1",
      hostHeader: `example.test:${port}`,
      tlsServername: undefined,
      useTls: false,
    };

    const controller = new AbortController();
    try {
      const res = await executePinnedRequest(
        target,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        },
        controller.signal,
      );
      expect(res.status).toBe(201);
      expect(receivedBody).toBe('{"hello":"world"}');
    } finally {
      server.close();
    }
  });
});
