# Universe notification review

Source review September 11, 2026. Recommendation: upgrade the existing hub notification foundation and add Universe presentation delivery; do not blindly inherit the current Commander switch or create a duplicate notification store.

## Actual behavior

- `server/src/services/internal-agent/proactive.ts`: company-level Commander preference `silent` returns before emitting certain proactive hub items. `digest` and `realtime` both emit the same item through this helper; it does not itself implement different delivery timing. A check run record may still exist, so this is not deletion of all evidence.
- `server/src/services/hub-items.ts`: emits deduplicated source items and queues per-user digest delivery based on per-type preferences and quiet hours.
- `packages/shared/src/notification-preferences.ts`: per-type delivery mode and toast toggle, quiet hours and digest configuration; no sound or spoken-delivery field.
- `ui/src/lib/hub-toast-bridge.ts`: suppresses toasts for closed items, silent/digest rules, disabled toasts and quiet hours. A toast toggle is not a speech policy. Missing rules suppress toasts.
- Inspected core server preference/proactive/hub files and shared preference schema have no diff from the locally available replatform tracking ref. This does not verify every producer or deployed behavior.

Thus the existing settings have different semantics, not simply one documented precedence rule. The earlier proposal to use the most restrictive switch everywhere is insufficient: creation suppression and delivery suppression must first be separated.

## Proposed changes

1. Keep durable actionable items and source identity in the hub. Silent delivery means no interruption, not preventing a useful item from existing. Independently control whether a proactive check runs or produces a suggestion. Preserve explicit opt-outs during migration; do not reinterpret old silent values as consent to new alerts.
2. Use a common recipient policy evaluator for delivery, with explicit channels: in-app toast, sound and voice. Keep record visibility/access separate. Quiet hours and temporary DND apply to unsolicited interruptions; they do not prevent an answer to a direct user question.
3. Add Universe delivery adapters for the attention feed and spoken announcements. Voice also checks the active conversation, whether the user is speaking, playback availability and prior delivery. Queue/coalesce routine updates; revalidate stale/resolved items before speaking. Do not narrate every progress event.
4. Keep essential blocked/approval state visible in the task and Inbox even when interruptions are silent. No automatic urgent override of DND without a defined policy.
5. Distinguish delivered/read/resolved and spoken/skipped states; reading or hearing an item does not resolve it. Coordinate delivery across devices to avoid duplicate spoken alerts while preserving shared task visibility.
6. Put common delivery settings with existing notification settings; Commander links to those rather than preserving an ambiguous second global switch. Universe owns local presentation preferences only. Default new sound output off; any migration preserves existing delivery preferences.

## Verification

Executed the existing UI hub-toast-bridge suite: 5 tests passed. This checks current toast behavior only. No server suite, full typecheck/build or Universe integration tests ran; changes in this review are documentation-only.

Required implementation tests: silent mode retains eligible hub item without unsolicited output; direct responses remain possible in quiet mode; company isolation; migration of prior silent/digest values; same-item deduplication across devices/reconnects; resolving before queued speech suppresses it; speech interruption does not lose the item; policy revocation disables delivery; digest and realtime paths use the same policy definition.

No additional product answer is required now. Exact migration and delivery-ledger schemas must be designed against the existing services before implementation.
