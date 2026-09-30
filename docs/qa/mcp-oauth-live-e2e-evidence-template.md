# MCP OAuth live E2E evidence

Use a disposable provider account/page. The founder performs provider sign-in;
the agent never receives the authorization URL, code, cookie, access token, or
refresh token.

## Build under test

- AoA commit:
- Marketplace artifact SHA-256:
- Deployment mode:
- UTC start/end:
- Tester:

## Prerequisites

- [ ] Stable authenticated-mode signing secret configured
- [ ] Exact public callback URI registered
- [ ] Test company and disposable provider content identified
- [ ] Emergency switch enabled and connector server name not denied
- [ ] Logs/evidence destination is access controlled

## Authorization and use

- [ ] Founder installed the exact locally generated marketplace entry
- [ ] Founder completed sign-in in the provider UI
- [ ] Callback reached terminal success for the same company/session
- [ ] Connector became active and was assigned to one test agent
- [ ] Tool listing succeeded
- [ ] One read-only search/read against disposable content succeeded
- [ ] Activity rows contain fixed reasons/IDs only and no credentials

## Refresh proof

- Connector ID:
- Company ID:
- Version before:
- Version after:
- [ ] Force-expiry dry run reviewed
- [ ] Force-expiry apply created exactly one new expired version and audit row
- [ ] First subsequent read created exactly one refreshed version/activity row
- [ ] Concurrent read did not create a second refresh version

## Cleanup and redaction

- [ ] Connector disabled/removed from test agent
- [ ] Provider grant revoked
- [ ] Disposable provider content removed
- [ ] Browser session/cookies cleared as appropriate
- [ ] Logs and artifacts scanned for authorization query strings/codes
- [ ] Logs and artifacts scanned for access/refresh tokens and cookies
- [ ] Logs and artifacts scanned for signing/secrets keys

Record only company/connector IDs, version numbers, fixed reason codes, counts,
timestamps, commit/artifact hashes, and redacted screenshots.
