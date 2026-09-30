// -----------------------------------------------------------------------------
// SVC-005a — the generation rollout fence's PURE half.
//
// Two things are proved here and neither needs a database:
//
//   (1) THE WITNESS CLASSIFICATION. Which terminal authors mean "the worker said it stopped"
//       and which mean "the control plane gave up on it" — the distinction the cross-generation
//       placement fence turns on, and therefore the distinction on which E9's SVC-005
//       acceptance clause is enforced or not enforced.
//   (2) THE THREE-WAY RECONCILIATION of the author list, which lives in THREE places for the
//       usual reason: `packages/db` does not depend on `worker-protocol` and the database CHECK
//       cannot import anything at all. A value present in one copy and absent from another is
//       either an author nothing can store or a value the fence has never classified — and the
//       second is the dangerous one, because an unclassified author read as a witness would
//       admit exactly the placement this fence exists to refuse.
//
// ★ THE FAIL-CLOSED DIRECTION IS ASSERTED, NOT ASSUMED. `WITNESSED_...` is a SUBSET derived by
// naming, so a FIFTH author added to the frozen list (there are four) without being named a
// witness makes the fence STALL rather than pass. T-P4 pins that by construction rather than by
// inspection.
//
// ★★★ AND THE FOURTH AUTHOR EXISTS BECAUSE OF A P1. External review of PR #415 found that a
// single `worker_event` author was a fail-open: `service_instance_lost` is a fenced, authentic,
// attributed worker event that asserts the stop COULD NOT BE CONFIRMED — in the worst case that
// the process survived cancel and kill. `worker_stopped` / `worker_unconfirmed` is that fix, and
// T-P1 is where it is pinned.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SERVICE_INSTANCE_TERMINAL_AUTHORS,
  WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS,
} from "@armyofagents/db";
import {
  ROLLABLE_DESIRED_STATES,
  findBlockingPredecessor,
  isWitnessedTerminalAuthor,
  type GenerationPredecessor,
} from "../services/service-generation-rollout.js";
import { SERVICE_DESIRED_STATES } from "@armyofagents/worker-protocol";

function predecessor(overrides: Partial<GenerationPredecessor>): GenerationPredecessor {
  return {
    serviceInstanceId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    status: "lost",
    terminalizedBy: "liveness_deadline",
    attemptStatus: "running",
    ...overrides,
  };
}

