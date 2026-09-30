// BRW-002 — clauses (a) and (b) against a REAL Chromium.
//
// Clause (c) is NOT here. An earlier header claimed this file covered it while no teardown
// test existed at all — adversarial review caught the false claim. Clause (c) lives in
// browser-teardown.browser.test.ts.
//
// These are the tests that make the ticket falsifiable. Plan review established there was no
// environment in which any BRW-002 clause could fail, which is the failure class this
// programme keeps hitting; the `browser` CI lane exists to run exactly this file.
//
// GATED BY `AOA_RUN_BROWSER_TESTS=1`, not by a platform check, because a browser is a real
// prerequisite rather than an OS property. The CI lane sets it. A test that never runs
// anywhere proves nothing, so if you are reading this because the lane was removed, the
// clauses below are unproven.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureSite, type FixtureSite } from "../fixture-site.js";
import { createPlaywrightDriver } from "../playwright-driver.js";
import { runBrowserSession } from "../run-session.js";
import { readListeningPorts } from "../listening-ports.js";
import { resolveUnderRoot, safeDownloadName } from "../path-adapter.js";

const RUN = process.env.AOA_RUN_BROWSER_TESTS === "1";
const suite = describe.skipIf(!RUN);
/** The socket measurement needs /proc, so it is Linux-only even inside the browser lane. */
const linuxOnly = describe.skipIf(!RUN || process.platform !== "linux");

let site: FixtureSite;
let workdir: string;

beforeAll(async () => {
  if (!RUN) return;
  site = await startFixtureSite();
  workdir = mkdtempSync(join(tmpdir(), "brw002-browser-"));
});
afterAll(async () => {
  if (!RUN) return;
  await site?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function dirs(name: string) {
  const base = mkdtempSync(join(workdir, `${name}-`));
  const profile = join(base, "profile");
  const staging = join(base, "staging");
  const root = join(base, "root");
  for (const d of [profile, staging, root]) {
    rmSync(d, { recursive: true, force: true });
  }
  require("node:fs").mkdirSync(root, { recursive: true });
  return { base, profile, staging, root };
}

const driverFor = (d: ReturnType<typeof dirs>, videoDir?: string) =>
  createPlaywrightDriver({ userDataDir: d.profile, downloadsStagingPath: d.staging, videoDir });

const SAFE_LAUNCH = { headless: true, chromiumSandbox: true, args: [] as string[] };

suite("BRW-002 (a) — a real browser opens no reachable endpoint", () => {
  it("launches with Chromium's OS sandbox ENABLED", async () => {
    // If this fails in the sandbox/CI environment, that is a FINDING to escalate, not a flag
    // to quietly drop: every containment argument assumes the renderer stays contained.
    const d = dirs("sandbox-on");
    const result = await runBrowserSession(
      { downloadRoot: d.root, steps: [{ action: "navigate", url: `${site.origin}/` }], launch: SAFE_LAUNCH },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("refuses to launch when a debugging port is requested", async () => {
    const d = dirs("refuse-port");
    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: `${site.origin}/` }],
        launch: { ...SAFE_LAUNCH, cdpPort: 9222 },
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cdp_port_requested");
  });
});

linuxOnly("BRW-002 (a) — measured: the browser adds no listening socket", () => {
  it("opens no TCP port that was not already there", async () => {
    // THE clause-(a) proof. The fixture site's port is in the baseline, so it is not counted
    // against the browser — which is why the guard is a delta.
    const d = dirs("socket-delta");
    const measure = () => readListeningPorts((p) => readFile(p, "utf8"));

    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: `${site.origin}/` }],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: measure,
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("would FAIL if the browser did open a port (negative control)", async () => {
    // Without this, the test above could pass because the measurement is broken rather than
    // because the browser is contained.
    const d = dirs("socket-negative");
    let call = 0;
    const result = await runBrowserSession(
      { downloadRoot: d.root, steps: [], launch: SAFE_LAUNCH },
      {
        driver: driverFor(d),
        measurePorts: async () => (call++ === 0 ? [] : [9222]),
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("port_opened");
  });
});

suite("BRW-002 (b) — a real download stays in the job root", () => {
  it("persists a download under the root and it SURVIVES context close", async () => {
    // The durability half: `downloadsPath` is a staging area Playwright deletes on close, so
    // a test that only checked `download.path()` would pass while the artifact was doomed.
    const d = dirs("download-ok");
    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: `${site.origin}/download` }],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.savedDownloads.length).toBe(1);
    const saved = result.savedDownloads[0]!;
    expect(saved.startsWith(d.root)).toBe(true);
    // Asserted AFTER the session closed the context.
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, "utf8")).toContain("col_a");
  });

  it("a traversal filename cannot escape the root", async () => {
    const d = dirs("download-traversal");
    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: `${site.origin}/download-traversal` }],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    // Either the name was sanitised into the root, or it was refused. What must NEVER happen
    // is a file appearing outside the root.
    const outside = join(d.base, "escape.txt");
    expect(existsSync(outside)).toBe(false);
    if (result.ok) {
      for (const saved of result.savedDownloads) expect(saved.startsWith(d.root)).toBe(true);
    }
  });

  it("leaves nothing behind in the staging directory after close", async () => {
    const d = dirs("staging-empty");
    await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: `${site.origin}/download` }],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    // Playwright removes the staging area on close; asserting it documents WHY saveAs is
    // mandatory rather than optional.
    expect(existsSync(d.staging) ? readdirSync(d.staging) : []).toEqual([]);
  });
});

suite("BRW-002 — the deterministic journey", () => {
  it("navigates, downloads, and handles a popup", async () => {
    const d = dirs("journey");
    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [
          { action: "navigate", url: `${site.origin}/` },
          { action: "navigate", url: `${site.origin}/second` },
          { action: "navigate", url: `${site.origin}/popup` },
          { action: "navigate", url: `${site.origin}/download` },
          { action: "navigate", url: `${site.origin}/slow` },
        ],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.savedDownloads.length).toBe(1);
  });

  it("reports a failed navigation instead of pretending to succeed", async () => {
    const d = dirs("journey-fail");
    const result = await runBrowserSession(
      {
        downloadRoot: d.root,
        steps: [{ action: "navigate", url: "http://127.0.0.1:1/nothing-listens-here" }],
        launch: SAFE_LAUNCH,
      },
      {
        driver: driverFor(d),
        measurePorts: async () => [],
        resolvePath: (root, name) => resolveUnderRoot(root, safeDownloadName(name) ?? ""),
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("step_failed");
  });
});
