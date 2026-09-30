---
title: How to Resolve Work Questions
summary: Answer, transfer, cancel, and verify questions that block agent work
---

Work questions preserve an agent's task context while it waits for a human decision. This guide shows board operators how to resolve a question and confirm that the agent continued.

## Prerequisites

- Sign in as a board operator with access to the question's company and task.
- For API actions, use a supported board identity: an authenticated browser
  session cookie or a board API key in `Authorization: Bearer <key>`. A
  local-trusted development setup may use its configured synthetic board
  identity.
- Keep the question's current `version`. New answers, reassignments, takeovers,
  cancellations, and continuation retries check this value to prevent an older
  action from overwriting a newer one.

Every new state-changing attempt is version-guarded. An exact replay of an
already accepted answer with the same `idempotencyKey` returns the accepted
result even when the replay carries the older version.

## Find the Question

Open **Inbox** and select **Waiting on you**, then open the question. A question can also appear inline in its task workspace, source Discussion, or Commander conversation.

The Inbox defaults to questions assigned to you. If you can read the source task but cannot find its question in your queue, open the task or source conversation. API callers can search all readable questions with:

```http
GET /api/companies/{companyId}/work-questions?status=open&scope=all
```

Before acting, check:

- The asking agent and linked task
- The question, context, and any option rationale
- The due or overdue label
- Whether the action you need is available

An overdue question remains assigned to its current recipient. The SLA process raises its priority and notifies the recipient and escalation contact; it does not reassign the question.

## Answer a Question

1. Open the question in the Inbox or its source context.
2. Select one option, or enter a written answer.
3. Click **Send answer**.

The option control currently accepts one option. Entering text clears the selected option, and selecting an option clears the text.

Only the current recipient can answer. A founder, administrator, responsible human, reviewer, or scoped team lead who is not the recipient must first take over or arrange reassignment.

After submission, the question changes from `open` to `answered`. If the agent has resumable execution context, continuation changes to `pending` and AoA delivers the saved answer to the agent.

### Answer through the API

Read the latest detail first:

```http
GET /api/companies/{companyId}/work-questions/{questionId}
```

Then use `question.version` as `expectedVersion`:

```http
POST /api/companies/{companyId}/work-questions/{questionId}/answer
Content-Type: application/json

{
  "answer": {
    "text": "Use the staged rollout."
  },
  "expectedVersion": 3,
  "idempotencyKey": "answer-{uniqueAttemptId}"
}
```

For an option answer, send the option's `value`, not its display label:

```json
{
  "answer": {
    "selectedValues": ["staged"]
  },
  "expectedVersion": 3,
  "idempotencyKey": "answer-{uniqueAttemptId}"
}
```

If the connection fails after submission, retry the same answer with the same `idempotencyKey`. Do not generate a new key for that retry. The web UI preserves the key for repeated submissions of the same attempt.

## Reassign or Take Over

Use reassignment when another active company member should own the decision. Use takeover when you are authorized to become the recipient yourself.

### Take over in the UI

1. Open the question.
2. Click **Take over**.
3. Review the question again after the panel refreshes.
4. Submit the answer as the new current recipient.

The button appears only when the server grants takeover capability. Eligible operators include founders, administrators, the task's responsible human or reviewer, and a team lead scoped to the task.

### Reassign through the API

The current UI does not expose a reassignment control. Obtain the destination user's ID from the [Team API](../../api/team.md), read the latest question detail, and send:

```http
POST /api/companies/{companyId}/work-questions/{questionId}/reassign
Content-Type: application/json

{
  "userId": "{activeCompanyUserId}",
  "expectedVersion": 3
}
```

The current recipient, a founder or administrator, or an authorized scoped team lead can reassign an open question. The destination must be an active company member and, for a scoped lead, must be inside the permitted task scope.

Reassignment and takeover change `currentRecipientUserId`, increment `version`, and move the Inbox item to the new recipient. They do not reset the original SLA deadline.

## Cancel an Obsolete Question

Cancel only when the open question should no longer be answered. Cancellation is terminal and does not resume the asking agent.

The current UI does not expose cancellation. A founder or administrator can read the latest question detail and send:

```http
POST /api/companies/{companyId}/work-questions/{questionId}/cancel
Content-Type: application/json

{
  "expectedVersion": 3
}
```

The question changes to `cancelled`, its continuation becomes `not_needed`, and its Inbox mirror is reconciled. Closing the linked task also cancels its open questions. Reassigning a task away from the asking agent cancels that agent's open question.

## Monitor the Continuation

After an answer, read the continuation label in the question panel:

