> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Canvas state and draft recovery — proposed contract

Extends the [architecture map](architecture-map.md). This specifies intended behavior, not shipped persistence. Exact tables and endpoints remain to be designed with existing shared contracts.

## Ownership and stored state

A personal canvas belongs to a company, user and Commander conversation. Store schema version, revision, viewport translation/zoom and stable panel references; geometry, stacking, pin intent, manual placement, selected/focused references and tucked-away state. Resolve content through authorized domain APIs rather than copying task/artifact bodies into the layout.

Drafts are separate records keyed by user, conversation and destination composer. Two task composers never share a draft by incidental panel position. Store draft revision, text and authorized attachment references. Submitted messages remain owned by the conversation/task service. Clear a draft only on durable submission acknowledgement, preserving any text typed after that submission snapshot.

Provider credentials, browser cookies and raw audio never belong in the canvas document. Media playback position can be persisted; execution/controller authority cannot be inferred from saved UI state.

## Autosave operations

Use validated bounded operations with operation identity, expected document revision and target panel identity. Batch/debounce transient drag movement; flush the final placement. Persist draft checkpoints independently. Server atomically checks authority and revision, applies the operation and returns the new revision. Repeated operation identity returns the prior result; different payload with the same identity conflicts.

For concurrent edits, independent panel/property changes may be rebased after retrieving current state. Conflicting changes to the same property require deterministic resolution with recoverable prior state. Never silently replace an entire document from a stale tab. Concurrent text drafts preserve both variants and offer recovery; do not silently concatenate or overwrite text.

Expose saving, saved, offline and conflict states unobtrusively. A browser-close callback is best-effort and cannot be the only persistence mechanism. Server validation bounds panel count, coordinates, payload size and supported schema versions.

## Disconnect and restore

When permitted by retention policy, keep a bounded local pending-operation/draft journal partitioned by account/company/conversation. Do not describe browser storage as inherently secure. Define cleanup on logout/account switch, expiry, revocation and shared-device use. Offline availability is limited to deliberately cached content; revoked server access cannot be retroactively erased from an already offline device with certainty.

On return, fetch authorized state, reconcile unacknowledged operations by identity, and recover drafts before showing saved status. Re-resolve references; unavailable content must not leak through old previews. Reconcile pending submitted messages through the request contract rather than posting the draft again.

Preserve logical arrangement across viewport changes and constrain it to usable screen bounds. Keep original placement intent available so opening on a small screen does not permanently destroy the desktop arrangement. Reconnect live browser/media sessions only after checking their actual existence and permissions.

## Rendering lifecycle

Hidden renderers may suspend expensive work after checkpointing local state. Their canonical jobs continue. Required state/event reconciliation belongs above the renderer lifecycle. Renderers restore from versioned state; obsolete versions migrate or present a recoverable unsupported-version state. Loading a saved generated tool must not execute mutating actions automatically.

## Acceptance cases

- Reload during save; retry preserves one operation and correct saved feedback.
- Two tabs edit different panels; both changes survive. Same-field conflict remains recoverable.
- Two composers and two conversations keep drafts isolated.
- User submits then continues typing before acknowledgement; only the submitted snapshot clears.
- Offline reconnect does not post a draft or replay a domain action automatically.
- Permission revocation/deleted source displays unavailable state without cached preview leakage on authorized refresh.
- Changed viewport preserves usable placement and original layout intent.
- Hidden renderer remount preserves inputs without rerunning effects.
- Old schema migration, excessive payload and invalid coordinates are handled explicitly.

See the panel contract for the capability bridge and code-evidence.md for existing viewer tests. The proposed durable canvas storage has not yet been implemented or integration-tested.

## Layout round-trip binding

E1.2 persists viewport, order and selected/maximized presentation alongside panel geometry. E1.1's AuthorizedLayoutSnapshot carries all of them; hydrateLayout restores registry state and viewportFromLayout initializes the separately controlled camera from the same revision. Explicit presentation operations and final candidate invariants are defined in [E1.2's write/read contract](coding-plans/e1-2.md#complete-layout-writeread-contract). Hydration and display-only clamping do not save new layout changes; camera/focus conflicts use the same acknowledged revision and receipt protocol.
