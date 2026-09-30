/**
 * DSK-003 — the host opens its own log file.
 *
 * THE GAP THIS CLOSES. Task Scheduler has no native redirection, so on Windows — the only
 * platform the device vault supports — a background host's output went nowhere and `logs`
 * had nothing to read. The alternative was wrapping the launch in `cmd /c "... >> file"`,
 * which puts a SHELL on the launch path of the process that holds the device identity and
 * introduces cmd quoting as a second escaping grammar beside the XML one. Writing the file
 * from inside the process needs no shell at all.
 *
 * `createWorkerLogger` already accepted a `destination`, so this is a file option rather
 * than a redesign — and pino stays inside the daemon, whose manifest already carries it.
 *
 * THE FILE IS OWNER-ONLY. The logger redacts sensitive keys, but a log readable by every
 * local user still discloses which jobs ran and when, on a machine where the whole
 * control model is "can this caller read that file".
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkerLogger } from "../logging/logger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "aoa-log-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** pino writes asynchronously; flush and let the fd settle before reading. */
async function settle(logger: { flush?: () => void }): Promise<void> {
  logger.flush?.();
  await new Promise((r) => setTimeout(r, 50));
}

describe("DSK-003 — a file destination captures the host's output", () => {
  it("writes log lines to the named file", async () => {
    const file = path.join(dir, "host.v1.log");
    const logger = createWorkerLogger({ filePath: file });
    logger.info({ marker: "CAPTURED-abc123" }, "hello");
    await settle(logger as never);
    expect(readFileSync(file, "utf8")).toContain("CAPTURED-abc123");
  });

  it("creates the parent directory when it does not exist", async () => {
    // The vault directory may not exist on a first run, and a logger that threw there
    // would take the whole host down before it could report why.
    const file = path.join(dir, "nested", "deeper", "host.v1.log");
    const logger = createWorkerLogger({ filePath: file });
    logger.info({ marker: "NESTED-xyz" }, "hello");
    await settle(logger as never);
    expect(readFileSync(file, "utf8")).toContain("NESTED-xyz");
  });

  it("appends across two loggers rather than truncating", async () => {
    // A restart must not erase the log that explains why the last run stopped.
    const file = path.join(dir, "host.v1.log");
    const first = createWorkerLogger({ filePath: file });
    first.info({ marker: "FIRST-run" }, "a");
    await settle(first as never);
    const second = createWorkerLogger({ filePath: file });
    second.info({ marker: "SECOND-run" }, "b");
    await settle(second as never);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("FIRST-run");
    expect(body).toContain("SECOND-run");
  });

  it("writes the file owner-only", async () => {
    if (process.platform === "win32") return; // chmod cannot express this here
    const file = path.join(dir, "host.v1.log");
    const logger = createWorkerLogger({ filePath: file });
    logger.info({ marker: "PERM" }, "x");
    await settle(logger as never);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("still redacts sensitive bindings when writing to a file", async () => {
    // The destination changes where lines go, never what they contain.
    const file = path.join(dir, "host.v1.log");
    const logger = createWorkerLogger({ filePath: file });
    logger.info({ apiKey: "LEAKED-SECRET-VALUE", jobId: "j-1" }, "run");
    await settle(logger as never);
    const body = readFileSync(file, "utf8");
    expect(body).not.toContain("LEAKED-SECRET-VALUE");
    expect(body).toContain("j-1"); // non-vacuity: the line WAS written
  });
});

describe("DSK-003 — an explicit destination always wins", () => {
  it("writes to the injected stream and NOT to the file when both are given", async () => {
    // The source pin for this was too weak — it matched a mutant that had reordered the
    // ternary, because the string `opts.destination ??` survived the reorder. Only a
    // behavioural test distinguishes them: every existing suite injects a destination,
    // and if filePath ever outranked it those suites would silently start writing to
    // disk instead of to the stream they assert on.
    const file = path.join(dir, "must-not-exist.log");
    const written: string[] = [];
    const logger = createWorkerLogger({
      filePath: file,
      destination: { write: (chunk: string) => { written.push(chunk); } } as never,
    });
    logger.info({ marker: "TO-STREAM" }, "x");
    await settle(logger as never);
    expect(written.join("")).toContain("TO-STREAM");
    expect(() => statSync(file)).toThrow();
  });
});

describe("DSK-003 — the default is unchanged", () => {
  it("writes nothing to a file when no filePath is given", async () => {
    // Every container bootstraps without one and must keep logging to stdout.
    const logger = createWorkerLogger({});
    logger.info({ marker: "STDOUT-only" }, "x");
    await settle(logger as never);
    expect(() => statSync(path.join(dir, "host.v1.log"))).toThrow();
  });
});

describe("DSK-003 — the file destination's options, pinned cross-platform", () => {
  // The permission assertion above returns early on win32, so on Windows it proves
  // nothing and a mutant relaxing the mode would survive for a PLATFORM reason rather
  // than a coverage one. Reading the source is the honest pin — the same technique used
  // for the custody delegation and the timing-safe comparison.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "logging", "logger.ts"),
    "utf8",
  );

  it("opens the file 0600", () => {
    expect(source).toContain("mode: 0o600");
  });

  it("appends rather than truncating", () => {
    expect(source).toContain("append: true");
  });

  it("creates the parent directory", () => {
    expect(source).toContain("mkdir: true");
  });

  it("lets an explicit destination win over filePath", () => {
    // Tests inject a stream; that must keep working regardless of filePath.
    expect(source).toMatch(/opts\.destination \?\?/);
  });
});
