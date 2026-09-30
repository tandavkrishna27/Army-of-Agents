# Universe settings and voice configuration

September 11, 2026. Defined product direction with recommended engineering defaults; not implemented settings.

## Navigation and ownership

Use the existing Settings > Providers destination for voice providers. Do not create a competing provider catalog within Universe. Local code in `ui/src/components/settings/sections/ProvidersSection.tsx` currently requires a selected company and focuses on CLI installation/login/readiness. `InstanceSettingsPage.tsx` is a separate instance settings surface. Therefore the user's reference to site Providers must not be interpreted as making company credentials globally visible.

| Surface | Configuration | Scope |
|---|---|---|
| Settings > Universe, linked from the canvas | Theme inheritance/override, dock placement and hiding, Commander placement, captions, motion, default layout behavior, personal speech preferences | User preferences within company; device-specific hardware selections kept device-local |
| Commander agent page > Voice behavior | Shared speaking style, brevity, progress announcement defaults, optional reviewed voice instruction text | Commander configuration, editable by existing authorized agent administrators |
| Settings > Providers | Connected voice capabilities, configuration/readiness, permitted models, credential references and usage links | Company connection and access scope |
| Instance/site administration, where applicable | Operator-managed provider availability and policy; managed service offerings | Instance policy, without exposing one company's connections to another |

Universe navigation label and collapsed tooltip are **Universe** with an icon. Global theme is inherited by default; a personal Universe override must be explicit and resettable. Save experience preferences independently of per-conversation canvas positions. Resetting preferences must not delete conversations, files or drafts. Device mic/speaker choice must not blindly sync an unavailable device identifier to another machine.

## Provider presentation

Correction confirmed from `SettingsLayout.tsx` and `SettingsPage.tsx`: **Settings > Budget & caps** is the existing separate destination for budget/cap configuration. Keep voice and cloud spending limits there; Providers must not duplicate their editors. Any usage/budget references below mean navigation links to the owning surface, not controls owned by Providers. This supersedes the conversational suggestion to put usage limits in Providers.

Extend shared provider identity with separate capability connections: agent execution, realtime conversation, speech recognition and speech synthesis. A vendor may have several capabilities under one provider entry. CLI sign-in does not prove access to that vendor's paid speech API; never show voice ready solely because the CLI is ready.

Each voice capability shows: configured/enabled status; connection owner and scope; approved model/voices; supported versus validated languages/features; last check and failure reason; credential reference; applicable region/retention disclosure; usage and budget links. Show managed versus customer-connected billing where supported; commercial allocation remains a separate decision. Never display raw credentials in general settings responses.

Offer capability-specific connection tests on demand. Loading Settings must not start microphones, create a billable live session, or trigger a provider-wide probe storm. Reuse existing provider readiness presentation where appropriate, with new API-backed capability types rather than pretending hosted speech uses CLI login semantics. Do not invent provider language guarantees; retain multilingual availability with tested combinations clearly identified.

OpenAI realtime is first in implementation order; Gemini and ElevenLabs realtime remain intended integrations. Separate recognition/synthesis and local speech are later planned approaches. Unsupported adapters appear as unavailable/planned rather than usable controls. Universe chooses among enabled permitted capabilities; it does not store duplicate keys.

## Voice instructions and precedence

The realtime layer requires presentation and handoff instructions distinct from Commander's work instructions. Application-owned rules define authoritative work routing, confirmed-result reporting, interruption/cancellation boundaries and destination identity. User-authored text cannot override server permissions or these contracts.

Show editable speaking preferences in understandable form: voice, language preference/automatic mode, response length, announcement frequency and optional personal text such as a preference for concise explanations. Authorized administrators can inspect/edit the shared voice style section on Commander. Explain inherited versus personally overridden settings and provide reset-to-inherited. Do not expose raw runtime prompts, secrets or internal routing payloads as the ordinary preference editor.

Effective behavior combines application rules, company restrictions, Commander shared defaults, personal preferences and temporary session controls. Permissions are enforced outside prompts. Personal speech style cannot broaden an agent's access. Temporary mic mute or silenced playback is not a permanent shared agent change.

Transcripts are retained by default under retention policy; AoA raw audio recording requires explicit opt-in. Provider retention is separately disclosed. No setting may promise zero usage merely because the microphone is muted. Provider switching closes the old audio context and re-establishes the selected conversation; do not migrate live authority or silently replay pending actions.

## Acceptance cases

## Field specification — recommended defaults

