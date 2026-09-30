---
title: Work Questions API
summary: Human questions, optimistic concurrency, reassignment, SLA escalation, and durable continuation
---

Work questions pause agent work for a human decision while preserving the execution context needed to continue. Board authentication and company access are required.

For the board-operator workflow, see [How to Resolve Work Questions](../guides/board-operator/work-questions.md).

## List and Read

```http
GET /api/companies/{companyId}/work-questions
GET /api/companies/{companyId}/work-questions/inline
GET /api/companies/{companyId}/work-questions/{questionId}
```

List filters include `status=open|answered|cancelled`, `issueId`, `sourceDiscussionId`, `executionWorkspaceId`, `sourceCommanderConversationId`, `scope=mine|all`, and `limit` (maximum 200; service default 100). `scope` defaults to `mine`; supplying a source filter searches that source rather than restricting results to the current recipient.

The detail route returns `{ question, capabilities }`. The inline list also includes capabilities so clients can render actions without another request.

## Answer

```http
POST /api/companies/{companyId}/work-questions/{questionId}/answer

{
  "answer": {
    "text": "Use the staged rollout.",
    "selectedValues": ["staged"]
  },
  "expectedVersion": 3,
  "idempotencyKey": "answer-01J..."
}
```

Only the current recipient can answer. Provide text, selected values, or both. Text is limited to 8,000 characters; selection arrays to 20 values. `expectedVersion` protects against concurrent changes. A stale version returns `409`.

An idempotency key may be retried safely. Reusing the same key after the question was answered returns the existing result; a different answer against an answered question conflicts. A linked terminal task cannot be answered.

## Reassign or Take Over

```http
POST /api/companies/{companyId}/work-questions/{questionId}/reassign
{ "userId": "{activeMemberId}", "expectedVersion": 3 }

POST /api/companies/{companyId}/work-questions/{questionId}/take-over
{ "expectedVersion": 3 }
```

An open question can be reassigned by its recipient, a founder or administrator, or an authorized scoped lead. The target must be an active company member. Founders, administrators, the task's responsible human or reviewer, and authorized scoped leads can take over a question.

## Cancel or Retry Continuation

```http
POST /api/companies/{companyId}/work-questions/{questionId}/cancel
{ "expectedVersion": 3 }

POST /api/companies/{companyId}/work-questions/{questionId}/retry-continuation
{ "expectedVersion": 4 }
```

Only founders and administrators can cancel an open question through the board API. Retry is available when an answered question's continuation failed; founders, administrators, the responsible human, and the reviewer can retry it.

## State and Delivery

Question status is `open`, `answered`, or `cancelled`. Every mutation increments `version`.

Continuation status is `not_needed`, `pending`, `dispatched`, `completed`, or `failed`. Answering records an immutable continuation envelope containing the task snapshot, acceptance criteria, question, answer, provenance, and continuation instructions. Delivery uses a durable request/outbox and may be retried; callers should not assume exactly-once execution.

Questions also snapshot their SLA: `slaDurationHours`, `slaSource` (`company` or `project`), `slaSourceId`, `dueAt`, `slaBreachedAt`, and `escalationRecipientUserId`. Project SLA overrides company SLA. The company default is 24 hours, with an allowed range of 1–720 hours.

## Common Errors

- `403` — caller cannot read or perform the requested action
- `404` — company, question, task, or recipient not found
- `409` — stale version, invalid state, terminal task, or conflicting answer
- `400` — invalid payload
