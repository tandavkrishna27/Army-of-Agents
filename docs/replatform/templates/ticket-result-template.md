# <TICKET-ID> Result — <Ticket title>

**Status:** `gate_review`
**Date (UTC):** `<YYYY-MM-DD>`
**Epic:** `<E#-name>`
**Plan task:** `<implementation-plan heading>`
**Implementer:** `<agent or human identity>`
**Start SHA:** 0000000000000000000000000000000000000000

The implementer replaces the `Start SHA` value with the exact 40-lowercase-hex
`git rev-parse HEAD` captured before the first change. Write it **bare** — not
backtick-wrapped — so the integration-gate parser
(`^\*\*Start SHA:\*\*\s*([0-9a-f]{40})\s*$`) reads it; leaving it backticked
makes the gate treat the SHA as missing.

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- List the behavior actually delivered.
- List explicit non-goals preserved.

## Changed files

| File | Responsibility |
|---|---|
| `<path>` | `<why it changed>` |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| `<condition>` | `<test, assertion, or inspected artifact>` | `pass` or `fail` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `<exact command>` | `0` | `<counts/output>` |

## Deviations

State `None` or describe the approved decision entry that changed the plan.

## Findings

State `None` or link stable IDs from `../findings.md`.

## Follow-up tickets

State `None` or list ticket IDs with one-sentence outcomes.

## Gate recommendation

State `ready for independent review` or `not ready`, with the concrete reason.

## Independent review

**Reviewer:** `<pending until first independent review, then agent or human identity; must differ from implementer>`
**Reviewed revision:** `<pending until first independent review, then 40-character git SHA>`
**Disposition:** `pending`, `approved`, or `changes_requested`
**Review evidence:** `<pending until first independent review, then review record, exact commands/exit codes, or finding links>`

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
