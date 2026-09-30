# Distributed Execution — Golden Journey and Failure Corpus (v1)

These fixtures are the **behavioral contract** for the AoA cloud re-platform's
distributed execution layer. They are consumed by later epics: E1 compatibility
tests, PRT-004 (which byte-for-byte reproduces the `eventDigest` contract), E6's
fake provider, E7 coding, E8 browser, and E9 service plans.

Each fixture is one deterministic golden journey (a nominal or failure scenario)
for one of the three approved workloads (`batch`, `browser_session`, `service`).

## Files

- `schema-v1.json` — the strict JSON Schema (draft 2020-12) that every fixture
  conforms to. It is a closed contract: every object schema sets
  `additionalProperties: false`, arrays are bounded, identities are pattern- and
  uniqueness-constrained, and the `task_run` source discriminant is enforced.
  Semantic UTF-8 byte limits are expressed only through the standard
  `$comment` convention `aoa:utf8-max-bytes=<positive integer>`. E1 compiles
  these exact bytes in Ajv 2020-12 strict mode with no custom keywords.
- Nine fixtures:
  - `batch-success.json` — coding job stages a base snapshot and returns a patch.
  - `batch-cancel-during-execution.json` — cancellation kills the process tree
    and fences output.
  - `browser-approval-download.json` — browser session pauses for approval and
    commits bounded evidence.
  - `browser-denied-egress.json` — metadata / private-network access fails closed.
  - `service-restart-checkpoint.json` — a failed instance is replaced from an
    approved checkpoint.
  - `service-budget-stop.json` — control-plane budget exhaustion stops a service.
  - `service-provider-pause-resume.json` — a provider pause moves a service to a
    replacement instance with no overlapping fences and no old-instance resume.
  - `late-output-quarantine.json` — a fenced attempt's late output is quarantined
    to an orphan receipt for review; the old attempt cannot complete or mutate.
  - `plaintext-secret-in-argv-rejected.json` — registered secret canaries in
    argv, URL, header, nested array, and additive extension are all rejected by
    producer-safety validation before any persistence, placement, lease, or
    provider invocation.

## The immutable-event `eventDigest` contract

Each `expectedEvents[]` entry carries exactly 14 fields: `protocolVersion`,
`eventId`, `eventType`, `organizationId`, `companyId`, `workerId`, `jobId`,
`attempt`, `leaseId`, `fenceToken`, `seq`, `occurredAt`, `payload`, and
`eventDigest`. The digest is the lowercase hex SHA-256 over the **UTF-8 canonical
bytes** (RFC 8785 JSON Canonicalization Scheme, restricted to the v1 subset:
null, booleans, strings, arrays, plain objects, and finite safe integers) of the
same object **with `eventDigest` omitted**. Object keys sort by UTF-16 code
units. Floats, unsafe integers, lone surrogates, and duplicate keys are rejected.
`scripts/check-distributed-execution-foundation.mjs` recomputes every digest and
rejects any mismatch; PRT-004 reproduces the identical algorithm.

## Rules for changing these fixtures

- **Fixtures are immutable behavioral inputs.** Treat them as frozen golden
  vectors. Do not edit an existing fixture's scenario semantics or event
  sequence in place — downstream epics assert against these exact bytes.
- **They contain no credentials or secrets.** The only secret-shaped strings are
  the registered non-functional canaries in `plaintext-secret-in-argv-rejected`
  (each `CANARY-…` token appears exactly once, in its own declaration, and never
  in an artifact, event, or payload). Never add a real secret to any fixture.
- **IDs and actions are deterministic.** Organizations, companies, jobs,
  workers, leases, event ids, timestamps, and audit actions are stable and
  reproducible — no wall-clock, random, or environment-dependent values.
- **Only additive changes are allowed within `schemaVersion: 1`.** New optional
  fields may be added to `schema-v1.json` and to fixtures without a version bump.
  Any breaking change (removing or repurposing a field, changing an event
  sequence or a computed digest, tightening an existing constraint) requires a
  **new versioned directory** and a new `schemaVersion`, leaving v1 intact.