Notification follow-up: the [code review](notification-review.md) found that Commander silent mode can suppress creation of proactive hub items, while Inbox preferences govern delivery. Do not apply the provisional most-restrictive precedence below as final architecture. Separate event creation from delivery, migrate existing intent explicitly, and add sound/voice channels to the shared delivery policy rather than treating a toast toggle as voice policy. Direct responses to the user's questions are not unsolicited alerts.

These defaults complete the planning specification; they do not change running configuration. Existing saved preferences win during migration. Personal fields below are editable by their owner and scoped to user + company unless noted. Immediate presentation changes never mutate work. Policy can restrict available values. A reset clears only overrides in the named section and shows the effective inherited values.

| Field | Values / default | Applies / reset |
|---|---|---|
| Universe theme | Inherit app (default), system, light, dark | Immediate within Universe; reset to inherit, do not change global theme |
| Content density | Comfortable (default), compact | Immediate; preserve panel geometry |
| Motion | Subtle (recommended default), full, reduced | Immediate; OS reduced motion always respected; exact motion tuning remains review work |
| Dock placement | Top only for initial version | Other edges deferred; keep controls reachable on viewport resize |
| Dock hiding | Always visible/expanded (default), auto-hide | Immediate; AoA logo manually toggles collapse; hover does not undo deliberate collapse without re-entry |
| Commander placement mode | Automatic (default), manual | Immediate; reset returns automatic; actual coordinates are canvas/device layout state |
| Conversation presentation | Compact input (default), expanded history; maximize is an action, tuck is visibility | Immediate; retained draft; Compact leaves maximized geometry and returns to bottom |
| Blob visibility | Shown (first-use default), hidden | Independent of chat, captions and voice; menu restores; never starts mic |
| Chat visibility | Shown (first-use default), tucked | Independent of blob/captions; tray restores or tucks frontmost chat |
| Captions | Visible (default), hidden | Immediate; transcript remains accessible |
| Caption size | Standard (default), large | Immediate; browser text scaling still works |
| Caption placement | Bottom-center (default), below blob | Immediate; above compact input; expanded history incorporates live text without duplication; recommended hidden-blob fallback is bottom-center |
| Restore workspace | Restore previous arrangement (default), start in overview | Next open; never delete saved layout when changing preference |
| Open-panel previews | Auto (default), always show, hidden | Auto shows only minimized/off-screen open items; complete registry remains in tray |
| Attention previews | Auto (default), always show, hidden | Canonical Needs you/Ready/Coming up; hidden preserves Inbox access |
| Accent | AoA brand red (branded default), curated accessible accents | Immediate; no global app-theme replacement or layout reset |
| Blob style | Fluid (default), orbital rings, minimal glow | Immediate; controls/voice state independent of decorative style |
| Blob color | Match accent (default), separate curated color | Immediate; reset to match; muted/connection states remain legible |
| Canvas grid | Subtle dots (default), fine lines, none | Immediate; presentation only |
| Grid intensity | Low (recommended default), adjustable bounded intensity | Immediate; numeric range to qualify for contrast in all themes |
| Snap to grid | Off (recommended default), on | Next manipulation; no unsolicited snapping of existing panels; final grid spacing to qualify |
| Arrangement | Assisted (default), manual | Assisted never moves pinned/manually placed items without explicit instruction; manual only changes automatic layout policy |
| Preferred voice provider | Inherit configured default (default), an enabled permitted connection | Next voice connection; explicit apply-now reconnect preserves conversation |
| Preferred voice | Provider default (default), supported voice | Next connection unless adapter explicitly supports safe live update |
| Language | Automatic (default), preferred supported language | Next turn/session according to adapter; preference does not prohibit mixed speech |
| Spoken length | Inherit Commander (default), brief, balanced, detailed | Next turn |
| Personal voice instructions | Empty (default), bounded plain text | Next turn; reset removes personal override only |
| Sound effects | Off (default), on | Immediate local presentation; never changes notification eligibility |
| Spoken announcements | Inherit (default), quieter | Next eligible event; cannot make a silent notification policy more interruptive |
| Browser view quality | Auto (default), reduced bandwidth, high where supported | Next stream renegotiation; report actual negotiated quality |
| Mic input / speaker output | System default | Device-local; capability-detected speaker routing, unavailable device falls back with notice |

Temporary controls: mic mute, silence spoken replies, end voice, do-not-disturb override, focus/compare, browser pause/take-control/resume. Do not persist them as global Commander behavior. Never auto-start the microphone after reload or from preference synchronization. Transcript expansion can remember presentation preference, not microphone consent.

### Commander shared defaults

Existing authorized Commander administrators edit these; ordinary users may only apply personal presentation overrides where permitted. Save audited versions; apply to the next turn, with active sessions notified of the updated default.