describe("SVC-005a — who counts as a witness that the old generation stopped", () => {
  // ── T-P1 — the one author that IS a witness ────────────────────────────────────────────
  //
  // ★★★ `worker_unconfirmed` IS THE P1 EXTERNAL REVIEW OF PR #415 FOUND, and it is asserted
  // here rather than only in the integration suite. The first revision had ONE `worker_event`
  // author covering every terminal move the ingest applied — but the daemon emits
  // `service_instance_lost` when `inspect` could not describe the sandbox OR when "a full stop
  // ladder ended with the process still observed `running`", so a fenced, authentic, attributed
  // event can be the worker saying THE PROCESS SURVIVED CANCEL AND KILL. Reading that as a
  // witness would place generation N+1 exactly when generation N is KNOWN to be alive.
  //
  // MUTANT: add `"worker_unconfirmed"` back into the witness list (i.e. revert to the single
  // `worker_event`). This case reds. MUTANT: add `"control_plane_backstop"` — tempting because
  // its precondition (a terminal attempt) really does close the fence, but a closed fence stops
  // the old worker WRITING, not its PROCESS (E9-F007 §3). This case reds for that too.
  it("★★★ T-P1 — only an OBSERVED STOP is a witness; an unconfirmed worker event is not", () => {
    expect(isWitnessedTerminalAuthor("worker_stopped")).toBe(true);
    expect(isWitnessedTerminalAuthor("worker_unconfirmed")).toBe(false);
    expect(isWitnessedTerminalAuthor("liveness_deadline")).toBe(false);
    expect(isWitnessedTerminalAuthor("control_plane_backstop")).toBe(false);
  });

  // ── T-P2 — ★★★ NULL IS NOT A WITNESS, and this is the whole-fence fail-open ────────────
  //
  // A terminal row with a NULL author is one terminalized BEFORE migration 0279 — the control
  // plane has no idea who ended it. Reading that as a witness would admit a cross-generation
  // placement on no evidence at all, on every row that predates the column.
  //
  // MUTANT: `return author === null || WITNESSED.includes(author)` — i.e. treat unknown as
  // benign. This case reds; T-P1 stays green under it, which is why it is a separate case.
  it("★★★ T-P2 — an UNKNOWN author (NULL) is not a witness", () => {
    expect(isWitnessedTerminalAuthor(null)).toBe(false);
  });

  // ── T-P3 — the fence returns the row that blocked it ──────────────────────────────────
  it("★ T-P3 — an unwitnessed predecessor blocks, and is NAMED", () => {
    const blocked = predecessor({ serviceInstanceId: "22222222-2222-4222-8222-222222222222" });
    const found = findBlockingPredecessor([blocked]);
    expect(found).not.toBeNull();
    expect(found?.serviceInstanceId).toBe("22222222-2222-4222-8222-222222222222");
    expect(found?.terminalizedBy).toBe("liveness_deadline");
  });

  it("★ T-P3b — a witnessed predecessor does NOT block", () => {
    expect(findBlockingPredecessor([predecessor({ terminalizedBy: "worker_stopped" })])).toBeNull();
  });

  // The first UNWITNESSED row wins, not the first row. A scan that returned `candidates[0]`
  // unconditionally would report a witnessed row as the blocker, which is a wrong diagnosis on
  // a real stall.
  it("★ T-P3c — a witnessed row ahead of an unwitnessed one does not mask it", () => {
    const found = findBlockingPredecessor([
      predecessor({ terminalizedBy: "worker_stopped", serviceInstanceId: "aaaaaaaa-0000-4000-8000-000000000001" }),
      predecessor({ terminalizedBy: null, serviceInstanceId: "aaaaaaaa-0000-4000-8000-000000000002" }),
    ]);
    expect(found?.serviceInstanceId).toBe("aaaaaaaa-0000-4000-8000-000000000002");
  });

  it("T-P3d — no candidates is a pass", () => {
    expect(findBlockingPredecessor([])).toBeNull();
  });

  // ── T-P4 — ★★★ AN UNCLASSIFIED AUTHOR STALLS ─────────────────────────────────────────
  //
  // The property, stated over the frozen list rather than over hand-written names: every author
  // that is NOT explicitly named a witness must classify as one, so adding a FIFTH author to
  // `SERVICE_INSTANCE_TERMINAL_AUTHORS` without naming it a witness makes the fence refuse
  // rather than admit. Written as a loop over the SHIPPED list so it kept holding when the
  // fourth author (`worker_unconfirmed`) arrived — which it did, and this case needed no edit.
  it("★★★ T-P4 — every author not named a witness classifies as NOT a witness", () => {
    const witnesses = new Set<string>(WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS);
    for (const author of SERVICE_INSTANCE_TERMINAL_AUTHORS) {
      expect(isWitnessedTerminalAuthor(author), `author ${author}`).toBe(witnesses.has(author));
    }
    // And the subset relation itself: a "witness" that is not a storable author would be a
    // classification for a value the database refuses, i.e. dead.
    for (const witness of WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS) {
      expect(
        (SERVICE_INSTANCE_TERMINAL_AUTHORS as readonly string[]).includes(witness),
        `witness ${witness} is not a member of the frozen author list`,
      ).toBe(true);
    }
  });
});

