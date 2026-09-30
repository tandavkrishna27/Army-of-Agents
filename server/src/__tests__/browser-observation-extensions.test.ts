import { describe, it, expect } from "vitest";
import {
  foldAttemptEvidence,
  PROJECTED_WIRE_EXTENSIONS_KEY,
  type AttemptEventRow,
} from "../services/canary-terminal-projection.js";
import { redactRunEventPayload } from "../redaction.js";

// BRW-003d-3 — stream metadata.
//
// ★ WHAT IS DELIBERATELY NOT ASSERTED HERE. Two statements about this clause are
// already TRUE with zero production change, and testing them would be vacuity:
//   1. "a browser_observation event lands in job_events" — it is a frozen variant,
//      permitted by the live CHECK, and the ingest stores the whole wire event;
//   2. "browser metadata is ordered by sequence and reaches CanaryAttemptEvent" —
//      foldAttemptEvidence already sorts by sequence and emits payload unfiltered.
// The clause is the EXTENSION channel, which is dead at both ends.

const row = (over: Partial<AttemptEventRow> & { event: Record<string, unknown> }): AttemptEventRow => ({
  eventId: over.eventId ?? "e1",
  sequence: over.sequence ?? 1,
  eventType: over.eventType ?? "browser_observation",
  occurredAt: over.occurredAt ?? new Date("2026-01-01T00:00:00Z"),
  event: over.event,
});

const fold = (rows: readonly AttemptEventRow[]) =>
  foldAttemptEvidence({
    jobId: "job-1",
    attemptId: "attempt-1",
    terminalStatus: "succeeded",
    rows,
    runStartedAt: new Date("2026-01-01T00:00:00Z"),
    now: new Date("2026-01-01T00:01:00Z"),
  });

const OBSERVATION = {
  eventType: "browser_observation",
  payload: { artifactIds: [], url: "https://ex.com/p", title: "P" },
} as const;

describe("BRW-003d-3 — the extension channel survives the projection", () => {
  it("carries extension values through foldAttemptEvidence", () => {
    // The frozen browser_observation payload is `.strict()` with exactly three
    // fields — artifactIds, url, title. Console lines and network summaries have
    // nowhere else to go, so if extensions are dropped here the clause is dead.
    const evidence = fold([
      row({
        event: {
          ...OBSERVATION,
          extensions: [
            { namespace: "aoa.dev/browser", schemaVersion: 1, critical: false, value: { console: ["hello"] } },
          ],
        },
      }),
    ]);
    expect(JSON.stringify(evidence.events)).toContain("hello");
  });

  it("keeps an extension attached to ITS OWN event's sequence position", () => {
    const evidence = fold([
      row({ eventId: "b", sequence: 2, event: { ...OBSERVATION, extensions: [{ namespace: "aoa.dev/browser", schemaVersion: 1, critical: false, value: { mark: "second" } }] } }),
      row({ eventId: "a", sequence: 1, event: { ...OBSERVATION, extensions: [{ namespace: "aoa.dev/browser", schemaVersion: 1, critical: false, value: { mark: "first" } }] } }),
    ]);
    const marks = evidence.events.map((e) => JSON.stringify(e.payload));
    expect(marks[0]).toContain("first");
    expect(marks[1]).toContain("second");
  });

  it("adds nothing when there are no extensions", () => {
    // A carrier that invents an empty artefact on every event makes every payload
    // noisier for no information.
    const evidence = fold([row({ event: { ...OBSERVATION, extensions: [] } })]);
    // ★ Assert the ACTUAL key, via the exported constant. This first read
    // `not.toContain("extensions")` — which can never fail, because the key is
    // `wireExtensions` and lowercase "extensions" is not a substring of it. A
    // surviving mutant is what exposed it: the test was checking a string the
    // code never emits.
    expect(JSON.stringify(evidence.events)).not.toContain(PROJECTED_WIRE_EXTENSIONS_KEY);
  });

  it("tolerates a malformed extensions field without losing the event", () => {
    // The stored event is whatever was persisted; a projection that throws on a
    // surprising shape costs the whole attempt's evidence.
    const evidence = fold([row({ event: { ...OBSERVATION, extensions: "not-an-array" } })]);
    expect(evidence.events).toHaveLength(1);
  });
  it("does not clobber a payload field that already owns the key", () => {
    // The projection is not the place to resolve a collision with a frozen payload
    // field, and overwriting would lose real data in order to carry metadata.
    const evidence = fold([
      row({
        event: {
          eventType: "browser_observation",
          payload: { artifactIds: [], url: null, title: null, wireExtensions: "mine" },
          extensions: [{ namespace: "aoa.dev/browser", schemaVersion: 1, critical: false, value: { m: "theirs" } }],
        },
      }),
    ]);
    expect(JSON.stringify(evidence.events)).toContain("mine");
    expect(JSON.stringify(evidence.events)).not.toContain("theirs");
  });
});

describe("BRW-003d-3 ★ the credential channel the keys-only scan permits", () => {
  it("does not let a credential in an extension VALUE reach the wire", () => {
    // THE INTERACTION THIS SLICE EXISTS TO CLOSE.
    // The frozen forbidden-key scan is KEYS-ONLY, so a secret sitting in an
    // extension VALUE under an innocuous key is legal on the wire. 003d-2's
    // redactor sweeps `event.payload` — so extensions must ride INSIDE the
    // payload, or they bypass it entirely.
    const evidence = fold([
      row({
        event: {
          ...OBSERVATION,
          extensions: [
            {
              namespace: "aoa.dev/browser",
              schemaVersion: 1,
              critical: false,
              value: {
                // A BENIGN marker rides alongside the secret on purpose: without
                // it this test passes vacuously, because dropping extensions
                // entirely also removes the secret. The assertion below therefore
                // requires the channel to be CARRIED and the secret REMOVED.
                marker: "kept-me",
                note: "sk-ant-abcdefghijklmnop123456",
                link: "https://ex.com/cb?access_token=leakme",
              },
            },
          ],
        },
      }),
    ]);

    // Egress is where the mask lives; assert the composition, not the intent.
    const onTheWire = JSON.stringify(
      evidence.events.map((e) => redactRunEventPayload(e.payload ?? null)),
    );
    expect(onTheWire, "the extension channel must be CARRIED").toContain("kept-me");
    expect(onTheWire).not.toContain("sk-ant-");
    expect(onTheWire).not.toContain("leakme");
  });
});
