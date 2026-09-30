---
title: How to Automate Recurring Work with Routines
summary: Create, trigger, verify, pause, and recover repeatable task automation
---

Use a routine to turn repeatable instructions into Tasks on a schedule, from a
manual run, or through an authenticated integration. This guide shows the
board-operator workflow in the AoA UI and the checks that confirm each run did
what you intended.

## Prerequisites

Before you create a routine:

- Select the company that will own the routine.
- Make sure you have task-assignment permission. Creating routines, enabling
  them, adding or editing triggers, and starting manual runs require
  `tasks:assign`.
- Create the agent and project you want to use, if the routine should assign
  its Tasks automatically.
- For scheduled runs, make sure the heartbeat scheduler has not been explicitly
  disabled. Scheduling is enabled by default; setting
  `HEARTBEAT_SCHEDULER_ENABLED=false` disables schedule ticks.

## Create a Routine

1. Open **Routines** from the **WORK** section of the company sidebar.
2. Select **Create routine**.
3. Enter a name that describes the resulting Task, such as
   `Prepare weekly customer report`.
4. Choose an agent and project when the generated Task should be assigned and
   scoped automatically. Both fields are optional.
5. Add the instructions the agent should receive.
6. Open **Advanced settings** and choose how overlapping and missed runs should
   behave:

   - **coalesce if active** keeps one existing live execution Task instead of
     creating another overlapping Task.
   - **always enqueue** creates a Task for every trigger occurrence.
   - **skip if active** records the overlap as skipped while a live execution
     is running.
   - **skip missed** ignores schedule windows missed while scheduling was
     unavailable.
   - **enqueue missed with cap** catches up missed windows, up to 25 runs in one
     scheduler pass.

7. Select **Create routine**.

AoA creates the routine as active and opens its **Triggers** tab. A routine
without a trigger is valid and can still be started with **Run now**.

## Add a Schedule

1. On the routine's **Triggers** tab, select **Add** beside **Schedule**.
2. Choose a preset such as every hour, every day, weekdays, or specific days.
   Choose **Custom cron** when you need a five-field cron expression.
3. Set the time. The UI stores the browser's local IANA timezone, such as
   `Asia/Kolkata`, with the trigger.
4. Use **Add another schedule** if the same routine should run at more than one
   time.
5. Confirm the dialog.

The trigger card should show a human-readable schedule and its **Next run**.
Edit the trigger when you need to change its cron expression, timezone, or
label.

## Add and Configure Variables

Variables let one routine produce differently titled or instructed Tasks
without duplicating the routine.

1. Add placeholders to the routine name or instructions:

   ```text
   Prepare the {{region}} customer report for {{date}}
   ```

2. Save the routine.
3. Open the **Variables** tab. AoA detects placeholders from both the name and
   instructions.
4. Configure each variable's label, type, default value, and whether it is
   required. Supported types are text, textarea, number, boolean, and select.
5. For a select variable, enter its allowed values and optionally choose a
   default.
6. Select **Save variables**.

Variable names must begin with an ASCII letter and may contain only ASCII
letters, digits, and underscores. `{{date}}` is built in, resolves to the
current UTC date in `YYYY-MM-DD` form, and does not appear in the Variables
editor.

Removing a placeholder from both the name and instructions removes it from the
detected variable set the next time variables are saved.

## Test the Routine Manually

Test a routine before relying on an automatic trigger.

1. Select **Run now** from the routine page or its card.
2. Enter values for any variables. Defaults are prefilled, and the dialog
   blocks submission while a required value is empty.
3. Select **Run routine**.
4. Open the **Runs** tab.

A successful dispatch first appears as `issue created` and links to the
generated Task. Open that Task to confirm:

- the title and instructions contain the interpolated variable values;
- the project, goal, parent Task, priority, and assignee match the routine;
- the Task's completion policy matches the routine or the applicable
  company/project policy.

Manual runs are allowed while a routine is paused. Archived routines cannot be
run.

## Verify Automatic Runs

Use the routine detail tabs as the operational record:

- **Triggers** shows whether each trigger is enabled, its next run, last fire
  time, and last result.
- **Runs** shows the source, status, linked Task, time, and failure reason.
- **Activity** combines routine, trigger, and run audit events.
- **History** shows saved definition revisions and their authors.

Run statuses mean:

| Status | Meaning |
| --- | --- |
| `received` | The run was accepted and dispatch is in progress. |
| `issue_created` | AoA created the execution Task. An assignment wakeup is queued only when the Task has an eligible assigned agent and its work mode allows dispatch. |
| `coalesced` | An existing live execution Task was reused. |
| `skipped` | The concurrency policy dropped an overlapping occurrence. |
| `completed` | The linked execution Task moved to done. |
| `failed` | Dispatch failed, or the linked Task became blocked or cancelled. |

