# Universe — remaining UI state designs

September 11, 2026. Written design specification for E1.0 and consuming slices. **States are specified, not visually approved or runtime-tested by this document.** Preserve the accepted [U01–U10 experience](ui-review-decisions.md) and [motion contract](motion-and-interaction.md). No mock was edited in this pass.

## Review boundary clarified with TK

The main interactive mock was already created and reviewed. Its accepted design and U01–U10 decisions remain the baseline; this inventory does not require restarting that design review or asking TK to approve the same controls again.

Additional loading, error, offline, reconnect, conflict and narrow-screen states are specified here in writing. Engineering/design should check their presentation against the accepted experience and record that evidence. Bring TK only a concrete change or tradeoff that materially affects experience or scope, with a recommendation. Routine faithful application of existing decisions does not require a new product approval.

React Flow package compatibility, real pointer/resize behavior, persistence and provider/worker qualification are engineering checks during implementation. Keep the reported intermittent task-panel defect open until reproduced and verified in the relevant host; neither acceptance of the visual direction nor a reference-controller test closes it.

This clarification records the review process, not completion of the remaining visual checks. No mock or runtime implementation was changed in this documentation pass.

## Common state priority

Revoked access replaces private content immediately; known-deleted content shows an unavailable reference. Offline/unconfirmed results are explicitly stale. A renderer error can coexist with a still-running task; it cannot be represented as task failure. Saved geometry and local drafts survive recoverable view failures. Auth changes clear inaccessible local render caches and previews using the authoritative company/actor boundary.

## Screen/state inventory

| Surface / state | Visible design and copy | Available action / focus behavior | Owner |
|---|---|---|---|
| Initial workspace loading | Stable top tray silhouette and quiet “Opening workspace…” status; no arrival headline or fake task count | Settings/account navigation still available; no autofocus into a placeholder | E1.1–2 |
| Empty authorized workspace | Centered blob, compact bottom composer, expanded tray; absent rails and zero badges | Type, explicit Start voice, or tray creation; blob presence does not start mic | E1.4–5 |
| Workspace restore failure | “Workspace could not be restored” near the tray with Retry; never replace stored data with an empty save | Retry is a read; a separate temporary view may open with saving disabled and explicit status | E1.2 |
| Unsaved layout / offline | Small “Changes on this device” status beside layout controls; existing work remains visible while access remains valid | Continue recoverable local edits, retry sync; do not show a saved tick without acknowledgement | E1.2 |
| Concurrent layout conflict | Compact comparison “This layout changed elsewhere”; identify changed panels, not a whole-screen overwrite prompt | Keep local change or use latest per conflicting property; focus returns to originating control | E1.2 |
| Loading panel | Keep real title/type and shared header; body skeleton sized to the panel, no fabricated messages | Move/resize/minimize/close still work while data loads | E1.1, E2.4, E4 |
| Panel render failure | “This view couldn’t load” inside body; header and task status remain separate | Retry renderer, open canonical task/artifact, or close view; no retry-job button unless outcome authorizes it | E1.1, E2/E4 |
| Deleted or revoked reference | Replace preview/body with “No longer available” or “You no longer have access”; no stale content thumbnail | Close reference, return to Inbox/Work; don't offer retry as a permission workaround | E1.4, E2/E4 |
| Empty overview | “No open panels” only inside explicitly opened overview, no persistent zero badge | Escape/outside closes; focus returns to Open panels | E1.4 |
| Many open panels | Readable preview grid with page controls and count; no horizontal scroll strip and no duplicated live headers | Keyboard arrows move across tiles, page controls change set; choosing restores same instance | E1.4 |
| Search failed / no match | Distinguish “Couldn’t load results” from “No matching items”; retain search text | Retry query or clear search; preserve currently open work | E1.4 |
| Task sending | Keep submitted message visibly pending with destination title; preserve subsequent draft | Prevent duplicate identical submission, keep newer typing; uncertainty offers status check | E1.3, E2.2/4 |
| Task reply rejected | Inline reason beside pending reply, draft remains editable; never add a success transcript entry | Correct/retry only as permitted by canonical outcome; task controls continue to work | E2.2/4 |
| No voice connection | Blob settles; Start voice icon has label/tooltip; no idle “listening” waveform | Explicit Start voice; hidden blob recoverable through tray | E1.5, E3 |
| Connecting / reconnecting | Short status adjacent to voice controls and restrained motion; captions do not fabricate speech | Stop cancels connection; typed chat stays usable | E3.1–2 |
| Mic permission denied | “Microphone access is off”; explain browser/device permission near voice controls | Retry after permission change or continue typing; no repeated permission loop | E3 |
| Provider unavailable / revoked | Provider-specific readiness failure in voice controls; settings link | Choose an already-authorized provider explicitly; no silent provider switch | E3, E8.1 |
| Muted / output silenced | Persistent crossed mic/speaker indicator; all other hover controls stay compact | Separate mic and speaker toggles; don't call mute a disconnected session | E1.5, E3.2 |
| Captions disabled / chat tucked | Hide captions only when toggle off; tuck chat independently | Tray can restore either surface; current voice connection remains accessible | E1.5, E8.1 |
| Browser loading / no worker | Session title/location with “Connecting to browser…” or “Worker offline”; no fake live screenshot | Close/minimize view; cancel/retry connection only against actual session state | E6 |
| Browser stream lost | Last frame marked stale and input disabled immediately | Reconnect to verified session; task state remains canonical, no replayed clicks | E6.2–3 |
| Takeover pending | “Pausing agent…” with input disabled until acknowledgement | Cancel request if supported; resume/typing cannot race a previous controller | E6.1–3 |
| Artifact processing failed | Original file details retained; individual preview/extraction stage shows failure | Download authorized original; retry that stage, not regenerate source | E4.1–3 |
| Tool containment failure | Contained error body and preserved checkpoint; no active privileged bridge | Restart view only with fresh capability; no automatic external write | E5.2 |
| Attention response pending / failed | Bottom-right movable card keeps question and draft; pending or inline failure state | Resolve only on canonical acknowledgement; close is not approval/dismiss-all | E7.3 |
| Preferences saving / failed | Section-local saving indicator; failure retains edited value and labels it unsaved | Retry or discard section edits; reset confirms scope through clear copy, never deletes tasks/drafts | E8.1 |

