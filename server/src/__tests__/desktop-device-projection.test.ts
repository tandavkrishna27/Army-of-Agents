// DSK-001 Lane D / I16 + I18 — the device listing is a redacted ALLOWLIST projection.
//
// Two properties, and neither is sufficient alone:
//
//   EXHAUSTIVENESS (I16) is asserted against the TABLE, not the response. The weak
//   version — "these seven keys are present" — passes forever while the schema grows
//   underneath it. Enumerating the drizzle columns and requiring every one to be
//   CLASSIFIED means a new column fails the build until someone decides about it. That
//   is what "a future column defaults hidden" actually requires.
//
//   NON-VACUITY (I16) is the canary half: distinctive bytes in every omitted column,
//   absent from the serialized response. The canary catches a leak through a field
//   nobody listed; the exhaustiveness catches a column nobody thought about.
//
// And I18: every emitted name must be safe under BOTH redactors, which genuinely
// disagree — the wire's is an EXACT match on a normalized key, the daemon logger's is
// substring containment.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { executionTargets, workers } from "@armyofagents/db";
import { FORBIDDEN_WIRE_KEYS, normalizeWireKey } from "@armyofagents/worker-protocol";

import {
  DESKTOP_DEVICE_PROJECTION_KEYS,
  DELIBERATELY_OMITTED_COLUMNS,
  projectDesktopDevice,
  desktopDeviceLeakKeys,
} from "../services/desktop-device-projection.js";
import { listDesktopDevices } from "../services/execution-targets.js";

/** Distinctive, greppable bytes — one per omitted column. */
const CANARY = "CANARY-a6f3d1-";

const row = {
  // emitted
  deviceId: "11111111-1111-4111-8111-111111111111",
  targetSlug: "my-laptop",
  label: "TK's laptop",
  status: "enrolled",
  deviceGeneration: 3,
  enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-08-21T00:00:00.000Z"),
  // E11 M2 — computed liveness verdict, injected by listDesktopDevices before projection.
  health: "stale" as const,
  // every one of these must never reach the response
  ownerUserId: `${CANARY}owner`,
  executionTargetId: `${CANARY}targetid`,
  targetAuthorityKey: `${CANARY}authority`,
  workerTokenHash: `${CANARY}tokenhash`,
  devicePublicKey: `${CANARY}pubkey`,
  deviceThumbprint: `${CANARY}thumb`,
  organizationId: `${CANARY}org`,
  config: { leaked: `${CANARY}config` },
  capabilities: { leaked: `${CANARY}caps` },
  profileSnapshot: { leaked: `${CANARY}profile` },
  registeredProfile: { leaked: `${CANARY}registered` },
  providerConstraintProfile: { leaked: `${CANARY}constraint` },
};

describe("DSK-001/I16 — the projection emits the allowlist and nothing else", () => {
  it("emits EXACTLY the allowlisted keys", () => {
    expect(Object.keys(projectDesktopDevice(row as never)).sort())
      .toEqual([...DESKTOP_DEVICE_PROJECTION_KEYS].sort());
  });

  it("leaks no canary byte anywhere in the serialized response", () => {
    // Serialized, not key-inspected: a nested object smuggling a value through an
    // allowlisted key would pass a key check and fail this.
    expect(JSON.stringify(projectDesktopDevice(row as never))).not.toContain(CANARY);
  });

  it("reports a widened runtime object, even when the static type is clean", () => {
    // `Object.keys` sees the real key set. This mirrors projectionLeakKeys' reason for
    // existing: a caller that spreads an extra field past the type is still caught.
    const widened = { ...projectDesktopDevice(row as never), ownerUserId: `${CANARY}oops` };
    expect(desktopDeviceLeakKeys(widened as never)).toEqual(["ownerUserId"]);
  });

  it("reports nothing for a correct projection — the leak check is not always-on", () => {
    expect(desktopDeviceLeakKeys(projectDesktopDevice(row as never))).toEqual([]);
  });

  it("does NOT emit the join key F31 had to drop from WORKER_SUMMARY_COLUMNS", () => {
    // Named separately because it is the one omission a future reader is most likely to
    // undo — it looks harmless and it is the obvious thing to want in a listing.
    expect(DESKTOP_DEVICE_PROJECTION_KEYS).not.toContain("executionTargetId");
    expect(DESKTOP_DEVICE_PROJECTION_KEYS).not.toContain("ownerUserId");
  });
});

