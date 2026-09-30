> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Panel registry and Commander capability bridge — proposal

Complements the [request contract](request-contract.md) and [state contract](state-contract.md). This is a logical contract; no executable API or generated-code runtime is shipped by this document.

## Registry

The [UI lifecycle specification](ui-review-decisions.md#u04--shared-panel-lifecycle) governs all registered renderers. Keep one authoritative panel instance/controller across task, attention, artifact, browser and source-link entry paths. Preview tiles contain presentation data, never copies of live panel headers/actions. Pin preserves Commander placement; minimize retains registry state; close removes the view without cancelling canonical work. Renderer-specific content does not redefine those meanings. The task renderer follows [U06 task conversations](ui-review-decisions.md#u06--task-conversations-and-materials).

### September 11: hosting direction

Agreed direction: trusted AoA panels render as application components; custom generated executable interfaces run isolated with a controlled capability bridge. React Flow supplies placement, not the trust boundary. Detailed defaults below are engineering recommendations to verify during implementation.

| Content | Hosting | Authority |
|---|---|---|
| Existing task chat, approved viewers, AoA forms | Registered first-party React components | Existing authenticated APIs and server permission checks |
| Generated composition of reviewed blocks | Schema-validated data interpreted by registered renderers | Only named, granted capabilities; no executable expressions or arbitrary component imports |
| Generated HTML/JavaScript tool | Sandboxed iframe on a dedicated untrusted-content origin | Per-instance host bridge; no application credentials or ambient APIs |
| Controlled browser session | Dedicated browser-view adapter | Replatform session ownership and pause/resume rules, independent of iframe sandboxing |

A composition is trusted code rendering untrusted data. Sanitize rich content and validate URLs, bindings and action parameters; component registration never makes supplied values trustworthy. Prefer this path for standard charts, tables, forms and calculators. Use the isolated runtime for custom executable interfaces.

### Sandbox and bridge defaults

Serve generated content apart from the application origin, without shared cookies. Grant script execution only where required; withhold same-origin privileges, forms, popups, top navigation, downloads and device permissions by default. Enforce a restrictive CSP and explicitly permitted resources; sandbox flags alone do not block network traffic or bound CPU use. Package reviewed assets instead of permitting arbitrary remote scripts. Exact deployment headers and egress controls require an integrated security test.

The host establishes a fresh MessageChannel for each renderer generation through a narrowly validated bootstrap. Bind it to the expected frame, instance and handshake; opaque-origin identity alone is insufficient. Close the old channel on navigation, reload, revocation or disposal. Treat every message as untrusted even over an established port.

Messages carry protocol version, instance/generation, request identity, state revision, named operation and bounded payload. Host-controlled identity and granted capabilities determine scope. Validate schemas, size and rate before dispatch; server authorization is repeated for domain access. Expose context updates, permitted reads, state checkpoints and action requests only. Return durable status through the shared request contract; channel delivery is not action completion. A replay cannot create a second write.

Downloads, external navigation and attachment selection use host-mediated operations. Do not expose cookies, bearer tokens or Secrets values. Suspend data delivery immediately on revocation; previously delivered data cannot be retroactively unread.

Sources: [iframe sandbox behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [cross-window messaging](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage), [channel messaging](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API/Using_channel_messaging).

### Failure and rendering lifecycle

Give each first-party panel an error boundary. Keep drafts/checkpoints outside renderer-local state. Generated tools receive bounded inputs and produce bounded checkpoints; failure preserves the last accepted checkpoint and canonical artifact. Do not promise iframe process isolation or reliable CPU termination solely from removing an iframe: evaluate stronger isolation for workloads that can freeze the UI; disallow such workloads until supported. Keep background jobs outside panel lifetimes.

Opening, focusing or restoring content must not implicitly submit an action. A generated tool's edit produces a new artifact version; state migrations preserve inputs or offer the prior version. Host overlays must remain distinguishable from generated content so an embedded fake approval cannot authorize real work.

Additional acceptance cases: frame replacement invalidates its channel; forged instance/actor fails; disallowed network and navigation attempts are blocked; channel replay does not repeat writes; revocation stops reads/actions; renderer failure preserves checkpoints; malformed declarative compositions cannot introduce executable code. Test actual iframe headers and messaging in browser integration tests, not only mocked unit handlers.

Each reviewed panel type declares a stable type identifier and version, input schema, saved-state schema, supported data bindings, context projection and allowed action identifiers. Define renderer lifecycle, accessibility behavior, resource bounds and migration/unsupported-version handling. Registration is controlled by application deployment or a reviewed extension mechanism; model output cannot register arbitrary privileged code.

Commander produces a validated composition referencing registered types. The host rejects unknown types, invalid arguments and unsupported capabilities with a useful fallback. Existing task/document/artifact bodies remain preferred over generated copies of established interfaces.

## Three distinct interaction paths

1. **Local interaction:** filtering, selecting and calculating update panel state without a model call per gesture. Save bounded state through the state contract. Scenario calculations never mutate canonical records.
2. **Context projection:** expose relevant selected references, current input values, source versions and displayed result summaries to Commander. Projection is bounded, permission-filtered, revisioned and fetched at utterance/action submission. Do not copy full data sets or hidden fields by default. Treat panel content as untrusted data, not executable agent instructions.
3. **Domain action:** an explicit user instruction, button or previously authorized routine invokes a named domain capability through the shared request gateway. The server rechecks principal, company, target access and approvals. A panel declaration requests capability; it does not grant it. Return accepted/progress/result states with correlation identity.

Example: changing headcount updates a calculator locally. Asking why the scenario is expensive supplies the selected calculator revision to Commander. Choosing to create hiring tasks submits a governed action. No separate write implementation is introduced inside the calculator.

## Data bindings

Bindings specify source reference, snapshot version or live query, permitted fields, refresh state and last successful update. Live changes do not overwrite edits. Show stale/unavailable/error state honestly. A write based on an old record version uses existing concurrency controls and offers review on conflict. Opening or restoring a panel never automatically runs a write.

## Isolated custom interfaces

Custom generated code runs outside the trusted application origin with restricted network/resource access and no inherited credentials. Communicate through a host-established channel bound to the exact panel instance and capability set; validate message schema, sender/channel identity, size, sequence and rate. Use exact origin checks where applicable; an opaque sandbox origin requires source/channel binding, not trusting the string null. The host chooses targets and grants; panel-supplied user/company identity is never authority.

Only expose narrow operations for approved data queries, saved state, context updates and action requests. Never provide arbitrary SQL, unrestricted fetch, raw secret lookup or generic server execution. Resource abuse terminates the renderer without cancelling unrelated jobs or losing canonical artifacts. Preview sanitization and generated-code isolation are separate controls.

## Evolution and failure

Maintain separate instance identity, panel-type version, state revision and artifact version. Schema migration preserves user inputs where possible; incompatible updates retain the previous version and expose recovery. Unsupported formats offer canonical-file download or external-open fallback. Detaching a renderer cancels only its own subscriptions and ephemeral resources; it does not revoke shared task identity or terminate background execution.

Permission revocation disables affected actions and invalidates data bindings. Already cached offline data has the limitations documented in the state contract. Audit mutations with initiating user, executing actor, source panel/conversation and canonical request identity; do not log secrets or unnecessary raw content.

## Acceptance cases

- Invalid composition/type/schema fails without executing code.
- Cross-company targets and forged actor identity fail server authorization.
- Two panel instances retain separate state and message channels.
- A stale context revision cannot silently redirect an action to another selected item.
- Repeated button submission uses request deduplication; reload does not execute it again.
- Scenario changes never invoke a domain write; explicit writes preserve existing approval rules.
- Generated messages cannot escape capabilities or inject trusted instructions.
- Live refresh preserves edits and makes source conflicts visible.
- Renderer failure/suspension preserves recoverable input and leaves server work intact.
- New panel versions migrate safely or retain a usable previous version.

The artifact contract and format matrix specify the related ingestion/preview lifecycle. This proposed capability bridge remains unimplemented; its acceptance tests must run against the integrated host and isolated renderer.

## Geometry history and stable ordering

E1.1 owns [the explicit undo/redo contract](coding-plans/e1-1.md#undo-and-redo-contract): one entry per completed geometry gesture, 50-entry bound, scope/generation/current-rect fences, redo invalidation on new edits, and a new E1.2 CAS operation for each replay. Content/actions never enter layout history. `openedOrdinal` orders overview tiles independently of z-order; E1.2's persisted allocator never rewinds on undo. Client and server coordinate bounds both use ±1,000,000.