## Responsive geometry specification

These are initial engineering defaults for review, not measured performance guarantees. Coordinates below are CSS pixels in usable workspace before conversion through camera zoom.

- Reserve actual measured tray/composer/caption bounds plus 12 px separation; use ResizeObserver on the workspace/chrome. Do not guess the monitor resolution from device pixels.
- Suggested initial task panel 640×520, artifact 720×540, browser 880×600. Cap both dimensions to the usable rectangle. Suggested content minimums: task/artifact 360×280 and browser 480×320, reduced to usable bounds on narrow screens. Scroll content internally; headers/input remain reachable.
- First open centers within the current visible region; subsequent opens offset by 20 px through four stable positions, clamped to the current visible region. Never fit all nodes automatically when another item opens. This is an initial deterministic fallback; context-aware arrangement remains E1.6.
- Below 640 px usable width, present one foreground panel fitted to available width with overview recovery for others. Do not destroy their normal geometry. Chrome and blob reduce their occupied area; chat can tuck explicitly, never silently while typing.
- If vertical space is insufficient, prioritize the active composer and panel header; the user can tuck Commander through its existing controls. Avoid overlap between caption text and bottom-right attention. A question needing more room opens its task conversation.
- Expanded chat uses internal history scrolling and a fixed composer. Compact returns to bottom even after maximize. Caption width follows the composer region and never creates a second framed panel.
- At zoom below 0.6, work previews may simplify; entering a text editor deliberately returns that panel to readable scale before focus. Do not force typing into a scaled miniature. This behavior belongs to E1.6, not an implicit reducer side effect.

## Focus, gestures and accessibility

- Panel action order is Pin, Maximize/Restore, Minimize, Close. Chat keeps its agreed Tuck, Maximize/Restore, Compact order with Compact rightmost. Use distinct icons and accessible labels; no visible repeated text buttons.
- Header drag target excludes buttons. Edge hit regions are 8 px for pointer resizing; touch targets expand to at least 24 px without expanding a visible outline. Frame controls use at least 32 px hit regions; icon art can be smaller. Keep a keyboard action alternative.
- A focused panel header supports Alt+arrow movement by 10 CSS px and Alt+Shift+arrow resize by 10 CSS px. Translate deltas through zoom; don't intercept these shortcuts inside editors/inputs. Browser/OS zoom shortcuts remain intact.
- Hover controls remain open while pointer or focus is within their combined corridor; touch reveals them on deliberate tap. Escape first cancels the active gesture/menu, not arbitrary work. Closing/minimizing returns focus to overview entry or tray; never leaves focus in hidden content.
- Preserve visible keyboard focus indication even though selected-panel styling is only header tint/title brightness. Focus ring and selection are different concepts; no selected-panel white line is reintroduced.
- User manipulation cancels stale queued camera animation. Pointer cancel/lost capture/window blur releases drag shields. Reduced motion removes travel but retains state changes and readable status.

## Review/qualification evidence still required

Review these states at 1440×900, 1024×768 and 390×844 CSS-pixel viewports, at 200% text zoom, with keyboard, pointer, touch and OS reduced motion. Exercise all five task entry routes in the actual embedded host after zoom, overlap and reopen. Record deviations rather than marking design approved through a document check.

The written state inventory closes the missing-specification part of E1.0. It does not close visual review, the intermittent mock defect, actual layout persistence or provider/worker qualification. All owning implementation acceptance remains unchecked.
