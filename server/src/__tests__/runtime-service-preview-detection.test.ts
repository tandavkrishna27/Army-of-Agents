import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  buildPreviewDetectionText,
  containsExplicitPreviewUrlMarker,
  createLivePreviewDetectionScheduler,
  detectPreviewRuntimeServiceReports,
  extractLoopbackPreviewUrls,
  shouldDetectAoaAppPreviews,
} from "../services/runtime-service-preview-detection.ts";

async function withHttpServer(body: string, fn: (url: string) => Promise<void>) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to listen on a TCP port");
  }

  try {
    await fn(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("extractLoopbackPreviewUrls", () => {
  it("extracts unique marked loopback preview URLs and ignores non-loopback URLs", () => {
    const urls = extractLoopbackPreviewUrls(
      [
        "AOA_PREVIEW_URL=http://localhost:5173/",
        "AOA_PREVIEW_URL: http://127.0.0.1:3000/dashboard",
        "aoaPreviewUrl=http://[::1]:4173/",
        "Duplicate AOA_PREVIEW_URL=http://localhost:5173/",
        "Ignore external AOA_PREVIEW_URL=https://example.com/app",
        "Ignore LAN AOA_PREVIEW_URL=http://10.0.0.5:8080",
      ].join("\n"),
      { excludedOrigins: [] },
    );

    expect(urls).toEqual([
      "http://localhost:5173/",
      "http://127.0.0.1:3000/dashboard",
      "http://[::1]:4173/",
    ]);
  });

  it("ignores bare reachable-looking localhost URLs to avoid false positives", () => {
    const urls = extractLoopbackPreviewUrls(
      [
        "The existing AoA app is at http://127.0.0.1:3100/",
        "A docs server might be running at http://localhost:3000/",
        "The app preview marker is not present.",
      ].join("\n"),
      { excludedOrigins: [] },
    );

    expect(urls).toEqual([]);
  });

  it("ignores excluded local origins such as AoA itself", () => {
    const urls = extractLoopbackPreviewUrls(
      "AOA_PREVIEW_URL=http://localhost:3100\nAOA_PREVIEW_URL=http://localhost:5173",
      { excludedOrigins: ["http://localhost:3100"] },
    );

    expect(urls).toEqual(["http://localhost:5173/"]);
  });

  it("stops URLs before escaped JSON line breaks in adapter stdout", () => {
    const urls = extractLoopbackPreviewUrls(
      String.raw`AOA_PREVIEW_URL=http://127.0.0.1:50593/\r\nPID=24208\nSTATUS=200`,
      { excludedOrigins: [] },
    );

    expect(urls).toEqual(["http://127.0.0.1:50593/"]);
  });
});

describe("buildPreviewDetectionText", () => {
  it("includes final adapter stdout because Codex may not stream JSON output through run logs", () => {
    const text = buildPreviewDetectionText({
      streamedText: "run started",
      adapterResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          stdout:
            '{"type":"item.completed","item":{"type":"agent_message","text":"AOA_PREVIEW_URL=http://127.0.0.1:8123/"}}',
          stderr: "",
        },
      },
    });

    expect(text).toContain("run started");
    expect(text).toContain("http://127.0.0.1:8123/");
  });
});

describe("detectPreviewRuntimeServiceReports", () => {
  it("builds preview-only runtime service reports for reachable marked loopback URLs", async () => {
    await withHttpServer("ok", async (url) => {
      const reports = await detectPreviewRuntimeServiceReports({
        text: `AOA_PREVIEW_URL=${url}`,
        cwd: "/tmp/workspace",
        excludedOrigins: [],
        timeoutMs: 500,
      });

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        serviceName: expect.stringMatching(/^localhost:\d+$/),
        status: "running",
        lifecycle: "ephemeral",
        scopeType: "execution_workspace",
        command: null,
        cwd: "/tmp/workspace",
        url,
        providerRef: null,
        healthStatus: "healthy",
      });
      expect(reports[0]?.port).toBeGreaterThan(0);
    });
  });

  it("does not report unreachable loopback URLs", async () => {
    const reports = await detectPreviewRuntimeServiceReports({
      text: "AOA_PREVIEW_URL=http://127.0.0.1:9/",
      cwd: "/tmp/workspace",
      excludedOrigins: [],
      timeoutMs: 100,
    });

    expect(reports).toEqual([]);
  });

  it("does not report reachable bare loopback URLs without an explicit preview marker", async () => {
    await withHttpServer("not a preview", async (url) => {
      const reports = await detectPreviewRuntimeServiceReports({
        text: `Mentioning another local app ${url} should not attach it.`,
        cwd: "/tmp/workspace",
        excludedOrigins: [],
        timeoutMs: 500,
      });

      expect(reports).toEqual([]);
    });
  });
});

