---
title: Authentication
summary: Google sessions, local trust, and bearer identities
---

AoA authenticates humans, board clients, and agents differently. Authentication
establishes identity; company membership and RBAC determine what that identity
may access.

For the short-lived instance-admin board credential used by fleet recovery, see
[Marketplace recovery](/guides/board-operator/marketplace-recovery).

## Human Authentication

Google is the only interactive human sign-in provider. Email/password sign-in,
registration, and password reset routes are not supported. Better Auth handles
the Google OAuth state and PKCE flow, then stores the board session in an
HTTP-only cookie.

Sessions last 90 days and are refreshed after one day of active use. Cookies use
`SameSite=Lax`; they are `Secure` for public exposure or an explicit HTTPS auth
base URL. Private HTTP deployments intentionally omit `Secure` so browsers can
retain the cookie on a trusted LAN or tailnet.

The first Google user created on an empty instance becomes the instance
administrator. This bootstrap is advisory-locked and idempotent so concurrent
first sign-ins cannot create multiple first admins.

### Authenticated Mode

Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The server refuses to
start an authenticated deployment without both because Google is the only
sign-in provider. Set `BETTER_AUTH_SECRET` to a stable secret for session-cookie
signing.

### Local Trusted Mode

`local_trusted` is loopback-only. `aoa run` enables the synthetic local board
identity for a zero-configuration quickstart when Google credentials are absent;
`pnpm dev` does the same for development. This actor has local administrator
authority but is not a real Google-backed account. The compatibility
`PATCH /api/auth/profile` route therefore refuses edits for this synthetic
identity.

`AOA_DEV_LOCAL_IDENTITY` is ignored outside `local_trusted` and is refused on an
instance that already contains real users unless the explicit development or
recovery override is set. It is not a multi-user authentication mechanism.

## Board API and CLI Authentication

Board API keys authenticate a human-compatible board client with:

```http
Authorization: Bearer <board-api-key>
```

The browser-assisted CLI flow creates a short-lived challenge, asks a signed-in
board user to approve it, and returns a board API key to the CLI. A request for
`instance_admin_required` access can be approved only by an instance
administrator. Challenges expire after ten minutes and creation is limited to
five requests per minute per IP.

```text
POST /api/cli-auth/challenges
GET  /api/cli-auth/challenges/{id}?token={challengeToken}
POST /api/cli-auth/challenges/{id}/approve
POST /api/cli-auth/challenges/{id}/cancel
```

Challenge creation is unauthenticated because the CLI does not have a key yet.
The request accepts `command`, optional `clientName`,
`requestedAccess: "board" | "instance_admin_required"`, and an optional
`requestedCompanyId`. A successful `201` response contains the challenge ID,
challenge token, pending board token, trusted-origin approval URL, poll path,
expiry, and suggested polling interval. Treat all returned tokens and the
approval URL as credentials.

Poll, approve, and cancel calls must present the challenge token. Approval also
requires a signed-in board user; cancellation is token-authorized. Invalid,
expired, or unknown challenges do not reveal another challenge's state.

Useful self-service routes:

```text
GET  /api/cli-auth/me
POST /api/cli-auth/revoke-current
```

`revoke-current` requires the request itself to be authenticated by the board
key being revoked.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `AOA_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <AOA_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access companies where they have active membership
- Instance administrators have the documented global administration bypass
- Scoped users remain limited by their role and department/project grants
- Cross-company access is denied without revealing foreign data; some routes
  intentionally return `404`, while ordinary authorization failures use `403`

Authentication, onboarding, invitations, and Commander runtime sign-in have
separate authorities:

- [Onboarding API](./onboarding.md) — journey, progress, environment, profile,
  and join-finalization contracts
- [Team API](./team.md) — invite creation, resend/revoke, roles, and join
  approval
- [Commander API](./internal-agent.md) — Commander CLI login, key storage, and
  verification