Routine failures also create a failure-only item in Inbox. Successful,
coalesced, and skipped runs remain visible in run history without an extra
Inbox notification.

## Pause, Archive, or Restore

- **Pause** disables automatic schedule and webhook execution. Existing Tasks
  keep their own lifecycle, and board operators can still use **Run now**.
- **Enable** returns a paused routine to active status.
- **Archive** prevents automatic and manual runs while keeping history.
- **Restore** from the archived filter returns the routine to active status.

Routine-definition edits save the previous definition as a revision. Trigger
creation, edits, and deletion are not included in those snapshots and cannot be
recovered from History. To recover an earlier routine definition:

1. Open **History**.
2. Review the available revision. The current UI diff shows only description
   changes, even though restore replaces the full saved definition.
3. Select **Restore**.
4. Verify the restored title, description, assignee, project, goal, parent Task,
   priority, status, concurrency and catch-up policies, completion-policy
   override, and variables.
5. Reopen **Triggers** and **Runs** as well. Existing triggers remain in place
   because triggers are not part of the restored snapshot.

Restoring a revision rotates every webhook secret attached to the routine. The
restore response does not reveal those new values. Immediately rotate each
webhook secret through the [Routines API](../../api/routines.md), save the
one-time secret response, and update the sending integration before treating
the restored routine as operational.

## Use a Webhook or API Trigger

The backend supports bearer-token and HMAC-SHA256 webhooks, but the current
Routines page disables creation of new webhook triggers. Create webhooks through
the [Routines API](../../api/routines.md). The create and rotate responses show
the plaintext secret once.

For bearer mode, send:

```http
Authorization: Bearer {webhookSecret}
```

For HMAC mode, sign `{timestamp}.{rawBody}` with SHA-256 HMAC and send the
timestamp and hex signature in `X-Aoa-Timestamp` and `X-Aoa-Signature`. The
default replay window is 300 seconds.

Use an idempotency key for integrations that may retry. AoA returns the
existing matching run instead of creating a duplicate for the same routine,
source, trigger, and key.

For an authenticated API trigger, create a trigger with `kind: "api"`, then
call `POST /api/routines/{routineId}/run` with that trigger's ID, a `source` of
`api`, and any variable values. See [Start a Run](../../api/routines.md#start-a-run)
for the request contract and accepted response.

## Troubleshooting

### A schedule never fires

- Confirm the routine and trigger are both active.
- Confirm the trigger card has a **Next run** value.
- Confirm `HEARTBEAT_SCHEDULER_ENABLED` is unset or set to `true`; the exact
  value `false` disables scheduling.
- Check that the stored timezone is a valid IANA timezone and the cron
  expression has five fields.
- Check server logs for `routine scheduled trigger tick failed`.

### Run now returns 403

Your board identity lacks `tasks:assign`. Ask a founder or instance
administrator to grant task-assignment authority, or have an authorized
operator start the run.

### A routine request returns 409

Common causes are:

- the routine is archived;
- the selected trigger was disabled;
- another operator edited the routine and your revision token is stale;
- the assignee is pending approval or terminated.

Reload the routine before retrying. Choose an active assignee when assignment
caused the conflict.

### A run returns 422

Check required variable values, number and boolean formats, select options,
cron syntax, timezone, and company ownership of linked entities. Unknown
`variableOverrides` keys are rejected.

### Saving the priority fails

The current detail UI offers `critical`, while the routine API validator
accepts `urgent`, `high`, `medium`, or `low`. Leave the existing priority
unchanged in the UI, or update it through the API with one of the accepted
values until the UI and validator are aligned.

### A webhook is unauthorized

- Confirm you are using the newest secret. Rotation invalidates the previous
  value.
- For bearer mode, include the exact `Bearer ` prefix.
- For HMAC mode, sign the raw request bytes, not reformatted JSON.
- Make sure the timestamp falls inside the configured replay window.
- After a revision restore, rotate the secret again and replace the sender's
  stored value.

### A webhook URL has the wrong origin

Verify the server's `AOA_API_URL`. The public path is always:

```text
/api/routine-triggers/public/{publicId}/fire
```

## Related Documentation

- [Routines API](../../api/routines.md)
- [Managing Tasks](managing-tasks.md)
- [Managing Agents](managing-agents.md)
- [Inbox](inbox.md)