describe("live preview stream detection", () => {
  it("detects explicit preview markers in streamed chunks before adapter completion", async () => {
    const calls: Array<{ text: string; source: "stream" | "final" }> = [];
    const scheduler = createLivePreviewDetectionScheduler({
      onDetect: async (text, source) => {
        calls.push({ text, source });
      },
    });

    scheduler.observeChunk("starting server\n");
    await scheduler.flush();
    expect(calls).toEqual([]);

    scheduler.observeChunk("AOA_PREVIEW_URL=http://127.0.0.1:61234/\n");
    await scheduler.flush();

    expect(calls).toEqual([
      {
        text: expect.stringContaining("AOA_PREVIEW_URL=http://127.0.0.1:61234/"),
        source: "stream",
      },
    ]);
  });

  it("does not schedule live detection for ordinary localhost mentions", async () => {
    const calls: Array<{ text: string; source: "stream" | "final" }> = [];
    const scheduler = createLivePreviewDetectionScheduler({
      onDetect: async (text, source) => {
        calls.push({ text, source });
      },
    });

    scheduler.observeChunk("AoA is running at http://127.0.0.1:3100/\n");
    await scheduler.flush();

    expect(calls).toEqual([]);
  });

  it("chains live detection work without blocking log callers", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const scheduler = createLivePreviewDetectionScheduler({
      minDetectionIntervalMs: 0,
      onDetect: async (text) => {
        calls.push(text);
        if (calls.length === 1) await first;
      },
    });

    scheduler.observeChunk("AOA_PREVIEW_URL=http://127.0.0.1:61235/\n");
    scheduler.observeChunk("AOA_PREVIEW_URL=http://127.0.0.1:61236/\n");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    releaseFirst();
    await scheduler.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("61236");
  });

  it("throttles repeated probes while an explicit marker remains in the rolling buffer", async () => {
    const calls: string[] = [];
    const scheduler = createLivePreviewDetectionScheduler({
      minDetectionIntervalMs: 60_000,
      onDetect: async (text) => {
        calls.push(text);
      },
    });

    scheduler.observeChunk("AOA_PREVIEW_URL=http://127.0.0.1:61237/\n");
    await scheduler.flush();
    scheduler.observeChunk("ordinary follow-up log line\n");
    scheduler.observeChunk("another ordinary follow-up log line\n");
    await scheduler.flush();

    expect(calls).toHaveLength(1);
  });

  it("recognizes both supported explicit marker spellings", () => {
    expect(containsExplicitPreviewUrlMarker("AOA_PREVIEW_URL=http://127.0.0.1:5000/")).toBe(true);
    expect(containsExplicitPreviewUrlMarker("aoaPreviewUrl=http://127.0.0.1:5000/")).toBe(true);
    expect(containsExplicitPreviewUrlMarker("http://127.0.0.1:5000/")).toBe(false);
  });
});

describe("shouldDetectAoaAppPreviews", () => {
  it("defaults to enabled", () => {
    expect(shouldDetectAoaAppPreviews({})).toBe(true);
    expect(shouldDetectAoaAppPreviews({ aoaAppPreviews: true })).toBe(true);
  });

  it("is disabled only by explicit false", () => {
    expect(shouldDetectAoaAppPreviews({ aoaAppPreviews: false })).toBe(false);
  });
});