| Field | Recommended default | Reset |
|---|---|---|
| Spoken length | Brief | Restore application default |
| Tone | Clear, conversational | Restore application default |
| Progress narration | Meaningful results and questions | Restore application default; respect existing notification eligibility |
| Shared voice-style instructions | Empty additional text over application instructions | Remove custom text, retain mandatory routing rules |

Application-owned routing, permission checks, confirmed-result rules and interruption-versus-cancellation semantics are not editable style fields. Agent page and Settings > Commander must link to or edit the same underlying configuration, not create competing defaults.

### Providers and policy fields

Provider administrators manage: enabled capability (off until configured), credential reference (none initially), optional administrator-approved default realtime model (selected from adapter capability catalog), connection test (explicit action), and default enabled voice connection (OpenAI first once configured). Readiness defaults to unconfigured/unchecked, never assumed healthy. Model changes apply to new sessions; credential revocation immediately invalidates affected access. Resetting personal preferences never removes provider credentials. Provider removal is an explicit administrative operation.

Display capability support and last-check status as read-only facts. Region and retention fields are only configurable when supported by the provider; otherwise disclose their effective values. Secrets remains the storage owner. Budget & caps remains the spending-policy editor. Browser idle lifetime, worker concurrency, cloud account ownership and routing are execution/environment policies, not personal Universe preferences; their limits must follow replatform and verified provider limits.

### Reconciliation with existing settings

The inspected `ThemeContext.tsx` already stores a light/dark/system global preference locally. Preserve it and add a scoped Universe override rather than replacing the global theme store. `SettingsPage.tsx` currently has no Universe section; registration, shared validation and persistence are implementation work.

`InboxSection.tsx` already manages notification preferences and `CommanderSection.tsx` also exposes silent/digest/realtime behavior. Universe must not add a third independent notification delivery policy. It may control local sounds and reduce spoken announcements. The notification review identified a generation-versus-delivery mismatch: upgrade the shared policy and migrate existing silent intent explicitly instead of applying a blanket most-restrictive rule that suppresses durable items or direct answers. Quiet hours and unsolicited delivery eligibility remain with the shared owner. This is an engineering integration dependency, not a new product question.

All preference writes use validated field patches with revision checks. Failed saves remain visibly unsaved and retain recoverable edits. Synchronization cannot apply other-company or other-user preferences. Device fields stay local; section reset and migration preserve unrelated settings. Unknown persisted versions use a safe fallback while keeping recoverable prior values.

## Latest UI review reconciliation

The [UI decisions](ui-review-decisions.md) supersede prior placement/presentation proposals. Use the actual AoA brand, respect the existing global light/dark/system preference through the Universe override, and retain the full settings scope even where the rebuilt mock omits controls. Dark red is the representative review theme, not a forced global default. Chat, Blob and Captions are separate labels/toggles in the Commander menu. Blob size and coordinates are personal layout state with viewport-aware bounds, not a provider setting. Reset position is an icon when relevant, not a permanent Release placement button.

All first-use defaults yield to saved choices. Always-visible tray may still be manually collapsed for the current session; Auto-hide additionally supplies hover/focus reveal. Showing/restoring any visual surface never starts microphone capture. Exact numeric sizing/intensity/snap bounds remain E1.6/E8.1 qualification work, not invented product limits.

## Acceptance cases (continued)

- A company switch never reuses another company's voice connection or cached readiness.
- CLI-ready/voice-unconfigured is represented accurately for the same vendor.
- Unauthorized users cannot change shared instructions or provider connections.
- Personal theme/caption changes do not change another user's experience.
- Reset restores defaults without deleting canvas state or artifacts.
- Opening settings neither captures audio nor incurs a live-session probe.
- Provider removal/revocation blocks new voice sessions and ends affected sessions according to policy, preserving conversation and authorized task state.
- Invalid preferences and unavailable voice/model combinations fail with an actionable explanation.
- Shared instruction updates are versioned and audited; active sessions apply updates at a defined safe boundary, while access revocations take immediate effect.

Implementation requires schema/API/UI changes following AoA's existing settings, Secrets and permission contracts. Exact routes and schema names remain engineering details; no new independent IAM system is introduced here.

## Voice/media policy binding

The [D3 proposal](voice-media-policy.md) supplies capability-specific readiness, strict connection-purpose binding and provider retention disclosures. Providers owns configuration/checks; Secrets owns keys; Budget & caps owns cost limits. Universe keeps personal voice/caption/device preferences and Commander keeps shared behavior. No settings read starts capture or a paid session. Privacy baseline is pending TK's choice; the recommendation is admin-approved disclosed provider terms with AoA recording off, subject to stricter company rules. No policy or subscription state is silently accepted.
