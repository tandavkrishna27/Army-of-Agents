# BRW-003d-2 — Redaction — DESIGN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Discharges:** BRW-003 acceptance "redaction is explicit".
**Sequencing:** must land **before** 003d-3 (metadata) — see §5.

---

## §1 ★ The probe that changed the ticket

The design assumed 003d-2 would *add* redaction. It does not: a live server-side event-payload
redactor already exists — `redactEventPayload` → `sanitizeRecord` (`server/src/redaction.ts`), with
~13 non-test call sites. The earlier survey missed it; the adversarial reviewer found it.

So the real question is what that redactor **fails** to catch. Measured by running it against the
real function rather than reading it:

| Input | Result |
|---|---|
| `{ apiThing: "sk-ant-…" }` | ✅ redacted |
| `{ cfg: { thing: "sk-ant-…" } }` | ✅ redacted |
| `{ list: [{ thing: "sk-ant-…" }] }` | ✅ redacted |
| **`{ args: ["--token", "sk-ant-…"] }`** | ☠ **LEAKS VERBATIM** |
| `{ url: "https://ex.com/cb?access_token=abc123" }` | ☠ leaks |
| `{ href: "https://ex.com/p#id_token=zzz" }` | ☠ leaks |
| `{ location: "https://user:hunter2@ex.com/p" }` | ☠ leaks |

## §2 ★ FIX A — a live security defect, wider than this ticket

**A secret in an ARRAY ELEMENT is not redacted at all.**

`sanitizeValue` recurses into arrays and plain objects, but a **string** falls through
`if (!isPlainObject(value)) return value;` untouched. Only `sanitizeRecord` tests string values, and
only for values it reaches *as a record entry*. An array element is never a record entry, so it skips
**both** the key-name check and the value-pattern check.

The same secret one level differently nested — inside an object — is correctly redacted. That
asymmetry is the whole defect.

**Why it matters here rather than "some day":** `args` arrays are exactly what `process` and
`claude_local` adapter configs carry, and `redactEventPayload` is what serves
`agent.adapterConfig` / `runtimeConfig` (`agents.ts:552-553`) and run-event payloads
(`agents.ts:2192`, `GET /heartbeat-runs/:runId/events`). A token passed as a CLI argument is
displayed verbatim to anyone who can read the agent.

**Fix:** value-check strings inside `sanitizeValue`, so array elements get the same rule objects
already get. This only ever redacts *more*, and it makes array and object handling agree.

## §3 FIX B — structural URL redaction, scoped to EVENT payloads

The existing redactor is pattern-based: it catches a *recognisable* secret. A URL query parameter is
the case where the secret is **not recognisable** — `?access_token=abc123` matches no pattern, because
`abc123` is not shaped like anything. Structural stripping is pattern-independent, which is exactly
why it is the right tool for this clause.

Rule: for every URL-looking substring, **drop the query and the fragment, and strip userinfo**,
keeping scheme, host and path. A removed query is replaced with a visible marker rather than
silently vanishing, so an operator can tell that something was withheld instead of concluding the URL
had no parameters.

### ★ Why this is NOT added to the shared redactor

`redactEventPayload` also serves **`adapterConfig`, `runtimeConfig`, approvals and activity details**.
An `http` adapter's webhook URL lives there, and a legitimate query string is part of it. Stripping
queries globally would corrupt what operators see rather than secure it — a display regression
wearing a security fix's clothes.

So Fix B is a separate, event-scoped entry point. Fix A goes in the shared path (it only ever
redacts more); Fix B does not.

## §4 Where the assertion lives — live, not dormant

The standing rule: every clause carries at least one **server-side** assertion, because the worker
half has no production boot root.

- `GET /heartbeat-runs/:runId/events` (`agents.ts:2178-2195`) is **live**, is the real egress for
  event payloads, and already calls the redactor. That is where Fix B lands and where the clause is
  proven.
- `getJobDetail` needs nothing: it **explicitly drops the payload** (`EVENT_SUMMARY_COLUMNS` —
  *"DROPPED: event (jsonb payload), fenceToken, leaseId"*). Safe by omission, and worth recording so
  a later reader does not "fix" it by adding the column back.

**Knowingly dormant, and labelled as such:** browser-observation URLs cannot arrive yet —
`browser_observation` has no producer and `@armyofagents/browser-runtime` has zero importers outside
its own package. Fix B is therefore proven against **run-event** payloads that do flow today, and
covers browser observations for free when they start. It is a real clause on live data, not a guard
waiting for input.

## §5 Why this must precede 003d-3 (metadata)

003d-3 routes console lines and network summaries into the frozen `extensions` channel. The frozen
forbidden-key scan is **keys-only** (`wire-safety.ts:43-58`), so a credential in an extension
*value* is legal on the wire. Ship metadata first and it opens an unredacted, wire-legal,
permanently-durable channel that then has to be closed. Ship this first — value-scoped, and now
array-safe — and metadata lands into a covered pipe.

## §6 Named residual — the durable store is NOT redacted

Recorded rather than implied away: this is a **projection-level mask**. `job-events.ts` stores the
complete wire event and the repository writes it verbatim; grep for `redact|sanitiz|scrub` across
both returns nothing, and there is no TTL. Redacting at ingest would desync `event_digest`, which is
recomputed from the stored bytes.

So an unredacted URL is durable for the life of the attempt. That is an **accepted, owned residual**,
not an oversight — and it is the reason the mask must sit on every egress rather than on one.

## §7 Tests — each with its red state

| Case | Assertion | Red today |
|---|---|---|
| ★ array-element secret | `{args:["--token","sk-ant-…"]}` redacts | **leaks verbatim** |
| array/object parity | the same secret redacts identically in both shapes | asymmetric |
| query stripped | `?access_token=…` removed, marker left | leaks |
| fragment stripped | `#id_token=…` removed | leaks |
| userinfo stripped | `user:pass@` removed | leaks |
| key-agnostic | works under `url`, `href`, `location`, nested, in arrays | n/a |
| scheme/host/path kept | the URL stays diagnostically useful | n/a |
| non-URL strings untouched | prose is not mangled | n/a |
| ★ **config NOT stripped** | an `adapterConfig` webhook URL keeps its query | proves the scoping is deliberate |
