// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the durable, identity-namespaced idempotency ledger.
//
// A per-key file-backed store reusing the FileRecordStore write-once CAS IDIOM
// (temp -> fsync -> link() -> PARENT-DIR fsync) — reimplemented in adapter-manager
// (FileRecordStore is not barrel-exported) so it carries no worker-daemon internals
// beyond the exported custody symbols, and it MUST carry the parent-dir fsync (the
// WRK-014 lesson) or a "stored" entry is lost to power loss.
//
// The invariants proven here (all write to an OS TEMP dir, NEVER the repo tree):
//   - record -> lookup round-trips the recorded {sandboxId, resourceLabels};
//   - DURABILITY: a NEW ledger instance over the SAME dir replays the record (a
//     simulated restart) — the store is genuinely on disk, not in memory;
//   - WRITE-ONCE: a second record of the same key is "already_present" and the
//     FIRST value survives (never overwritten — the CAS);
//   - IDENTITY IS UNAMBIGUOUS, NOT `hashResourceLabels`: two label tuples differing
//     only by a SPACE shift get DISTINCT namespaces (the space-join collision B1
//     rejected must not reopen here — else tenant B replays tenant A's key);
//   - the PARENT-DIR fsync fires on a store (the durable-publish idiom is complete).
// -----------------------------------------------------------------------------

import * as realFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResourceLabels } from "@armyofagents/worker-daemon";

import { IdempotencyLedger, type LedgerFs } from "../idempotency-ledger.js";

const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

let dir: string;
beforeEach(() => {
  // An OS temp dir — NEVER the repo tree (guards / check-test-inventory hygiene, β1.7).
  dir = mkdtempSync(join(tmpdir(), "aoa-am-ledger-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("IdempotencyLedger — record + lookup round-trip", () => {
  it("a MISS on an unrecorded key, then a HIT after record", () => {
    const ledger = new IdempotencyLedger({ dir });
    const key = ledger.key(OWNED, "idem-1");
    expect(ledger.lookup(key)).toBeNull(); // never recorded
    const outcome = ledger.record(key, { sandboxId: "sbx-000001", resourceLabels: OWNED });
    expect(outcome).toBe("stored");
    expect(ledger.lookup(key)).toEqual({ sandboxId: "sbx-000001", resourceLabels: OWNED });
  });
});

describe("IdempotencyLedger — durability across a simulated restart", () => {
  it("a NEW ledger instance over the SAME dir replays the recorded value", () => {
    const first = new IdempotencyLedger({ dir });
    const key = first.key(OWNED, "idem-restart");
    first.record(key, { sandboxId: "sbx-000042", resourceLabels: OWNED });

    // Simulate a process restart: a fresh instance, same on-disk dir, no shared memory.
    const restarted = new IdempotencyLedger({ dir });
    const replayed = restarted.lookup(restarted.key(OWNED, "idem-restart"));
    expect(replayed).toEqual({ sandboxId: "sbx-000042", resourceLabels: OWNED });
  });
});

describe("IdempotencyLedger — write-once CAS", () => {
  it("a second record of the same key is already_present and the FIRST value survives", () => {
    const ledger = new IdempotencyLedger({ dir });
    const key = ledger.key(OWNED, "idem-cas");
    expect(ledger.record(key, { sandboxId: "sbx-winner", resourceLabels: OWNED })).toBe("stored");
    // A racing loser tries to write a DIFFERENT sandbox under the same key.
    expect(ledger.record(key, { sandboxId: "sbx-loser", resourceLabels: OWNED })).toBe("already_present");
    // The winner is immutable — the loser never overwrote it.
    expect(ledger.lookup(key)?.sandboxId).toBe("sbx-winner");
  });
});

describe("IdempotencyLedger — the identity encoding is UNAMBIGUOUS (not hashResourceLabels)", () => {
  // Two DISTINCT tuples that a `.join(" ")` canonical (hashResourceLabels) collides:
  // org:"a",target:"b c"  vs  org:"a b",target:"c" — the space straddles a field
  // boundary. Under the collision they would SHARE a ledger namespace and tenant B
  // would replay tenant A's idempotencyKey and receive A's sandbox.
  const A: ResourceLabels = { ...OWNED, organizationId: "a", targetId: "b c" };
  const B: ResourceLabels = { ...OWNED, organizationId: "a b", targetId: "c" };

  it("the space-shift tuples produce DISTINCT keys", () => {
    const ledger = new IdempotencyLedger({ dir });
    expect(ledger.key(A, "same-key")).not.toBe(ledger.key(B, "same-key"));
  });

  it("recording under A does NOT leak to a lookup under B (distinct namespaces, same idempotencyKey)", () => {
    const ledger = new IdempotencyLedger({ dir });
    ledger.record(ledger.key(A, "same-key"), { sandboxId: "sbx-A", resourceLabels: A });
    // B replays the SAME idempotencyKey — but a different identity, so it MISSES.
    expect(ledger.lookup(ledger.key(B, "same-key"))).toBeNull();
  });

  it("the idempotencyKey itself is part of the namespace (same identity, different key -> distinct)", () => {
    const ledger = new IdempotencyLedger({ dir });
    expect(ledger.key(OWNED, "k1")).not.toBe(ledger.key(OWNED, "k2"));
  });
});

describe("IdempotencyLedger — the durable-publish idiom (parent-dir fsync)", () => {
  it("a store fsyncs the PARENT DIR after the link() (crash-atomic publish)", () => {
    // A recording fs wrapping node:fs, so the crash-atomic SEQUENCE is observable
    // without a real power loss. The parent-dir fsync is the WRK-014 lesson: without
    // it a "stored" entry can be lost in the FS metadata-commit window.
    const calls: string[] = [];
    const real = realFs;
    let dirFd = -1;
    const spyFs: Partial<LedgerFs> = {
      openSync: (path: string, flags: string, mode: number) => {
        const fd = real.openSync(path, flags, mode);
        // A directory opened "r" is the parent-dir fsync handle.
        if (flags === "r") {
          dirFd = fd;
          calls.push(`openDir:${path === dir ? "PARENT" : path}`);
        } else {
          calls.push(`openTemp`);
        }
        return fd;
      },
      linkSync: (a: string, b: string) => {
        calls.push("link");
        real.linkSync(a, b);
      },
      fsyncSync: (fd: number) => {
        calls.push(fd === dirFd ? "fsyncParentDir" : "fsyncFile");
        real.fsyncSync(fd);
      },
    };
    const ledger = new IdempotencyLedger({ dir, fs: spyFs });
    ledger.record(ledger.key(OWNED, "idem-fsync"), { sandboxId: "sbx-fsync", resourceLabels: OWNED });

    // The file body is fsync'd, then link() publishes, then the PARENT DIR is fsync'd.
    expect(calls).toContain("fsyncFile");
    expect(calls).toContain("link");
    expect(calls).toContain("fsyncParentDir");
    // Ordering: the parent-dir fsync comes AFTER the link (it makes the new dirent durable).
    expect(calls.indexOf("fsyncParentDir")).toBeGreaterThan(calls.indexOf("link"));
  });
});
