---
title: Team API
summary: Human membership, roles, reporting lines, profiles, capabilities, invites, and workload
---

The Team API manages company users and their place in the reporting structure. Agent management uses the [Agents API](agents.md).

## Read the Team

```http
GET /api/companies/{companyId}/team
GET /api/companies/{companyId}/team/humans/search?q=alex&role=team_lead&departmentId={projectId}&limit=20
GET /api/companies/{companyId}/team/users/{userId}
GET /api/companies/{companyId}/team/users/{userId}/dependencies
GET /api/companies/{companyId}/team/users/{userId}/workload
```

The team list requires company access. Search, workload, and the management endpoints below require board authentication. Human search accepts `role=founder|team_lead|team_member|all`; `limit` defaults to 20 and is capped at 50.

## Add a Member

Invitations are the recommended onboarding path because they verify the recipient. See [Onboarding API](onboarding.md).

Create an email-bound human invite:

```http
POST /api/companies/{companyId}/invites

{
  "allowedJoinTypes": "human",
  "defaultsPayload": {
    "human": {
      "grants": []
    },
    "teamInvite": {
      "email": "alex@example.com",
      "role": "team_member",
      "projectId": null,
      "parentId": "{managerUserId}"
    }
  }
}
```

This route requires `users:invite` and returns `201` with the token, expiry, and invite URL. Email-bound human invites expire after seven days; agent or mixed invites expire after ten minutes. A non-founder needs `users:manage_permissions` to embed grants and may grant only permissions they already hold. Only a founder or the local trusted operator may create an invite that confers founder authority or privileged governance permissions.

The Team UI is intentionally narrower: it offers the Founder role only to an
instance administrator. The API authority above describes the server contract
for callers that construct invite payloads directly.

An authorized board operator can also add a member directly:

```http
POST /api/companies/{companyId}/team/members

{
  "name": "Alex Chen",
  "email": "alex@example.com",
  "role": "team_member",
  "projectId": "{departmentId}",
  "parentType": "user",
  "parentId": "{managerUserId}"
}
```

## Change Role or Reporting Line

```http
PATCH /api/companies/{companyId}/team/users/{userId}/role

{
  "role": "team_lead",
  "projectId": "{departmentId}",
  "parentType": "user",
  "parentId": "{managerUserId}"
}
```

Requires founder authority. Human roles are `founder`, `team_lead`, and `team_member`; a human's parent is another user.

## Profiles

```http
PATCH /api/companies/{companyId}/team/users/{userId}/profile

{
  "displayName": "Alex Chen",
  "title": "Product Lead",
  "bio": "Owns product strategy.",
  "location": "Bengaluru",
  "timezone": "Asia/Kolkata",
  "avatarAssetId": "{assetId}",
  "socialLinks": [
    { "type": "linkedin", "url": "https://linkedin.com/in/example" }
  ]
}
```

Users may edit their own profile. Founders and system administrators may edit another user's profile. A profile accepts up to 20 social links; link types include `linkedin`, `github`, `x`, `instagram`, `facebook`, `substack`, `website`, `portfolio`, `youtube`, `medium`, and `other`.

## Capability Documents

```http
GET /api/companies/{companyId}/team/users/{userId}/agent-context
GET /api/companies/{companyId}/team/users/{userId}/capabilities

POST /api/companies/{companyId}/team/users/{userId}/capabilities
{
  "title": "Research skills",
  "filename": "research.md",
  "content": "# Research\n..."
}

PATCH /api/companies/{companyId}/team/users/{userId}/capabilities/{documentId}
DELETE /api/companies/{companyId}/team/users/{userId}/capabilities/{documentId}
```

The standard capability filenames are `resume.md`, `skills.md`, `responsibilities.md`, `preferences.md`, `availability.md`, and `background.md`. Custom filenames must be safe lowercase Markdown filenames. Content is limited to 100,000 characters. Users manage their own documents; founders and system administrators may manage another user's documents.

## Remove a Member

```http
DELETE /api/companies/{companyId}/team/users/{userId}
```

Founder authority is required. When a member still owns reporting dependencies, reassign them and remove the member atomically:

```http
POST /api/companies/{companyId}/team/users/{userId}/reassign-and-remove

{
  "humanReassignments": [
    { "userId": "{reportId}", "newParentId": "{newManagerId}" }
  ],
  "agentReassignments": [
    { "agentId": "{agentId}", "newParentType": "user", "newParentId": "{newManagerId}" }
  ]
}
```

## Transfer the System Administrator

```http
POST /api/companies/{companyId}/team/transfer-admin

{
  "toUserId": "{userId}",
  "confirmation": "TRANSFER"
}
```

The current system administrator must make this request, the destination must
already be a founder in the company, and the literal confirmation value is
required. This transfers the `isSystemAdmin` flag; it does not grant or transfer
the founder role.

## Invite Maintenance

Founders can revoke an outstanding invite or rotate its token and expiry:

```http
PATCH /api/companies/{companyId}/invites/{inviteId}/revoke
POST /api/companies/{companyId}/invites/{inviteId}/resend
```

Resend returns the new token, expiry, and an absolute invite URL when the instance has a trusted public base URL.
