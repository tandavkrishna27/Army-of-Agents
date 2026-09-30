---
title: Onboarding API
summary: Post-auth journeys, resumable progress, environment setup, and join finalization
---

Onboarding routes are board-session APIs. They always derive the user from the
authenticated actor; callers cannot read or advance another user's progress.

## Resolve the Post-Auth Journey

```http
GET /api/onboarding/journey
```

Returns:

```json
{
  "journey": "founder",
  "targetCompanyId": null,
  "pendingInvitations": [],
  "inviteToken": null
}
```

`journey` is:

- `returning` when the user has an active membership, or an instance
  administrator can see an existing company;
- `invited` when a pending human request belongs to the user or a currently open
  invite matches their verified email;
- `founder` when neither condition applies.

`pendingInvitations` contains `companyId`, `companyName`, `inviteId`, `role`,
`createdAt`, and `filed`. `filed: false` means an open verified-email match was
discovered but no request has been filed; the UI must obtain explicit consent
before claiming it. `inviteToken` is retained only for response compatibility
and is always `null`.

Returns `401` without an authenticated board user.

## Read Progress

```http
GET /api/onboarding/progress
GET /api/onboarding/progress?companyId={companyId}
```

Returns `{ "progress": null }` when no row exists, otherwise:

```json
{
  "progress": {
    "id": "uuid",
    "userId": "user-id",
    "companyId": "uuid-or-null",
    "journey": "founder",
    "currentState": "PROFILE_SET",
    "completedStates": ["AUTHENTICATED", "PROFILE_SET"],
    "version": 1
  }
}
```

A company-scoped lookup enforces company access. Returns `401` without a board
user.

## Advance Progress

```http
PATCH /api/onboarding/progress
Content-Type: application/json

{
  "companyId": "uuid-or-null",
  "journey": "founder",
  "requestedState": "PROFILE_SET"
}
```

Progress is forward-only. Replaying a completed or earlier state succeeds as an
idempotent no-op. Skipping a prerequisite or requesting a state outside the
journey returns `409`; a version conflict that still loses after bounded retry
also returns `409`. Invalid journey or state values return `400`.

The shipped founder sequence is:

```text
AUTHENTICATED
→ PROFILE_SET
→ COMPANY_CREATED
→ ENVIRONMENT_READY
→ COMMANDER_SELECTED
→ COMMANDER_VERIFIED
→ DEPARTMENT_CREATED
→ AGENT_ASSIGNED
→ SETUP_COMPLETE
```

The shipped invited sequence is:

```text
AUTHENTICATED → PROFILE_SET → JOIN_REQUESTED → SETUP_COMPLETE
```

Additional `WALKTHROUGH_*` and discussion/scope states exist as reserved enum
values. They are not driven by the current onboarding flow.

`ORGANIZATION_CREATED` is accepted as a legacy request alias and is normalized
to `COMPANY_CREATED` before transition checks and persistence. New clients must
send and display the canonical `COMPANY_CREATED` state.

## Set Up the Local Environment

```http
POST /api/companies/{companyId}/onboarding/environment
Content-Type: application/json

{ "rootFolder": "/absolute/path" }
```

Requires a board user with instance-settings authority and company access.
`rootFolder` is required and must be absolute. AoA performs a write probe before
persisting the environment:

- `200` — probe passed; response identifies whether the environment was created
  or updated
- `400` — missing or non-absolute path
- `401` — no board authentication
- `403` — no instance-settings or company authority
- `422` — write probe failed; nothing is persisted

The audit log records the environment mutation without copying the local path
into the activity payload.

## Global Human Operating Profile

```http
GET   /api/user-profile
PATCH /api/user-profile
```

Both routes are self-only and return `{ "profile": ... }`. PATCH accepts only
fields present in the request:

| Field | Type |
|---|---|
| `displayName` | string or `null` |
| `avatarUrl` | string or `null` |
| `title` | string or `null` |
| `bio` | string or `null` |
| `timezone` | string or `null` |
| `socialLinks` | array of validated social-link objects |

A social link requires a supported `type`, a valid URL up to 2,048 characters,
and an optional label. Malformed links return `400`. The onboarding UI requires
name, title, and timezone before it advances even though this general-purpose
PATCH route supports partial updates.

`GET /api/auth/profile` and `PATCH /api/auth/profile` are the smaller
compatibility profile used by account chrome. The richer `/api/user-profile`
record is the onboarding source of truth.

## Finalize an Invited Journey

```http
POST /api/onboarding/join/finalize
Content-Type: application/json

{
  "companyId": "uuid",
  "acceptOpenInvite": true
}
```

The route is self-scoped. `acceptOpenInvite: true` is required only when
claiming a tokenless open invite or a fresh reinvite after rejection. Omitting
it must not reveal whether an open matching invite exists.

Responses use:

```json
{ "admitted": true, "status": "approved" }
```

or `{ "admitted": false, "status": "pending" | "rejected" |
"invite_invalid" }`.

A verified-email match can auto-admit an ordinary member or lead. An unmatched
or unverified email and any invite carrying privileged authority remain
pending for founder approval. An already approved request is idempotently
reported as approved.

Returns `400` when `companyId` is missing, `401` without a board user, and `404`
when there is no request or consented open invite.

Invite creation, expiry, revoke/resend, and manual approval belong to the
[Team API](./team.md).
