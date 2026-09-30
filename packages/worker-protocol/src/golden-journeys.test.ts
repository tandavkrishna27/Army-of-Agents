import { readFileSync, readdirSync } from "node:fs";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS } from "./capabilities.js";
import { TERMINAL_EVENT_STATUSES } from "./events.js";
import { EXECUTION_SOURCE_KINDS } from "./source.js";
import {
  BROWSER_SESSION_STATUSES,
  SERVICE_INSTANCE_STATUSES,
  workloadTypeSchema,
} from "./states.js";

// ESM/CJS interop: ajv's 2020 entry + ajv-formats ship a default export that
// nests under `.default` in some resolvers.
const Ajv2020 = (_Ajv2020 as { default?: unknown }).default ?? _Ajv2020;
const addFormats = (_addFormats as { default?: unknown }).default ?? _addFormats;

const AjvCtor = Ajv2020 as unknown as new (options?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
};
const applyFormats = addFormats as unknown as (ajv: unknown) => void;

// Resolve from the repo root — the same pattern events.test.ts uses.
const fixturesDir = new URL("../../../tests/fixtures/distributed-execution/", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("schema-v1.json", fixturesDir), "utf8"));

// Ajv 2020-12 strict mode, minus the opinionated `strictRequired` sub-check: the
// frozen E0 schema uses the idiomatic `allOf/if-then/required` pattern (properties
// live on the parent `Source`, required is asserted in the `then` branch) which is
// valid JSON Schema but which `strictRequired` flags. The fixtures are immutable E0
// authority (E1-D002), so the test conforms to them.
const ajv = new AjvCtor({ allErrors: true, strict: true, strictRequired: false });
applyFormats(ajv);
const validate = ajv.compile(schema);

interface GoldenSource {
  kind: string;
  runId?: string;
  issueId?: string;
}
interface GoldenStep {
  action: string;
  emits?: string[];
}
interface GoldenFixture {
  schemaVersion: number;
  id: string;
  workloadType: string;
  source: GoldenSource;
  steps: GoldenStep[];
  expected: { terminalState: string; forbiddenEffects: string[]; auditActions: string[] };
}

const fixtureFiles = readdirSync(fixturesDir).filter((name) => name.endsWith(".json") && name !== "schema-v1.json");
const fixtures = fixtureFiles.map((file) => ({
  file,
  id: file.replace(/\.json$/, ""),
  data: JSON.parse(readFileSync(new URL(file, fixturesDir), "utf8")) as GoldenFixture,
}));

const formatErrors = () => JSON.stringify((validate as { errors?: unknown }).errors, null, 2);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TERMINAL_STATE_SET: Record<string, ReadonlySet<string>> = {
  batch: new Set(TERMINAL_EVENT_STATUSES),
  browser_session: new Set(BROWSER_SESSION_STATUSES),
  service: new Set(SERVICE_INSTANCE_STATUSES),
};

describe("E0 golden journeys — schema-v1.json validates all 9 frozen fixtures", () => {
  it("finds exactly the 9 frozen fixtures", () => {
    expect(fixtures.length).toBe(9);
  });

  for (const { file, data } of fixtures) {
    it(`validates ${file} against the compiled schema`, () => {
      const ok = validate(data);
      expect(ok, ok ? "" : `Ajv errors for ${file}:\n${formatErrors()}`).toBe(true);
    });
  }
});

describe("E0 golden journeys — the compiled schema is not permissive (invalid-mutation table)", () => {
  const base = fixtures.find((f) => f.file === "batch-success.json")!.data;

  const mutations: Array<[string, (doc: Record<string, unknown>) => void]> = [
    ["missing tenant", (doc) => delete doc.organization],
    ["missing owner/requester", (doc) => delete doc.requester],
    ["bad organization UUID", (doc) => ((doc.organization as Record<string, unknown>).id = "org_not-a-ulid!!")],
    ["bad timestamp", (doc) => ((doc.timing as Record<string, unknown>).startedAt = "2026-13-99T99:99:99Z")],
    ["bad event digest", (doc) => ((doc.expectedEvents as Array<Record<string, unknown>>)[0].eventDigest = "nothex")],
    ["duplicate event identity", (doc) => {
      const events = doc.expectedEvents as unknown[];
      (doc.expectedEvents as unknown[]) = [events[0], clone(events[0])];
    }],
    ["dangling event identity (missing eventId)", (doc) => delete (doc.expectedEvents as Array<Record<string, unknown>>)[0].eventId],
    ["cross-tenant / oversized artifact prefix", (doc) => {
      (doc.expectedEvents as Array<Record<string, unknown>>)[0].payload = { prefix: "x".repeat(201) };
    }],
    ["cost overflow", (doc) => ((doc.cost as Record<string, unknown>).maxTotalCents = 100_000_001)],
    ["absent cleanup", (doc) => delete doc.cleanup],
    ["absent forbiddenEffects", (doc) => delete (doc.expected as Record<string, unknown>).forbiddenEffects],
  ];

  for (const [label, mutate] of mutations) {
    it(`rejects: ${label}`, () => {
      const doc = clone(base) as unknown as Record<string, unknown>;
      mutate(doc);
      expect(validate(doc)).toBe(false);
    });
  }
});

describe("E0 golden journeys — vocabulary/enum-membership parity (E1-D002)", () => {
  for (const { file, id, data } of fixtures) {
    it(`${file} agrees with the E1 wire vocabularies`, () => {
      // schemaVersion + filename identity.
      expect(data.schemaVersion).toBe(1);
      expect(data.id).toBe(id);

      // workloadType parses through the E1 enum schema.
      expect(workloadTypeSchema.safeParse(data.workloadType).success).toBe(true);

      // source.kind is a MEMBER of the ExecutionSourceV1 discriminant set — NOT a
      // full-object parse (the fixture source is ULID-encoded {kind, runId?, issueId?}
      // and deliberately does not round-trip through executionSourceV1Schema).
      expect((EXECUTION_SOURCE_KINDS as readonly string[]).includes(data.source.kind)).toBe(true);

      // Every emits value is a MEMBER of the known distributed-execution emission
      // vocabulary = worker-event union ∪ the 4 frozen operation/receipt names.
      for (const step of data.steps) {
        for (const emission of step.emits ?? []) {
          expect(
            KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS.has(emission),
            `${file}: emission ${emission} is outside the known vocabulary`,
          ).toBe(true);
        }
      }

      // Expected terminal state belongs to the relevant batch/browser/service set.
      const terminalSet = TERMINAL_STATE_SET[data.workloadType];
      expect(terminalSet, `no terminal set for workloadType ${data.workloadType}`).toBeDefined();
      expect(terminalSet.has(data.expected.terminalState)).toBe(true);

      // Forbidden effects + audit actions are non-empty.
      expect(data.expected.forbiddenEffects.length).toBeGreaterThan(0);
      expect(data.expected.auditActions.length).toBeGreaterThan(0);
    });
  }

  it("the emission vocabulary is actually exercised (non-trivial across fixtures)", () => {
    const allEmissions = new Set<string>();
    for (const { data } of fixtures) {
      for (const step of data.steps) for (const emission of step.emits ?? []) allEmissions.add(emission);
    }
    expect(allEmissions.size).toBeGreaterThan(5);
    // Every one of the 4 frozen non-event operation/receipt names appears.
    for (const op of ["artifact_transfer_rejected", "quarantine_grant_issued", "quarantine_receipt_finalized", "replacement_lease_activated"]) {
      expect(allEmissions.has(op)).toBe(true);
    }
  });
});