describe("DSK-001/I16 — a FUTURE column defaults hidden", () => {
  // The half that keeps this true tomorrow. Enumerating the response would prove
  // nothing about a column added next month; enumerating the TABLE forces a decision.
  const columnNames = (table: Record<string, unknown>) =>
    Object.keys(table).filter((key) => {
      const column = (table as Record<string, { name?: unknown }>)[key];
      return typeof column === "object" && column !== null && typeof column.name === "string";
    });

  it("classifies every workers column as emitted or deliberately omitted", () => {
    const unclassified = columnNames(workers as never).filter(
      (name) => !DESKTOP_DEVICE_PROJECTION_KEYS.includes(name as never)
        && !DELIBERATELY_OMITTED_COLUMNS.includes(name as never),
    );
    expect(unclassified, "new workers column(s) must be classified before shipping").toEqual([]);
  });

  it("classifies every execution_targets column as emitted or deliberately omitted", () => {
    const unclassified = columnNames(executionTargets as never).filter(
      (name) => !DESKTOP_DEVICE_PROJECTION_KEYS.includes(name as never)
        && !DELIBERATELY_OMITTED_COLUMNS.includes(name as never),
    );
    expect(unclassified, "new execution_targets column(s) must be classified").toEqual([]);
  });

  it("proves the column scan is non-vacuous", () => {
    // A scan that found no columns would make both assertions above trivially true.
    expect(columnNames(workers as never).length).toBeGreaterThan(10);
    expect(columnNames(executionTargets as never).length).toBeGreaterThan(10);
  });

  it("keeps the omission list honest — nothing is listed as omitted AND emitted", () => {
    for (const key of DESKTOP_DEVICE_PROJECTION_KEYS) {
      expect(DELIBERATELY_OMITTED_COLUMNS, `${key} is on both lists`).not.toContain(key as never);
    }
  });
});