| Status | Operator meaning |
|---|---|
| `pending` | The answer is saved and waiting for delivery. Dispatch failures are retried automatically before the question becomes failed. |
| `dispatched` | The answer was relayed to the existing run or a continuation run was queued. |
| `completed` | The continuation run finished successfully. |
| `failed` | Delivery exhausted its retries or the continuation run failed. An accountable operator may retry it. |
| `not_needed` | No continuation will run. This can occur when the linked task is no longer active, in progress, or assigned to the asking agent. |

The panel refreshes every five seconds while the question is open or continuation is `pending` or `dispatched`.

### Retry a failed continuation

1. Open the answered question.
2. Confirm that continuation is `failed`.
3. Read `continuationError` when using the API, and fix any task or agent condition that caused the failure.
4. Click **Retry continuation**.
5. Wait for the status to move from `pending` to `dispatched`, then `completed`.

The retry button appears only for a founder, administrator, responsible human, or reviewer who can read the source task. The original recipient does not receive retry permission solely because they answered the question.

API callers can retry with the latest version:

```http
POST /api/companies/{companyId}/work-questions/{questionId}/retry-continuation
Content-Type: application/json

{
  "expectedVersion": 5
}
```

A retry reuses the immutable saved answer and task-context envelope. It does not ask the human to answer again.

## Resolve a Version Conflict

A `409` response means the question changed after your copy was loaded, its state no longer permits the action, or the linked task became terminal.

1. Stop retrying the stale request.
2. Fetch the question again:

   ```http
   GET /api/companies/{companyId}/work-questions/{questionId}
   ```

3. Inspect `status`, `currentRecipientUserId`, `version`, and `continuationStatus`.
4. If the question is still open and you still have the required capability, repeat the action with the new `version`.
5. If it is already answered or cancelled, do not overwrite the terminal result.

An SLA breach also increments `version`, so a deadline update can make a previously loaded API request stale. The web UI preserves a typed draft across that refresh.

For a lost answer response, the idempotency rule takes precedence: first retry the identical answer with the same `idempotencyKey`. The service returns the accepted answer if that key already committed.

## Verification

Confirm all of the following:

1. The question shows `answered` or the intended terminal state.
2. The recorded answer displays the expected text or option label.
3. The Inbox item no longer appears as an open blocker.
4. For resumable work, continuation reaches `completed`.
5. The linked task or run timeline shows the agent's resumed work.

For API verification:

```http
GET /api/companies/{companyId}/work-questions/{questionId}
```

Check `question.status`, `question.answer`, `question.answeredByUserId`, `question.version`, `question.continuationStatus`, `question.continuationRunId`, and `question.continuationError`.

Mutations also write activity entries such as `work_question.answered`, `work_question.reassigned`, `work_question.taken_over`, `work_question.cancelled`, and `work_question.continuation_retried`.

## Troubleshooting

### The question is missing from Waiting on you

The Inbox is recipient-scoped. Open the linked task, workspace, Discussion, or Commander conversation, or query with `scope=all`. You must still have access to the source task.

### Send answer or Take over is unavailable

The server did not grant that capability. Only the current recipient can answer. Takeover depends on founder or administrator authority, task accountability, review responsibility, or team-lead scope.

### The action returns `401`

The request has no accepted board identity. Sign in, send a valid board API
key, or verify the local-trusted development configuration.

### The action returns `403`

You can read the question but cannot perform that action, or you lack company access. Reassign to an eligible recipient, take over if permitted, or ask a founder or administrator.

### The action returns `404`

The question or reassignment recipient no longer exists in the expected scope.
For reassignment, verify that the destination is an active company member.

### The action returns `409`

Refresh the detail and follow [Resolve a Version Conflict](#resolve-a-version-conflict).
A missing or terminal linked task, an already answered question, or an invalid
continuation state also returns `409`.

### The action returns `400`

Correct the request body. Answers require non-empty text or at least one selected value. `expectedVersion` must be a non-negative integer, and an answer requires a non-empty idempotency key.

### Continuation remains pending or dispatched

The task may already have active execution, so delivery can be deferred. Check the linked task and run timeline. The question panel keeps polling while either state is active.

### Continuation becomes not needed

Check whether the task was completed, cancelled, moved out of `in_progress`, or reassigned to another agent. AoA will not resume stale work against an ineligible task.

### Retry continuation is unavailable

Retry is shown only when the question is answered, continuation is `failed`, and your role has retry capability. A current recipient who is not also a founder, administrator, responsible human, or reviewer cannot retry.

## Related

- [Work Questions API](../../api/work-questions.md)
- [Inbox](inbox.md)
- [Managing Tasks](managing-tasks.md)
- [Team API](../../api/team.md)
