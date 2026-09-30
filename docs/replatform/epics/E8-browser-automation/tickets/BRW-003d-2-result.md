# BRW-003d-2 — Redaction — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ complete
**Design:** [`BRW-003d-2-design.md`](./BRW-003d-2-design.md) · **Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Start SHA:** `e5e502bdb` (design) · **End SHA:** `5a6fe4d11`
**Discharges:** BRW-003 acceptance "redaction is explicit".

---

## 1. ★ FIX A — a live security defect the ticket did not set out to find

**A secret held in an ARRAY ELEMENT was not redacted at all.**

```
{ args: ["--token", "sk-ant-…"] }   ->  LEAKED VERBATIM
{ cfg:  { thing:    "sk-ant-…" } }  ->  redacted
```

`sanitizeValue` recurses into arrays and plain objects, but a **string** fell through
`if (!isPlainObject(value)) return value;` untouched. Only `sanitizeRecord` tested string values, and
only for values it reached **as a record entry** — which an array element never is. So an array
element skipped **both** the key-name check and the value-pattern check, while the identical secret
one level differently nested was caught. **That asymmetry was the whole defect.**

It was live rather than theoretical: `args` arrays are what `process` and `claude_local` adapter
configs carry, and this redactor serves `agent.adapterConfig` / `runtimeConfig` and the run-event
payloads behind `GET /heartbeat-runs/:runId/events`. A token passed as a CLI argument was displayed
verbatim to anyone who could read the agent.

Found by **running** the real redactor against a table of shapes rather than reading it. The design
had assumed this slice would *add* redaction; the redactor already existed, with ~13 call sites, and
the earlier survey missed it entirely. The question that mattered was never "what should we build"
but **"what does the thing that already runs fail to catch."**

## 2. FIX B — structural URL redaction, and why a pattern cannot do it

The rest of the module is pattern-based: it catches a secret that *looks* like one. A URL query
parameter is exactly the case where it does not — `?access_token=abc123` matches nothing, because
`abc123` is shaped like nothing. **Structure is the only thing left to key on**, and structure does
not care whether the value is recognisable.

Query and fragment dropped, userinfo stripped, scheme/host/path kept — with a **marker**, because an
operator who sees a bare URL would otherwise conclude it carried no parameters. Silence is a worse
answer than "something was withheld".

### ★ Deliberately NOT added to the shared redactor, and a test pins it

`redactEventPayload` also serves `adapterConfig`, `runtimeConfig`, approvals and activity details,
where a legitimate query string is part of what an operator is trying to read. Stripping globally
would corrupt the display rather than secure it.

So there are two entry points, and a **pair** of assertions: the same value survives one and is
stripped by the other. That pair is what makes the narrower scope a decision rather than an omission
— move the URL pass into the shared path and a test goes red, so someone has to mean it.

**Correction to the design doc:** it used `webhookUrl` as the example of a config URL that must keep
its query. Wrong example — `webhook` is already in `SECRET_PAYLOAD_KEY_RE`, so that key is redacted
wholesale by name and proves nothing. The test uses `baseUrl`, which matches no key pattern and
therefore isolates exactly the behaviour under test. The fixture caught my own error.

## 3. ★ The bug that cost the most time was invisible in every view of the source

The URL regex began with a literal **backspace byte (0x08)** instead of the two characters `\` and
`b`, because a heredoc interpreted the escape. Every editor view, every `grep`, and four separate
readings of the source showed `\b`. The regex simply never matched, and the code was *correct on
inspection* the whole time.

Found by hexdumping the line after the logic had been verified by hand and by isolated re-execution —
i.e. after everything except the bytes had been checked.

Then **the same escaping hazard ate the fix for the escaping hazard**: the repair, written with `\\b`
in another heredoc, was itself collapsed and replaced 0x08 with 0x08 — a no-op that reported success.
It had to be rebuilt with `chr(92)` so that no escape sequence existed at all.

A sweep confirms no other C0 control characters in any file this lane has touched.

**The generalisable part:** when code reads correctly and behaves incorrectly, and re-reading has
already failed twice, stop reading and look at the bytes.

## 4. Mutation testing — 10 mutants, 10 killed

| Mutant | Result |
|---|---|
| Fix A reverted (strings fall through `sanitizeValue`) | killed — 5 tests |
| URL pass removed from the event entry point | killed — 9 tests |
| query never cleared | killed — 7 tests |
| fragment never cleared | killed — 2 tests |
| **fail-closed fallback returns the raw URL** | **survived → test added → killed** |
| userinfo not stripped | killed |
| marker removed (withheld query vanishes silently) | killed |
| `stripUrlsDeep` stops recursing into arrays | killed |
| **the 0x08 control byte returns** | killed — 9 tests |
| route binding reverted to the non-URL redactor | killed |

### One FALSE SURVIVOR, caught and re-cut

The first "query kept" mutant referenced an undefined variable. That threw **inside**
`redactOneUrl`'s `try/catch`, fell to the fail-closed fallback, and still redacted — so it reported
survival while never testing what it claimed. Re-cut three ways, all three killed.

It also exposed something the mutant was not looking for: **the fail-closed branch had no test at
all.** Malformed URLs that `new URL` refuses — `http://[::1?token=…` and friends — are precisely the
inputs most likely to be hostile, and that path now has one.

## 5. Where the assertion lives

- `GET /heartbeat-runs/:runId/events` is **live**, is the real egress for event payloads, and now
  calls the event-scoped redactor. A dedicated route test proves the **binding** — the lesson from
  003d-1, where a constant was covered while its wiring was not.
- `getJobDetail` needs nothing: it **explicitly drops** the payload column. Safe by omission, and
  recorded so a later reader does not "fix" it by selecting the column back.

## 6. Named residuals

1. **The durable store is not redacted.** This is a projection-level mask; `job_events.event` retains
   the raw payload for the life of the attempt, and redacting at ingest would desync `event_digest`.
   Accepted and owned — and the reason the mask must sit on every egress rather than one.
2. **Browser-observation URLs cannot arrive yet** — no producer, and `browser-runtime` has zero
   importers outside its own package. Fix B is therefore proven against **run-event** payloads that
   flow today and covers browser observations for free when they start. A real clause on live data,
   not a guard waiting for input.
3. **Path-segment secrets** (`/reset/<token>`) are not removed structurally; they remain covered only
   where the existing value patterns match.

## 7. Verification

- 17 unit + 2 route tests green
- **12,859 server tests green**; the 7 reds are the pre-existing set that reproduces without these
  changes (release-smoke ×3, e2e-company-seed, runtime-service-control, sweep-steward,
  workspace-runtime), and the `desktop-disabled` failures from 003d-1 are gone
- typecheck clean
