# Universe voice/media policy and implementation-planning addendum

> **Planning only.** Use superpowers:executing-plans only after TK explicitly authorizes a bounded implementation batch. This proposal does not amend locked decisions, approve provider terms/spend or run qualification.

**Goal:** Finish D3's concrete review packet for the three V1 voice providers and V1 image/audio/video generation while preserving Commander as the work authority.

**Architecture:** Existing Providers/Secrets/Budget owners supply purpose-scoped access to trusted audio/media adapters. AoA owns conversation identity, permissions, tasks, approvals, durable outcomes and publication. Provider sessions are replaceable; no direct model-provider credential reaches work panels or model-generated code.

**Tech stack:** Existing TypeScript, Express, React, Drizzle and test harnesses. Vendor HTTP/WebSocket/WebRTC contracts from the [September 12 evidence](voice-media-provider-evidence.md); SDK/version installation remains part of separately authorized qualification.

**Spec:** [D3](final-planning-decisions.md#d3--voicemedia-permitted-paths), [E3.1](coding-plans/e3-1.md), [E3.2](coding-plans/e3-2.md), [E3.3](coding-plans/e3-3.md), [E4.3](coding-plans/e4-3.md), [E8.1](coding-plans/e8-1.md). Source pin: 183e46a9c65fc3105c7e3d125629276814df7dbb.

## Proposed narrow amendment for acceptance

Allow explicitly enabled capabilities voice.realtime, media.image, media.audio and media.video to invoke only reviewed vendor audio/media operations using the selected company-owned connection. These names are proposed policy capabilities, not existing provider enums. No capability permits ordinary agent/Commander/extraction execution through general hosted model APIs. Preserve Decisions #91/#104/#117 and the deployment-specific CLI and sandbox rules.

A trusted protocol broker may issue session credentials, relay bounded audio/control messages and call fixed media endpoints. In cloud_auth it is trusted application infrastructure, not a shared-host shell, arbitrary URL proxy or model-code runtime. Executable processing and ordinary Commander work retain their actual isolated execution path. Supporting a provider's media API does not authorize that provider's search, code execution, general tools, cloud file store or autonomous task mutation.

Only actor-authorized context selected for this conversation or immutable generation sources may leave AoA. No complete workspace dump, hidden panel contents, browser cookies, CLI credentials or secret-bearing attachments. Provider-suggested tool calls are untrusted input to the normal governed Commander admission path.

Support is evaluated per capability, connection, model, region and deployment mode. An unsupported path is unavailable with a reason; no silent fallback to another account, model, provider or less restrictive privacy policy. All three voice providers and media families remain V1; inability to qualify one is a release dependency, not scope reduction.

## Accepted privacy baseline and settings

Privacy baseline accepted by TK on September 12, 2026: a company admin explicitly enables a provider after seeing its current retention, training-use, subprocessors/region and commercial-use terms. AoA recording defaults off; transcript retention follows the existing conversation policy. Verified stricter company requirements override user preferences. AoA does not impose verified zero provider retention universally; companies may require it as a stricter policy. TK confirmed that disclosure, admin acceptance and these company privacy requirements belong in the same Providers voice-configuration area as connection and readiness settings. This accepts the product behavior, not any actual vendor terms, account activation or provider spend.

Settings remain in their agreed locations:
- Providers: connection, enabled capabilities, model/voice availability, region/retention disclosures and explicit readiness checks. A saved key or CLI login alone is not ready voice.
- Secrets: encrypted key/reference and auditable purpose binding.
- Budget & caps: spending/admission policies and usage. No copied budget editor in Providers or Universe.
- Universe: appearance, voice selection, device-local preferences, independent captions, mic/speaker state and remembered view layout.
- Commander page: shared speaking style/brevity/progress defaults, subject to personal reduce-only interruption preferences.

No microphone or paid check occurs when opening Settings. Start voice requests capture explicitly. Readiness distinguishes configured, policy-unapproved, qualification-required, available and unavailable; these are proposed capability states, not replacements for canonical connection states.

## Credential and source bindings

The [review corrections](voice-media-review-corrections.md#m1--protect-the-secret-at-the-common-resolver) add persistent voice_media secret classification and common-resolver enforcement. Binding presence or broker discipline alone is insufficient. Restricted classification survives unbinding and rotation; legacy shared secrets are not silently converted.

Pinned evidence:
- packages/shared/src/providers/provider-catalog.ts owns Providers metadata; catalog Google id is google, while the voice adapter id is gemini. Use an explicit mapping. ElevenLabs needs catalog registration without registering a CLI execution adapter.
- packages/db/src/schema/provider_connections.ts supports api_key/personal_subscription/enterprise_gateway and secretRef. Organization-level records also exist; this proposal does not automatically grant every organization member voice access.
- server/src/services/provider-connections.ts verifies terms and connection state; personal_subscription is forbidden on shared hosted installations. A subscription connection cannot satisfy a speech/media API-key requirement.
- server/src/services/secrets.ts resolveSecretValue checks company/status and audits resolution. shouldEnforceSecretBinding exempts system/plugin and missing configPath cases; it is NOT universally a strict purpose guard.
- server/src/services/budgets.ts getInvocationBlock handles canonical admission policy. server/src/services/budget-hooks.ts is an in-process signal, not durable cross-worker revocation or a reservation primitive.

**Proposed binding:** E8.1 owns adding provider_connection to SECRET_BINDING_TARGET_TYPES, mapping companySecretBindings.targetId to the actual connection ID and configPath to the exact reviewed capability. Extend validation/server checks together. The broker must explicitly require an existing matching binding before resolution, with server-derived company/actor/connection/purpose; omitted path, mismatched secretRef or generic system/plugin consumer is rejected. Preserve legacy exemptions for general secrets only; restricted voice/media secrets are checked before those exemptions. Do not borrow MCP OAuth ownership to bypass them. Only the authorized connection-management path can create/revoke this binding.

An org-shared connection must pass its canonical sharing checks and actual vault-company boundary; do not fake a companyId to satisfy the resolver. If not supported, that connection remains unavailable for this capability while company-owned connections can qualify. owner_only cannot silently become company-wide; broader human-user delegation needs the actual provider-sharing permission extension reviewed under E8.1. No raw key is put in prompts, logs, layouts, localStorage, tool results or browser frames.

Direct browser tokens remain bearer secrets. Session issuance binds user/company/conversation/connection/model/policy version and current scope. Recheck authority on reconnect, delegated action and result disclosure. Provider expiry is not immediate revocation. If AoA cannot remotely terminate or bound a direct session after revocation/budget stop, use an approved controlled relay or leave that transport unavailable.

## Connection and outcome contract

Reuse E3.1 VoiceCorrelation and E2.2 submission/outcome ownership. Proposed E3.1 runtime record universe_voice_sessions stores company/user/conversation/connection, provider/protocol/model, policy version, current generation, owner lease, non-secret provider session reference, state, stop reason, usage status and timestamps. Proposed uniqueness is (companyId, userId, startRequestId) with immutable payload hash, plus one nonterminal voice owner per (companyId, userId) across tabs. Same-key changed payload conflicts; explicit takeover stops/reconciles the prior owner before admission. The proposed database mechanism is a unique (companyId, userId) index WHERE terminalAt IS NULL, with a state/terminalAt consistency check; reserved/starting/unknown/ending all retain ownership. The [session correction](voice-media-review-corrections.md#l1--database-enforced-voice-ownership) defines transactional admission, fencing and takeover. These are required mechanisms to test, not demonstrated duplicate-session prevention. This is a proposed application-scoped transport lifecycle record, not another task ledger.

Bearer resume handles/signatures are kept in a qualified encrypted ephemeral store with expiry, separate from the record's public projection. On crash where the handle cannot safely be recovered, end/reconcile the old session and offer a new explicit connection; do not create another paid session while the old outcome is uncertain. Owning service must have provider-specific active-session stop/reconciliation evidence before enablement.

| Event | Required effect |
|---|---|
| Start | Authorize and check policy/budget/concurrency before vendor admission; request mic only after user action; persist start identity before network call |
| Connected | Render connected only after provider acknowledgement; listening/speaking indicators use capture/playback, not blob visibility |
| Mic mute / speaker silence | Independently gate outbound mic frames / local playback; neither promises the provider stopped billing |
| Barge-in | Stop old playback immediately, advance playback generation, send qualified provider interruption/context correction; do not cancel committed Commander work |
| End | Stop capture/playback immediately, persist ending and request provider closure; reconcile final usage. End acknowledgement/usage may remain unknown; retain blob if visible |
| Hide chat/blob/captions | Change presentation only. Keep active-voice controls discoverable in the tray |
| Network loss | Stop unsafe playback, preserve draft/history, show reconnect state; read canonical outcomes before any replay |
| Conversation switch | Fence old events and private context; stop/reconcile old voice ownership before another conversation session; work results stay with the original authorized request |
| Permission/budget loss | Durable stop request to session owner; deny new disclosure/admission; worker/process reconnect checks stop state even if a local event was missed |
| Duplicate tool/final transcript | Resolve one immutable E2.2 submission; payload conflict does not generate a second task |

Do not equate provider utterance, spoken response, Commander request, audio playback and published artifact completion. Use separate identities. Prompt instructions cannot prove a voice model never hallucinates success: only verified canonical result is delivered as a completion result, and guarded playback/caption behavior must be tested. A frontend that cannot satisfy the agreed truthful-work experience remains unqualified.

Long work: return only canonical acceptance/queued status promptly, then deliver a separately correlated confirmed outcome. Context-only updates are not guaranteed spoken notifications. Preserve Inbox/attention timing; silent or summary policy suppresses unsolicited speech, without disabling answers the user requests. GPT-Live, Realtime, Gemini and ElevenAgents must each prove this sequence through their own protocol.

## Budget, revocation and retention

Use Budget & caps for admission and cost records. E8.1/1 delivers the explicit BUDGET-VOICE-MEDIA prerequisite under the canonical Budget service owner; E3.1 owns durable session-stop consumption. The [budget correction](voice-media-review-corrections.md#m2--shared-budget-producer-and-schedule) defines scope, files, accounting, scheduling and hard enablement gates; the local emitter is only an optimization. Every active owner periodically revalidates its lease and stop state, with intervals and provider limits fixed in the approved qualification configuration. Before enabling a transport, specify maximum unobserved billable exposure, stop latency and concurrent-session bound accepted by the budget owner. No claim of exact zero overspend from delayed provider usage.

Prevent concurrent admissions from all passing one stale balance check: the budget owner must bind atomic capacity/reservation accounting or a proved bounded alternative to the session record. Existing getInvocationBlock alone does not establish reservation. Preserve the canonical hard-stop policy; if a provider cannot meet it within its accepted billing granularity/exposure, do not enable that path.

Reconcile observed versus estimated usage under an idempotent provider-session/event key; include voice frontend plus Commander/backend and relay costs without double counting. Mute, hidden UI and pending tools can still incur provider cost. The budget amount for paid qualification remains unapproved.

AoA transcript retention on follows the existing conversation owner; raw audio recording off means no application recording, diagnostic payload or crash dump. Relays still process audio in memory, so disclose that path. Requested recording is separate explicit opt-in and requires an actual retention/deletion implementation. Provider recording/history must be configured and verified independently; account tier, policy version and receipt of admin acceptance are stored as non-secret capability evidence. Do not silently copy private data into a provider knowledge base.

## Media operation and recovery boundary

E4.3 owns governed image/audio/video admission and exact source/version context. Use the dedicated reviewed operation only. Suggested initial qualification order: image generation/edit, audio narration, video; other retained media capabilities remain individually tracked. Sora is excluded for its documented impending shutdown; Veo is a video candidate. Neither vendor selection nor published prices authorize calls.

Persist canonical submission before network admission. If a vendor returns an operation ID, record it durably and poll only its read-only status. If the POST acknowledgement is lost before an ID exists, unknown means unknown: no automatic new billed generation. Known rejection/no effect or an explicit new attempt after explaining possible duplicate cost is required for retry.

Completed output must pass the worker/publication protocol where executed through distributed workers, with E2 accepted-output binding, exact bytes, permitted lineage, company destination and E4 canonical version receipt. A proposed direct media broker cannot bypass these owners or create a shadow job queue; its admission and output producer must be explicitly bound before enablement. Remote output expiry requires bounded copy and validation; exceeding existing 50 MiB output cap reports unavailable/limit without claiming artifact readiness. Preserve the authorized outcome reference, never invent a completed file or auto-download beyond quota.

No automatic public sharing, cloned voice, live camera or screen capture is added. Requested source media needs upload/source permission; a provider's support for a modality does not enable it in voice sessions.

## Files, ownership and acceptance increments

All are planning outputs until implementation approval. New schema uses Drizzle generation and shared exports; no hand-written schema DDL or SDK install now.

| Existing increment | Concrete obligation / files |
|---|---|
| E8.1/1 | Policy capability types/validators and explicit provider-id mapping; proposed packages/shared/src/validators/voice-media-policy.ts; extend packages/shared/src/constants.ts, providers/provider-catalog.ts and companySecretBindings validation under its actual owner |
| E8.1/1 producer; /2 UI | Existing Providers/Secrets server authority first, UI later: server/src/services/provider-connections.ts and secrets.ts; proposed server/src/services/voice-media-credentials.ts plus server/src/__tests__/voice-media-credentials.test.ts; mandatory binding, terms, sharing, revoked-state and missing-path denials |
| E3.1/1 | Compare documented OpenAI Realtime and GPT-Live client delegation without swapping accepted backend; freeze one protocol/model/transport, evidence and budget/stop parameters. Record in the existing planned voice-openai-qualification.md after authorized trials |
| E3.1/2 | Existing proposed voice/openai.ts and shared voice types; proposed packages/db/src/schema/universe_voice_sessions.ts, server/src/services/voice/session-registry.ts, server/src/services/voice/budget-lifecycle.ts and server/src/__tests__/voice-session-authority.integration.test.ts. Bind schema, admission lease/idempotency, durable end/revocation and usage to actual budget owner |
| E3.2/1–2 | Existing voice-state.ts, useVoiceSession.ts and transcript-reconciliation.ts owners: Start/End/mute/playback/view independence, generation fences and canonical outcome replay; no API-family event blending |
| E3.3/1 | voice/gemini.ts: initially controlled server WebSocket relay; qualify synchronous-call accepted/later-result behavior and resumption; native browser token optimization separate |
| E3.3/2 | voice/elevenlabs.ts: controlled authenticated session, configured agent privacy and governed delegation; no unauthenticated custom-LLM Commander bridge |
| E4.3/2 | Existing universe-generation.ts and generation-qualification.md: individual media endpoint/credential/source/output/budget/license/region/idempotency records; no second outcomes table |
| E2.2 / CMD | Canonical actor/context/submission/result and real distributed route; policy amendment cannot manufacture E10-F001 prerequisites |

E8.1/1 publishes the credential/policy producer independently of completed settings UI; E3 consumes it, and E8.1/2 later wires consumer controls. Do not introduce a completed-E8-UI ↔ E3 dependency cycle.

Proposed session start/end interface belongs in E3.1's shared voice contract, not a second public API defined here. Before coding that increment, reconcile its exact signatures and unique keys with the existing E2/E8 producers in the bounded plan. Existing 31 slices/69 increments and release allocation are unchanged.

Acceptance tests supplement the existing E3/E4 cases: wrong-company issuance; missing purpose binding even through system consumer; disallowed org-shared key; stale terms/model/policy; double Start/lost ACK; missed in-process stop event; two server owners/concurrent budget admission; shutdown without final usage; malicious client session override; signed URL reuse; active-session revocation; late context in another conversation; delayed result under each provider; media POST uncertainty; expiry before copy; same output two publication attempts. Use real authenticated application paths, captured sanitized provider fixtures and subsequently approved live trials. No stub-only test certifies capture, budget exposure, deletion or active vendor termination.

## Self-review and decision record

Author review corrected generic Secrets binding assumptions, process-local budget signalling, provider-ID mapping, temporary-token revocation assumptions, protocol-family mixing, media retry uncertainty and Sora selection. No universal SDK, region, zero-retention guarantee or paid trial is asserted.

Ready now: concrete narrow amendment, evidence, recommended paths, ownership and test mapping for review.
Accepted by TK: the privacy baseline and its location in Providers voice configuration. Still awaiting acceptance: the exact amendment/relay data path as proposed. Privacy acceptance does not authorize implementation, runtime qualification or actual provider terms.
Awaiting engineering qualification: account-level capability/retention proof, accepted budget exposure, exact active-stop and CMD bindings, final protocol/SDK version and runtime evidence.
Next: focused review of the [three material corrections](voice-media-review-corrections.md), then resolve remaining technical acceptance; prepare bounded BASE/DESIGN authorization separately. Implementation remains paused.
