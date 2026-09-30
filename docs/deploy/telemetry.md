# AoA Telemetry

AoA supports optional feedback-vote and plugin-telemetry transmission to a
customer-controlled HTTP endpoint. Disabled by default; when unset, all
payloads stay on the instance's local filesystem.

## Configuration

Set at deployment time (environment variables):

- `AOA_FEEDBACK_ENDPOINT` — HTTPS URL that accepts `POST` with a JSON body
- `AOA_FEEDBACK_API_KEY` — optional; when set, sent as `Authorization: Bearer <key>`

Unset `AOA_FEEDBACK_ENDPOINT` → local-only mode. Feedback bundles write to
`~/.aoa/feedback-exports/<exportId>-<timestamp>.json.gz`; plugin telemetry
events log at debug level and are discarded.

## Transmission semantics

### Feedback vote bundles

- Operator sets `AOA_FEEDBACK_ENDPOINT` + (optional) `AOA_FEEDBACK_API_KEY`.
- When a vote completes and the instance preference is `allowed`, the host
  builds the bundle (with redaction) and calls `shareFeedbackBundle`.
- If the POST succeeds (2xx), no local copy is written — operators who want
  an audit trail should tee on their side.
- If the POST fails (non-2xx or network error), the host falls back to the
  local-fs write path. Votes are never lost on transient outages.

Payload shape: `FeedbackShareBundle` envelope — see
`buildFeedbackBundle` in `server/src/services/feedback-bundles.ts`.

### Plugin telemetry events

- Plugins call `ctx.telemetry.track(eventName, dimensions)` from their worker.
- The host validates the event name (`/^[a-z0-9][a-z0-9_-]*$/`) and
  hands it off to `transmitPluginTelemetry`.
- If `AOA_FEEDBACK_ENDPOINT` is unset, transmission is a no-op; the host
  still logs the event at debug for local observability.
- If set, the POST is fire-and-forget with envelope:

```json
{
  "kind": "plugin_telemetry",
  "event": "sync_completed",
  "dims": { "attempts": 2 },
  "timestamp": "2026-04-23T10:30:00.000Z"
}
```

- The plugin never observes transport outcome — `track` resolves as soon as
  the POST is launched.

## Redaction & anonymization

AoA runs the full redaction pipeline (`feedback-redaction.ts`, 9 patterns:
PEM blocks / secret key=value assignments / bearer tokens / GitHub tokens /
provider API keys (`sk-*` prefix, catches both Anthropic and OpenAI keys) /
JWTs / DSNs / email / phone) **before** handing the bundle to
`shareFeedbackBundle`. Endpoints should not re-implement redaction; the
payload they receive is already scrubbed.

Identifiers that survive redaction are **anonymized**: each is replaced with
`{kind}_{sha256(pepper:kind:value).slice(0, 16)}` where `pepper` is an
instance-local secret. The same input always maps to the same anonymized
token within an instance, enabling cross-bundle correlation without
exposing raw values.

## Consent & privacy settings

Each instance has a `feedbackDataSharingPreference` field (on the `instances`
table) controlled by the instance owner. Three options:

| Option | Behaviour |
|--------|-----------|
| `allowed` | Bundles transmitted (or written locally when no endpoint set) automatically after each vote. |
| `ask` | A consent modal is shown before each bundle is sent. Founder approves or rejects per bundle. |
| `disallowed` | No bundles built or transmitted. Votes are stored locally only. |

The **PrivacyTab** in Settings shows the last 3 exported bundles (local path,
timestamp, status) so founders can audit what was sent.

**Plugin telemetry capability gate:** `ctx.telemetry.track(event, dims)` is
only available to plugins that declare `PLUGIN_CAPABILITIES["telemetry.track"]`
in their manifest. Plugins without the capability receive a no-op stub.

## Disabling

Unset `AOA_FEEDBACK_ENDPOINT` (or clear the variable and restart the server)
to return to local-only mode. No data in flight is lost — the fall-through
is the same durable local write that backs the fallback path.

## Notes for endpoint implementers

- Accept `POST` + `Content-Type: application/json`.
- 2xx → bundle consumed; AoA will not retry or persist locally.
- Non-2xx → AoA persists locally and logs the failure. Rate-limit responses
  (429) are not special-cased; they fall through to local the same way 5xx
  would.
- `Authorization: Bearer <AOA_FEEDBACK_API_KEY>` is present iff the env var
  was set at AoA startup.
- Envelope shapes (feedback vs plugin_telemetry) are disjoint — route on
  the `kind` field for `plugin_telemetry`; the vote envelope uses
  `schemaVersion: "paperclip-feedback-envelope-v2"`.

## Bundle envelope schemaVersion

The feedback vote bundle's `payloadSnapshot.schemaVersion` reads
`paperclip-feedback-envelope-v2` (and `bundleVersion` reads
`paperclip-feedback-bundle-v2`). **This is intentional wire-format
compatibility** with downstream feedback receivers originally built for
Paperclip bundles — AoA was forked from Paperclip and the telemetry
receiver wire format predates the rebrand.

Do not rename these literals without coordinating with the telemetry
endpoint operator. If you need to ship a new schema shape, cut a v3
constant (`aoa-feedback-envelope-v3`) alongside v2 and have consumers
pick the latest they understand.

The constants live in `server/src/services/feedback-bundles.ts`
(`FEEDBACK_SCHEMA_VERSION`, `FEEDBACK_BUNDLE_VERSION`) and are mirrored
in the `feedback_exports` table defaults
(`packages/db/src/schema/feedback_exports.ts`).