describe("DSK-001/I18 — every emitted name is safe under BOTH redactors", () => {
  // The two guards genuinely disagree, and using the REAL ones is the whole point:
  //   - the wire's FORBIDDEN_WIRE_KEYS is an EXACT match on a normalized key
  //   - the daemon logger's SENSITIVE_SUBSTRINGS is SUBSTRING containment
  // so `credentialHandleId` passes the wire and is `[redacted]` in logs.
  //
  // The wire guard is imported directly — `@armyofagents/worker-protocol` is a server
  // dependency. The DAEMON is deliberately NOT: it is a separately deployable leaf, and
  // adding it to server/package.json to reach one array would be an architectural
  // regression for a test's convenience. So its list is READ FROM SOURCE and its exact
  // normalization reproduced, which is a cross-package pin rather than a copy — the same
  // shape used for the rejection-reason mirror in Lane B. A copied word list would drift
  // from the guard it claims to satisfy; this one fails the moment the source changes.

  const DAEMON_LOGGER = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "packages", "worker-daemon", "src", "logging", "logger.ts",
  );

  function sensitiveSubstrings(): string[] {
    const source = readFileSync(DAEMON_LOGGER, "utf8");
    const block = /const SENSITIVE_SUBSTRINGS = \[([\s\S]*?)\];/.exec(source);
    expect(block, "SENSITIVE_SUBSTRINGS not found — the daemon logger changed shape").not.toBeNull();
    return [...block![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
  }

  /** The daemon logger's own normalization (`logger.ts` isSensitiveKey). */
  const normalizeLogKey = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

  it("passes the frozen wire-safety normalizer", () => {
    for (const key of DESKTOP_DEVICE_PROJECTION_KEYS) {
      expect(FORBIDDEN_WIRE_KEYS.has(normalizeWireKey(key)), `wire-forbidden: ${key}`).toBe(false);
    }
  });

  it("passes the daemon logger's substring redactor", () => {
    const needles = sensitiveSubstrings();
    expect(needles.length, "the source scan found nothing").toBeGreaterThan(5);
    for (const key of DESKTOP_DEVICE_PROJECTION_KEYS) {
      const normalized = normalizeLogKey(key);
      for (const needle of needles) {
        expect(normalized.includes(needle), `${key} would be [redacted] in daemon logs`).toBe(false);
      }
    }
  });

  it("proves both checks are non-vacuous, using the name that splits them", () => {
    // Without this, a scan that matched nothing would make both assertions above pass.
    // `credentialHandleId` is the documented disagreement: redacted in logs, fine on the
    // wire. If either guard ever stops distinguishing it, this fails.
    const needles = sensitiveSubstrings();
    expect(needles).toContain("credential");
    expect(normalizeLogKey("credentialHandleId")).toContain("credential");
    expect(FORBIDDEN_WIRE_KEYS.has(normalizeWireKey("credentialHandleId"))).toBe(false);
    // …and a name the WIRE rejects outright, so that guard is exercised too.
    expect(FORBIDDEN_WIRE_KEYS.has(normalizeWireKey("access_token"))).toBe(true);
  });
});

describe("DSK-001 Lane D — the listing query is scoped and routed through the projection", () => {
  // The projection above is the security artifact; this is the wiring that must actually
  // use it. Mutation exposed that the query had no test at all: returning raw rows, or
  // dropping the desktop filter, changed nothing observable.

  function fakeDb(rows: unknown[]) {
    const calls: { selected?: unknown; joined: boolean } = { joined: false };
    const db = {
      select: (selected: unknown) => {
        calls.selected = selected;
        return {
          from: () => ({
            innerJoin: () => {
              calls.joined = true;
              return { where: async () => rows };
            },
          }),
        };
      },
    };
    return { db, calls };
  }

  it("returns nothing for a null organization, without touching the database", async () => {
    // Same rule as listExecutionTargets: a null org must not even scan.
    let touched = false;
    const db = { select: () => { touched = true; throw new Error("must not query"); } };
    expect(await listDesktopDevices(db as never, null)).toEqual([]);
    expect(touched).toBe(false);
  });

  it("routes every row through the projection, so a widened SELECT cannot leak", async () => {
    // The select list is an implementation detail a future edit can widen. Routing
    // through projectDesktopDevice is what makes that safe — and this is the assertion
    // that would fail if someone returned `rows` directly.
    const { db } = fakeDb([{ ...row, extraColumnSomebodyAdded: `${CANARY}widened` }]);
    const out = await listDesktopDevices(db as never, "org-1");
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]!).sort()).toEqual([...DESKTOP_DEVICE_PROJECTION_KEYS].sort());
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("builds the query from the org's own TARGETS outward, joining workers", async () => {
    // F31: a worker-first query has no safe way back to the owning org, because the
    // redacted WorkerSummary had to drop executionTargetId. Targets-first is why D17
    // calls this construction safe.
    const { db, calls } = fakeDb([]);
    await listDesktopDevices(db as never, "org-1");
    expect(calls.joined).toBe(true);
  });

  it("filters on organization AND kind='desktop' — asserted against the source", () => {
    // The where-clause is a drizzle SQL object; asserting on its internals would pin
    // drizzle rather than the property. Reading the source is the honest check that both
    // predicates are present, and it fails if either is removed.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "services", "execution-targets.ts"),
      "utf8",
    );
    const body = source.slice(source.indexOf("export async function listDesktopDevices"));
    const fn = body.slice(0, body.indexOf("\nexport "));
    expect(fn).toContain("eq(executionTargets.organizationId, organizationId)");
    expect(fn).toContain('eq(executionTargets.kind, "desktop")');
  });
});
