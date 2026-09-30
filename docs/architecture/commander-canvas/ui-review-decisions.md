# Universe — consolidated experience decisions

September 11, 2026. Status: agreed product/design direction with explicit gaps; not shipped behavior, release allocation or certification of the mock. This is the current UI specification supporting the [master scope](master-scope.md). Repository-wide architectural decisions remain controlling.

This replaces chronological UI notes, preserved in [history](history/ui-review-before-consolidation.md). Later user corrections supersede earlier proposals. Numerical tuning remains recommended until verified. See [motion and acceptance](motion-and-interaction.md) and [epic traceability](epics-and-slices.md#ui-decision-traceability).

## U01 — Identity, composition and arrival

**Entry clarification, September 19:** Commander and a Universe icon on each lobby company card open the same dedicated company-scoped Universe route. Universe has no board or lobby sidebar. The authenticated company boundary remains in force. The old real-data screenshot inside the board layout was an implementation error, not an approved alternative composition. See [correction and evidence](universe-shell-correction.md).

- Army of Agents is the product; **Universe** is the feature/navigation label, not “Open Universe.” Commander is the assistant.
- Use the actual AoA brand asset, including its red dot, from the existing product. Red supersedes the orange-looking mock. Contrast-safe theme tokens must preserve brand identity.
- JARVIS and the Atlas film interfaces inform floating work, restrained chrome, spatial depth and a separate luminous Commander presence. They do not imply decorative telemetry, illegible content or a permanently dark product.
- Normal arrival has no central slogan, welcome paragraph or mandatory briefing panel. First-use introduction is optional and separate.
- Default: expanded tray centered at top, blob centered, compact chat input at bottom, side shortcuts when relevant. Chat and blob both show. This supersedes earlier mode-exclusive arrival defaults.
- Blob visibility does not connect voice or start the microphone. Return restores presentation preferences and existing work, without automatically reconnecting audio.
- Catch-up appears as short conversational content alongside existing work, not a forced replacement panel. Arrive/Return/Open task chat/Highlight artwork walkthrough buttons are mock-only.

## U02 — Tray and recoverability

- Top placement only for the first version. Other edges and drag-to-dock are later design work, not currently offered settings.
- Expanded by default. One stationary AoA mark at the top center retains size, padding and hit area. Balanced wings retract toward it; no swapped logo buttons, size jump, duplicate corner logo or separate collapse arrow.
- Click the logo to expand/collapse. Collapsed shows only that control, not a running/needs-you sentence. Detailed status stays with attention/Inbox.
- Settings: Always visible and Auto-hide. Hover/focus/tap can reveal Auto-hide. Explicit manual collapse does not reopen immediately under the same stationary pointer; require re-entry or deliberate activation.
- Keep controls open while a menu is in use. Only one menu/overview opens at once. Another replaces it; selection, Escape or outside click dismisses it with appropriate focus return.
- Icon entries: unified Commander, Work, Artifacts & Sources, Inbox, Browser, Settings, one Open panels control. Current conversation title sits quietly above. Search lives inside relevant menus.
- Existing goals, discussions, notes, reminders, saved references, memory inspection and activity remain reachable through relevant menus; no mandatory icon for each.
- Show icon labels on hover/focus. Show counts only when nonzero. Do not add a second top-right status board.
- One small blob identity replaces separate Conversations/Restore Commander icons and matches the chat voice shortcut.
- Main Commander click: restore hidden chat; bring covered chat forward; tuck chat if already frontmost. It affects chat only. Adjacent menu offers independent Chat, Blob, Captions controls and recent/new conversations. This supersedes “restore whichever presentation was last visible” and the intermediate menu-only proposal.

## U03 — Open panels and side previews

- One Open panels icon opens the complete current-conversation registry of open/minimized views, including the focused panel. It is not an artifact library. This supersedes the earlier omission of the focused panel and growing row of individual icons.
- Android-recents-inspired readable thumbnail tiles with titles and open/minimized state; no tiny horizontal strip or horizontal scrollbar. Recommended responsive grid/pagination, stable ordering; exact page size depends on viewport, not task capacity.
- Selecting an open item brings it forward at readable size; minimized restores saved geometry. Close removes the entry. Repeated entry paths reuse the same task/reference view unless a distinct comparison view is explicitly requested.
- Left rail: only already-open panels minimized/tucked or outside current view. It is an optional shortcut to that registry, not all visible panels or invented work.
- Right rail: **Needs you, Ready, Coming up**, backed by canonical Inbox/work/routine state. Previewing or seeing an item is not approving/resolving it.
- Hover/focus reveals recognizable content thumbnails, like window previews; right previews show the question/result/upcoming item. Tap has equivalent access, click opens work. Short intent delay and continuous hover hit region prevent flicker. Do not clone live controls/element identities into previews.
- Each rail independently supports Auto, Always show, Hidden. Auto displays relevant items; Always show keeps the affordance without fake items. Hidden preserves recovery through tray menus. Normal tray icons retain simple labels; Open panels uses the richer overview.

## U04 — Shared panel lifecycle

All work surfaces, including task chat and attention detail, share one lifecycle contract; content renderers must not implement competing window controllers.

| Action | Intended behavior |
|---|---|
| Open | Resolve an authorized stable reference; reuse an existing view or place a bounded new panel inside the usable current viewport. No implicit job execution. |
| Move | Header drag; inputs, buttons, text selection and content scrolling never drag the panel/canvas. Direct pointer following. |
| Resize | All eight edges/corners with hover resize cursors/hit targets; no permanent resize icon. Content-specific minimums; internal scrolling. |
| Select | Bring exposed clicked panel forward; slight header tint and brighter title/actions only. No white top line, accent outline or extra selection glow/shadow. |
| Pin/unpin | Preserve placement against Commander automatic arrangement. Human move/resize remains possible. Pin is not minimize or stop. |
| Minimize | Hide view, retain registry entry, draft, geometry and source; animate toward Open panels. |
| Restore | Same instance and geometry, with viewport adjustment only as needed for readability. |
| Maximize | Fill usable Universe workspace, leaving Commander/tray reachable; not merely zoom/focus or browser fullscreen. |
| Restore from maximize | Return prior geometry and viewport while preserving other panels/tasks. |
| Close | Remove view/registry entry, not task/artifact/browser job. Recoverable drafts survive reopening. |
| Arrange/fit/compare | Separate user/Commander operations respecting pins/manual edits. Use panel-local icons/overflow where applicable, not detached text controls. |

- Header window controls: pin, maximize/restore, minimize, close, with distinct accessible names/tooltips. Selection differs from Commander reference glow.
- Behavior is identical from tray, attention, source-task link, preview and direct entry. Previews are presentation data, not duplicate live trees.
- Keep geometry/drafts outside renderer lifetime. Expensive viewer suspension does not stop canonical work. Persistence, undo and conflict handling remain production requirements.
- Initial sizes depend on content and usable screen. Task chat starts conversationally sized; documents/browser/presentations may be wider. Long task content scrolls rather than making an oversized panel. Save user dimensions; smaller screens clamp presentation without destroying recoverable preferred geometry. Exact bounds require measurement.
- Deliberate overlap is allowed. Automatic placement avoids active input and essential controls. Opening a second panel must not unexpectedly pan the first away.

## U05 — Canvas and Commander viewport actions

- React Flow remains the production foundation; the standalone mock is not a React Flow integration. No default graph wires/connectors.
- Canvas positions differ from screen positions. Pan empty space, zoom deliberately; wheel inside a panel scrolls its content. Preserve native browser/accessibility zoom and embedded browser input.
- Tray, blob, chat/captions and attention affordances sit outside the transformed work canvas. Attention detail can be moved; initially bottom-right.
- Commander receives usable viewport dimensions, pan/zoom/visible bounds, panel geometry/visibility, pins and selected reference/version. This context is bounded and permission-filtered, not authorization. Capture target identity at submission.
- Both human and Commander can move/resize/fit/maximize/restore panels and resize/reposition the blob. Respect manual arrangement and pins unless explicitly instructed otherwise. Layout changes should be undoable.
- Requested reference/highlight automatically brings an off-screen panel into readable view then highlights it. This supersedes preview-only “Show panel.” Routine background updates do not steal the viewport. Recommended guard: defer camera movement during active typing/dragging while preserving pending target indication.
- Commander highlight is a soft accent glow that blooms, pulses once and fades. It does not move the user's cursor, auto-pin, change submitted targets or prove work completion. User selection remains steady header-only styling.

## U06 — Task conversations and materials

- Task panel: concise title/status, responsible agent, scrollable messages and fixed Add/message/Send row. Supporting agents and artifact links expand on demand.
- Direct task text names its destination; bottom chat and voice address Commander. Direct agent voice remains a future explicit mode.
- Labels distinguish task, conversation and artifact before opening. Launch design/Launch artwork are examples, not special entity types.
- Artifact views preserve source-task links, immutable versions, comparison, authorized export and source provenance. Existing format/hosting contracts still apply.
- Canvas file drop adds material; composer drop/attach adds draft context. Neither alone authorizes a job. Show destination and retain drafts after failed send.

## U07 — Chat, blob and captions

Independent presentations of one Commander conversation. Visibility never deletes history/drafts, cancels work or implicitly changes voice connection state.

| State | Display/control |
|---|---|
| Compact chat, default | Aligned Add/input/voice-blob/Send row. Latest caption above, without another caption box. Small hover/focus Expand control with a continuous clickable path. |
| Expanded chat | Scrollable history, fixed composer; header Tuck, Maximize/Restore, Compact (rightmost), with distinct icons. |
| Maximized chat | Workspace-sized history. Restore previous geometry; Compact exits maximized coordinates before returning to bottom. |
| Tucked chat | No input/history, recover through Commander tray. Blob/captions unaffected. |
| Blob shown/hidden | Independent presence; movable/resizable within viewport limits. Recover from menu or connected voice shortcut. Showing does not start voice. |
| Captions | Independent on/off; default bottom-center above compact input, or bottom-center when chat tucked. Optional below-blob location. Plain selectable text. |

- Captions show latest speech; full reconciled transcript lives in chat. Expanded history contains live text without a duplicated outside overlay. Panel warnings never replace captions; no “mic muted demo” caption placeholder in production.
- Captions work with blob hidden. Recommended fallback for below-blob placement while hidden: bottom-center; verify in design review.
- Caption text remains selectable/copyable; use Expand to open history, not the entire caption as a button.
- Expanded chat moves/resizes; Compact returns stable bottom input. Remove broken Return chat to bottom action. Tuck hides; Compact retains input.
- Same mini-blob identity in tray/chat. Composer voice shortcut starts voice when disconnected, reveals blob/controls when connected; tray controls chat and history.
- Blob controls: one small straight row below, on hover/focus/tap only. Start/End voice (play/stop), mic, speaker, Hide blob; reset-position icon only when relevant. No separate Open chat text, Release placement text, or rectangular hover background around the blob.
- Resize through hover edge/corner affordance, no permanent glyph; control hit areas stay usable independently of blob scale. Remember manual size/placement.

## U08 — Voice and attention

- Play connects to current Commander conversation; Stop ends connection and leaves blob/text/work intact. Start again reconnects to that conversation.
- Mic mute stops input; speaker silence stops playback; neither means End voice/Cancel task. Persistent small off/muted indicators remain when controls hide. Mute does not guarantee zero provider usage.
- Connecting, listening, thinking, speaking, interrupted, reconnecting, unavailable and disconnected need understandable distinct states. Animation reflects actual state; a visible breathing blob is not proof of listening. Audio-reactive behavior remains production work.
- Speech interruption does not cancel work. Session loss uses read-only outcome reconciliation before retries; switching conversation stops old audio and preserves late-result origin.
- OpenAI first; Gemini and ElevenLabs retained; speech pipeline/local speech later. The subsequent [accepted allocation](release-plans/README.md) places all three realtime providers in V1 and E3.4 speech pipeline/local speech in V2. Providers owns capability connections/Secrets references/checks; Budget & caps owns limits. CLI readiness is not voice readiness. Technical contracts and architecture amendments still gate implementation.
- Routine results quietly update canonical attention. Actionable interruptions appear compact bottom-right and can be moved; large requests open an appropriate task panel. No automatic central modal or rearrangement.
- Respond, dismiss, snooze, seen and resolved differ. Closing a surface is not approval. Successful response acknowledgement updates the same Inbox item. Upgrade shared notification generation/delivery per its review; direct replies are not unsolicited notifications.

## U09 — Preferences and persistence

- Personal Universe presentation, shared Commander voice style, Providers readiness and Budget & caps remain separate owners with links, not duplicate editors.
- One AoA default, with light/dark/system appearance and curated customization: accent, fluid/orbital/minimal blob, matching/separate blob color, full/subtle/reduced motion, none/dots/lines grid, intensity, snap-to-grid. Dark red is the review representation, not the only theme.
- Expanded tray default, Auto-hide optional; independent Auto/Always show/Hidden rails. Chat/Blob/Captions toggles separate in Commander menu. Caption location/size in preferences.
- Personal user/company preferences differ from per-conversation geometry and device-local audio choices. Restore saved choices. Reset only the named section, never work/drafts.
- Revisioned acknowledged saving, conflicts and unsaved state are required; mock local state proves none of these. See [settings contract](settings-contract.md). Settings lost in the rebuild remain in scope.

## U10 — Accessibility, motion and review gaps

The subsequent [UI state design inventory](ui-state-review.md) specifies loading/error/offline/revoked/conflict and responsive behavior in writing. It does not change the actual-host verification status below. Release allocation and methodology were accepted later as recorded in [first-batch readiness](first-batch-readiness.md).

See [motion and acceptance](motion-and-interaction.md). Keyboard/touch alternatives, focus return, pointer-capture recovery, readable contrast and reduced-motion parity are requirements. Viewport changes preserve reachable controls and recoverable geometry. Narrow-screen layouts need review, not simply shrinking desktop tiles. Loading/waiting/stale/offline/failed/revoked/conflict states must retain recoverable content and avoid false completion.

Latest local reference: `universe-clean-panels.html` in the task's September 9 visualization directory. Earlier mocks contain useful omitted details; this specification, not the subset in one file, defines intent.

Standalone headless checks on the rebuild covered right-side Ready → Launch design, header drag, eight resize edges, pin, maximize/restore, minimize/overview restore, close, and opening/closing Needs you, with no script errors in that sequence. Blob hover was checked as transparent with three layers and breathing motion. These do not certify all entry routes or the inline host; standalone screenshot lacked host Lucide rendering.

User feedback remained intermittent/glitchy across task entry routes after apparent improvement. **Defect stays open**. Do not call it fixed from local tests. No production runtime was verified by this mock.

| Gap | Required evidence | Owner |
|---|---|---|
| Intermittent task controls | Actual embedded-host reproduction, every route after reopen/zoom/overlap; shared registry/controller | E1.1, E1.4, E2.4 |
| Lost settings/previews/motion | Audit earlier mocks against U01–U10 and restore required scope | E1.0, E8.1 |
| Chat movement/resize/state chains | Pointer/keyboard checks, preserved geometry/draft | E1.5 |
| Persistence/undo/reload/conflicts | Integrated acknowledged save/recovery tests | E1.2–3 |
| Voice/browser reality | Actual adapter/worker integration, not labels/images | E3, E6 |
| Responsive/accessibility/performance | Narrow/text-scaled screens, keyboard/touch, reduced motion, measured limits | E1.0, E1.6, E8.2 |

The direction is ready for documentation and grooming. E1.0 is not fully closed; this UI review itself does not authorize coding. Subsequent [release acceptance](release-plans/README.md) and [branch publication](planning-publication.md) supersede its earlier unallocated planning status. Next discussion follows this consolidated record and its remaining design-state gaps.

Documentation verification for this consolidation: checked relative links/heading anchors and trailing whitespace across ten current documents; 31 unique planning slice IDs; all ten UI decision groups mapped to owning slices. No errors found. Repository typecheck, runtime tests and build were not run because this update changes documentation only. No application code, ticket, branch, commit or deployment was created by the consolidation.