// ── T-P5 / T-P5c — the OTHER TWO copies of the author list ───────────────────────────────
//
// `SERVICE_INSTANCE_TERMINAL_AUTHORS` (TypeScript), the Drizzle schema's `check(...)` literal
// and the emitted migration DDL are three copies of one list, for the reason
// `service_instances_status_check` already has three: `packages/db` does not depend on
// `worker-protocol`, and SQL imports nothing. SVC-001 answered this by asserting the
// reconciliation server-side; so does this.
//
// ★★★ AND IT IS THREE-WAY BECAUSE EXTERNAL REVIEW OF PR #415 CAUGHT IT NOT BEING SO. This
// block shipped with T-P5 alone — the constant against the MIGRATION — while three records
// (this comment, the Drizzle schema's own comment, and the migration header) each described a
// reconciliation of "the CHECK". Nothing in the tree read the Drizzle `check()` literal, so
// the schema copy's claim of enforcement was FALSE, which is worse than a missing check: a
// reader who saw the sentence had no reason to add the assertion. T-P5c is that assertion.
//
// WHAT EACH ONE ACTUALLY COVERS, so neither is over-read:
//   T-P5  — the constant vs the APPLIED DDL. This is the copy the database enforces; a
//           divergence here is a 23514 at write time from inside a transaction that had
//           already done work.
//   T-P5c — the constant vs the DRIZZLE LITERAL, read as source text. Migration 0279 is
//           immutable once applied, so this copy is what `db:generate` would emit into the
//           NEXT migration touching this table: a divergence here does not break today's
//           deployment, it silently plants the wrong list in tomorrow's DDL. It is a
//           source-text assertion and it proves nothing about any deployed constraint —
//           that is T-P5's half.
//
// SET EQUALITY, not containment, in BOTH directions — an EXTRA value in the CHECK is a value
// the fence has never classified, and an extra value in TypeScript is one the database will
// refuse at write time.
describe("SVC-005a — the author list agrees with the DDL that stores it", () => {
  const MIGRATION = fileURLToPath(
    new URL("../../../packages/db/src/migrations/0279_service_instance_terminalized_by.sql", import.meta.url),
  );
  const SCHEMA = fileURLToPath(
    new URL("../../../packages/db/src/schema/service_instances.ts", import.meta.url),
  );

  // The IN-list of the `terminalized_by` CHECK, wherever it is spelled. `terminalized_by IN (`
  // occurs exactly once in each of the two files — the sibling `status` CHECK is anchored on a
  // different column name, and the column's prose docstring names the authors without ever
  // spelling this SQL fragment.
  function authorsFrom(path: string, label: string): string[] {
    const text = readFileSync(path, "utf8");
    const match = /terminalized_by IN \(([^)]*)\)/.exec(text);
    expect(match, `the CHECK's IN-list was not found in ${label} — was it renamed or reworded?`)
      .not.toBeNull();
    return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }

  it("★★★ T-P5 — migration 0279's CHECK admits EXACTLY the frozen author list", () => {
    expect(authorsFrom(MIGRATION, "0279").sort())
      .toEqual([...SERVICE_INSTANCE_TERMINAL_AUTHORS].sort());
  });

  // The NULL arm is the fail-closed half of the CHECK and is easy to lose in an edit: without
  // it the column would be effectively NOT NULL and every pre-0279 row would fail the
  // constraint, which would make the migration itself unappliable on a deployment with history.
  it("★ T-P5b — the CHECK admits NULL", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("terminalized_by IS NULL OR");
    expect(readFileSync(SCHEMA, "utf8")).toContain("terminalized_by IS NULL OR");
  });

  it("★★★ T-P5c — the DRIZZLE schema literal admits EXACTLY the frozen author list", () => {
    expect(authorsFrom(SCHEMA, "packages/db/src/schema/service_instances.ts").sort())
      .toEqual([...SERVICE_INSTANCE_TERMINAL_AUTHORS].sort());
  });

  // ★ AND THE TWO DDL COPIES AGREE WITH EACH OTHER. Implied by the two assertions above, and
  // asserted anyway because it is the failure a reader of either one alone would miss: it is
  // the only case that names both files in its diff.
  it("★ T-P5d — the Drizzle literal and the applied migration are the same list", () => {
    expect(authorsFrom(SCHEMA, "schema").sort()).toEqual(authorsFrom(MIGRATION, "0279").sort());
  });
});

// ── T-P6 — the rollable desired states ──────────────────────────────────────────────────
describe("SVC-005a — which desired states may be rolled", () => {
  it("★ T-P6 — `deleted` is the only exclusion, and every entry is a frozen state", () => {
    expect([...ROLLABLE_DESIRED_STATES].sort()).toEqual(["paused", "running", "stopped"]);
    expect(ROLLABLE_DESIRED_STATES).not.toContain("deleted");
    for (const state of ROLLABLE_DESIRED_STATES) {
      expect((SERVICE_DESIRED_STATES as readonly string[]).includes(state), state).toBe(true);
    }
  });
});
