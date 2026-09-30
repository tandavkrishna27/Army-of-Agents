> Historical discussion record. Preserved for rationale and learnings; superseded by [master scope](../master-scope.md) and [current evidence](../code-evidence.md). Earlier recommendations and reported checks are historical, not current implementation instructions.

# Commander Canvas — Living Experience Draft

## September 10 clarification: browser control and IAM

Manual pause-and-take-control, including a voice request, is acceptable; automatic click takeover is no longer mandatory. Resume Commander checks the current browser state before continuing, and stopping a task remains distinct from pausing for human interaction. Browser Use is the preferred candidate for evaluation, not a proven AoA integration.

Accounts/access management covers humans and agents as a separate workstream built on Secrets and existing permissions. An agent proceeds with sufficient granted access or requests an appropriate grant from the owner. Credential use and disclosure are different permissions. Personal and company accounts retain explicit ownership; saving browser login state is separate from password storage. Canvas surfaces account identity and access requests without becoming a second authorization system. See the [technical review](../code-evidence.md) for the latest contracts and remaining gaps.

Date: 2026-09-09<br>
Owner: TK<br>
Status: Experience design in progress. Not an approved implementation specification.<br>
Name: Unconfirmed. “The Bridge” and “The Helm” are candidates, not decisions.

Latest naming candidate: “Cockpit,” raised by TK on 2026-09-10. The existing Commander side panel already uses that name; the relationship and naming are not settled.

## How to use this document

Resume checkpoint: TK agreed to move into technical design next, with remaining visual refinements tracked as open work rather than a blocker. Start by mapping current AoA and replatform capabilities to the experience, then design Commander/voice integration, canvas state and persistence, agent activity and proactive routines. Epics and version slices follow architecture. Session paused at TK's request; no further work or automatic next-day reminder was requested.

This consolidates the original Focus Mode Canvas handoff and the subsequent voice discussion. It records the intended experience, not shipped behavior. Continue refining this document as the experience becomes clearer. Settle the experience and review it with TK before technical design, implementation planning, or implementation.

“Agreed” means TK accepted the direction in discussion. “Proposed” means a recommendation still needs refinement. Agreement on the vision does not establish a first-release scope or ratify changes to repository-wide architecture rules.

Process correction from TK (2026-09-10): explore the full intended scope and ultimate experience now. Do not narrow discussion around a first release. Sequence: full experience and UI/customization design → experience review → technical design → dependency-aware epics and release/version slices. Release planning is deliberately deferred until after technical discussion.

## 1. The experience we are creating

## Latest consolidated checkpoint — 2026-09-10

This checkpoint takes precedence over older, conflicting proposals below. The earlier sections retain useful rationale and exploration history; they must not be read as simultaneously approved alternatives. The name remains provisional. FUI (fictional/futuristic user interface) describes the cinematic visual inspiration; conversational workspace describes the product experience.

### Navigation and finding material

- **Agreed:** remove the misleading separate Canvas tray button. Replace its collection role with **Artifacts & Sources**, organized within the current conversation. Artifacts include created images, presentations, reports and tools. Sources include uploads, links and referenced material. These are roles: an existing artifact can become input to later work. Preserve provenance without duplicating the underlying object.
- **Agreed distinction:** switching the Commander conversation changes the whole canvas; opening an artifact or task changes content within it. The mock's Launch direction label is a conversation title, not a content category. Exact session-switcher placement remains a design choice.
- **Open panels** are currently open task chats, artifacts, browser surfaces and other working panels. They are quick navigation, not a second artifact library. Drop the ambiguous Nearby label. Show actual open items rather than a fixed collection of example thumbnails; do not repeat the focused panels. Empty open-panel navigation disappears.
- **Proposed placement:** smaller open-panel previews on the left, working content in the center. The user requested less space consumed by previews. A right-side attention feed is newly proposed below; this is not approval of permanent three-column content zones.
- **Agreed:** provide search by typing or asking Commander, including clear distinctions between material already here, tucked away and retrieved from another accessible conversation. Restore/reference existing items rather than create accidental copies.
- **Tray proposal still under review:** Artifacts & Sources, Inbox, Work, Discussions, Goals; Saved may be secondary access rather than a permanent entry. Search, session switching, browser/tools and Experience controls need a coherent placement. Broad Overview was rejected; Goals is the preferred specific entry. Budget/team activity remain accessible without a required permanent shortcut. No global cockpit rename has been implemented.

### Space, panels and conversation controls

- **Latest preferred direction:** a compact bottom bar by default, showing the latest live caption plus mic state and an entry to typing. Expand for composing; expand further for history. Preserve drafts and keep the input open while typing. This supersedes the earlier always-expanded typing-box default. Exact dimensions, caption length and collapse behavior need visual testing.
- **Agreed walkthrough:** a task conversation and its artwork can remain side by side. Opening a small Inbox question should not replace either. Answering closes the temporary question card and preserves the layout. Substantial questions can be focused, with other content recoverable through previews.
- **Agreed overlap principle:** automatic arrangement avoids covering active working panels. User-controlled overlap is allowed with a way to bring covered panels forward. Temporary overlays are movable/dismissible and must not obscure the active typing field or needed controls. Current overlay placement is illustrative, not collision-aware production behavior.
- Commander remains movable and expressive, but must avoid competing with open-panel navigation and controls. Cinematic transitions settle during reading, typing and direct manipulation; reduced motion remains available.

### Tasks, references and multiple workers

- Opening a task means opening its conversation/workspace panel with status and outputs, not only a status summary. Direct task replies are clearly labelled as going to that task; Commander input continues addressing Commander.
- Opening a task artifact brings the same artifact forward with a visible source-task link. It can sit beside the conversation. Discussion threads follow the same linked-content pattern; their future collaboration expansion remains deferred.
- **Agreed:** Commander relays instructions when asked, with outgoing messages labelled Commander on behalf of the user; direct user messages and agent replies retain their own authors. Focus does not change the voice recipient. Future direct-agent voice requires explicit selection.
- **Agreed:** attach via the task composer or drop onto its draft; dropping onto empty canvas adds material for Commander. Highlight the drop destination. Commander may retrieve an accessible reference and relay it to a specified destination when asked. Merely discussing or retrieving material is not automatic publication.
- **Proposed worker representation:** task cards with lead-agent identity, meaningful status and a supporting-agent count; expand for subagent responsibilities. Questions from supporting agents surface at the parent level too. Compare grid and hierarchy treatments visually.
- **Proposed compact status:** running count and needs-you count remain discoverable when Work/the dock is collapsed. Distinguish sent, working, reply ready, and actual failure; do not imply that a message being sent proves work started.

### A working day: morning, active work, break and return

Design for hours of use, not only a short demonstration. Preserve drafts, context, open work and retrievable material across interruptions; do not make panel housekeeping the user's main activity.

**New proposal, supported for further exploration:** a collapsible attention feed alongside the workspace with **Needs you**, **Ready**, and eventually **Upcoming**. It surfaces existing Inbox decisions/questions, completed results and relevant scheduled events rather than inventing another independent inbox. Open-panel navigation answers where current work is; the attention feed answers what changed or needs attention. Exact placement, priority, ordering, grouping, acknowledgement and history remain unresolved.

On completion, work status should update and Commander should receive the relevant event. A result can enter the attention feed with a brief preview, without automatically taking focus. Commander can group routine completions into a concise update. This is desired behavior, not a verified event-delivery implementation. Unanswered decisions remain discoverable; routine updates should not become an ever-growing urgent queue.

**Proposed break state:** an explicit Taking a break control or conversational command stops listening and spoken output, quiets routine notifications, and leaves already-authorized background work running. Updates accumulate for a short catch-up on return. Inactivity may suggest a break but does not authorize cancelling work, resuming a browser after human takeover, or silently enabling a microphone. Automatic idle detection, wake-word behavior and whether urgent notifications can break through are open questions.

Sound design remains to be worked out: distinguish speech, an optional attention chime and ordinary completion; provide mute/quiet preferences. No final sound palette, frequency or interruption rules are approved. A meeting or deadline signal must remain distinguishable from an agent question.

Voice billing is unresolved because no provider/session architecture is selected. Muting the mic is not evidence that a remote connection or billable session has stopped. Aim to suspend the voice connection during a break where supported, retain conversation state and show a clear paused/listening/reconnecting state. Verify provider charging and reconnection behavior during technical design; make no zero-cost-pause promise.

### Separate future workstreams

- Discussions evolution: human/agent channels, threads, DMs, shared canvases and meetings remain documented in section 9 for separate foundational work. Shared layout with independent pan/zoom and optional follow/spotlight supersedes the earlier personal-layout proposal.
- Google/Microsoft email and calendar integrations are future work. Relevant messages/invitations can surface through Inbox; full mailbox/schedule access is distinct. A customizable Calendar shortcut and a native calendar panel are proposals; provider sync, embedded provider UI, team schedules, access sharing and organizational-calendar needs require separate design. Personal connection must not imply company-wide disclosure.

### What the prototype currently demonstrates—and does not

The prototype includes top-dock navigation, example worker cards, task/discussion messages with local reply inputs, supporting-agent details, search over example material, task/artifact links, a task/artwork side-by-side view and a compact tone question. Voice, agent replies, browser operation, approvals and exports are simulations. It is not connected to AoA, provider accounts or real workers.

The latest compact-caption default, replacement Artifacts & Sources collection, actual open-panel tracking, smaller left previews, attention feed, break/return state and sound behavior still need a mock revision. Task attachments and drop targets remain unimplemented. Example counters and simulated worker states are illustrative, not a validated status model. Syntax checks passed for the recent edits; their full interaction/visual regression review is still outstanding. Do not represent a code walkthrough as user testing.

### Next review

### Working-day walkthrough and proactivity — latest learning

**Latest clarification: lifecycle labels are illustrative, not automatic detection.** Arrive means opening the Commander canvas to start working. Finish requires an explicit user statement/control; closing the canvas alone neither proves the day ended nor cancels authorized work. Return is the preferred name over Next morning: the person might return the same evening or days later. Use elapsed time, local time and relevant changes for catch-up without assuming a fixed morning schedule. The current mock's navigation buttons simulate these moments; no time or presence detection exists. Team presence/interruptibility was an assistant tangent, not an accepted additional requirement from TK's question.

**Remaining technical choices:** evaluate speech-to-text → existing Commander session → text-to-speech against a separate realtime voice front end. The desired experience is one coherent Commander; responsiveness, interruption, synchronized context and cost must be measured before selecting an architecture. Distinguish Commander session helpers, Commander crew, organizational agents and their supporting agents; expose task ownership/progress first and expand hierarchy when useful. A host session's subagent concurrency is not an agreed AoA workforce limit. External live-channel/meeting ingestion, threading, provenance and permissions stay in the separate communication/integration workstreams.

**Proactivity presentation:** distinguish actions actually completed, work underway, suggestions and decisions awaiting the user in both speech and visual status. Routines and event-driven coordination operate within the responsibility granted; observed preferences support suggestions rather than silently creating standing instructions. The briefing is a proposed contextual start, not mandatory morning automation.

TK requested that experience review proceed through an entire day rather than a sequence of isolated settings questions. Commander is proactive throughout: before arrival, between interactions and while authorized work continues. It prepares relevant material, coordinates permitted follow-ups and surfaces decisions requiring the user. Distinguish handled, underway and needs-you states. Routines can be explicitly configured; observed behavior can inform suggestions, but does not silently become standing authorization. Routines need inspect/change/pause access. These are product directions, not newly scheduled real automations.

Arrival should provide a short, relevant briefing about actual changes, useful preparation and upcoming commitments. Suggest a first action with a reason, without forcing it. The user can choose another item or start unrelated work; the briefing then gets out of the way and remains retrievable. Later returns should explain changes rather than repeat the morning briefing. Upcoming meetings can expose preparation and a future Join action, subject to the separately deferred integration work.

For multi-step requests, Commander can expose a compact, redirectable plan linked to existing tasks and artifacts, start work within its authorized remit, and bring back decisions. Simple requests do not need a plan panel. The user can reprioritize or defer work conversationally. Incoming urgent issues should explain relevance and allow Show me/Later while preserving drafts, working layout and already-authorized background work.

End of day: show completed work, outstanding decisions and what will continue under existing instructions. Let the user explicitly adjust continuation/pause choices. Preserve the workspace for the next morning. No silent expansion of authority is implied by ending the day.

Prototype checkpoint: added a connected, explicitly simulated Arrive → Work → Interruption → Finish → Next morning navigation. Arrival offers prepared artwork, a writer question and meeting preparation. Work reuses the task/artwork scene; interruption offers Show me/Later and return; finishing records example research/design continuation choices, reflected in the next-morning text. The bottom bar starts compact with the latest caption, and the collection control now reads Artifacts & Sources. Smaller left previews explore placement but still use example content rather than true open-panel tracking. The collection is not yet fully separated into artifact/source sections. Live agent activity, scheduling, voice, provider billing, meeting integration and durable persistence remain absent. Latest script syntax check passed; full rendered regression checks for these newest additions are pending. Syntax checks do not establish visual correctness or user acceptance.

Record review feedback as observation → proposed change → accepted decision where applicable. Keep rejected names and superseded layouts labelled as history, not current requirements. The next review should establish whether the briefing, compact controls and incoming attention work as one coherent day, before adding more feature scope.

Revise the mock around one continuous day: start with a compact conversation bar; open a task and its artifact; handle a question without losing layout; accumulate several results; take a break; return to a concise catch-up; find an earlier source. Review navigation duplication, crowding, actual open-panel state, attention priority, keyboard access and motion together. Then consolidate the final experience before technical architecture and release slicing.

## Original experience foundation

A full-screen conversational workspace where Commander brings the things being discussed into a living, freeform canvas. The conversation is the main experience. Tasks, images, documents, browsers, comparisons, and custom interactive interfaces appear alongside it and can be used directly.

This should become a highly functional daily surface for running the company. It supports directing work, concentrating on one thing, and exploring or creating something new. It is broader than a task dashboard.

Commander is a moving director, not a fixed decoration. Its orb changes size and position to make room, guide attention, and express listening, thinking, and speaking. There are no permanent content zones. A centered conversation can become one dominant item, an equal comparison, or a main item with supporting material.

## 2. Agreed experience directions

### Entry and conversation identity

- Canvas is an optional view of each Commander conversation, entered through an icon for that session.
- Chat and canvas belong to the same conversation. Switching views preserves context and does not itself stop work.
- Each new conversation has its own fresh canvas. Reopening a conversation restores its associated canvas.
- There is no separate canvas-creation or canvas-naming step in this version of the experience.
- Provide conversation switching from inside the canvas, without returning to regular chat. Selecting a conversation switches its context and canvas together; these are not separate destinations. **Placement is unresolved:** TK was not convinced by the assistant's conversation-title picker proposal and suggested access through the tray. Explore a distinct “Conversations” control at the tray edge that opens a session picker, keeping session navigation distinguishable from content belonging to the current session. This is a proposal for visual comparison, not an approved layout.
- Forking a conversation and Commander suggesting or initiating another canvas were raised as exploratory ideas. Neither automatic switching nor automatic forking is approved. Proposed boundary: Commander can suggest a separate conversation or act on a user request; switching the user's active context on its own needs an explicit design decision. What context, artifacts, and running-work references a fork inherits remains open.
- It does not replace Home. A direct lobby entry remains an inherited handoff direction; its precise destination needs refinement.

### Visual character and attention

- The chosen direction is a **cinematic cockpit: more animated, futuristic, and attention-grabbing**.
- The orb visibly reacts and changes scale. Content makes an entrance; focus changes are choreographed.
- One item can become prominent, multiple items can share focus, and references can sit nearby.
- Focus direction refined by TK: when one item is enlarged, other open items remain visible as very small previews grouped in a corner, analogous to presentation thumbnails. Do not automatically tuck all other open panels into the earlier-work tray. Exact corner, thumbnail size, and overflow remain visual proposals. Proposed interaction: select a preview to make it the focused item; leave focus to restore the prior arrangement. This temporary focus overview is distinct from the tray of put-aside content.
- Small components are valid alongside full panels. Every piece of information does not need a large window.
- Content being read, edited, or directly manipulated needs stability. The cinematic character must coexist with usable controls.
- Commander arranges by default, but the user's interaction takes priority.
- Users can drag, resize, and focus content directly or request changes conversationally. Commander respects manual placement and sizing until the user releases them or requests rearrangement. How that protection is shown and how it adapts to a smaller screen remain open.
- Pin, expand/focus, clear, and managing excessive content remain required from the original handoff. Their exact gestures and semantics are still open.
- Pinning is a lasting user instruction: users pin directly or ask Commander to do so. Commander may emphasize relevant content on its own, but does not autonomously turn that emphasis into a persistent pin.
- Clearing preserves pinned items and tucks other content into the tray. Dismissing a panel likewise puts it aside rather than deleting its saved content or stopping its work. Undoing the clear to restore the previous arrangement is the proposed recovery action.

### Voice and typing

- Natural interruption is a first-release experience requirement: the user can speak while Commander is speaking, and Commander yields and follows the new direction.
- Stopping speech and stopping work are distinct. An ambiguous “stop” stops speech immediately, then Commander clarifies whether work should also stop. An explicit request such as “stop generating that image” targets that work; a speech interruption alone does not cancel authorized background jobs.
- Typing remains available as an alternative driver of the same experience.
- Entry follows the user's voice activation choice: if they have explicitly enabled voice on canvas entry, opening the canvas starts voice when available and permitted. Otherwise, the canvas opens with a chat box. A configured provider key or an old microphone permission alone is not that activation choice.
- Latest requested direction: active voice follows the selected Commander conversation rather than requiring manual restart after every session switch. Stop the previous conversation's playback and clearly indicate the newly active conversation before accepting speech into it; only one conversation owns live voice at a time. This supersedes the assistant's earlier pause-until-restarted proposal. Exact handling of a switch midway through an utterance remains open; do not silently split or copy an utterance between conversations.
- Proposed entry feedback: make listening unmistakable, provide an immediate mute control, and retain typing in either state. If voice cannot start, show the reason and keep chat usable. The precise controls remain to be designed.
- Optional customer-supplied voice-provider credentials are an accepted product direction. Provider selection, keyless voice quality, costs, and setup remain unvalidated.
- The existing Commander remains the reasoning foundation. Adding voice does not imply replacing it with a separate conversational brain.
- No specific voice provider or amendment to the repository's hosted-key rules has been finalized.

### Referring, pointing, and highlighting

- Commander should interpret “this” and “that” using the current interaction context. Selection or active editing is the strongest signal; cursor position within the canvas is an additional pointing cue.
- Users can select multiple items or refer to them verbally by their visible placement, such as “the two images on the left” or “this document and the image beside it.” Commander should understand the current user-visible arrangement for comparison and combined work, not require users to know item names. Briefly highlighting the interpreted set makes mistakes correctable. Ambiguous references require clarification; a layout change must not silently redirect the request to different items.
- Comparison uses shared space for the selected items, with other open items available as corner previews. Relative adjustments such as “make the left one larger” and combined requests such as “use this document and these images to make a presentation” are part of the intended experience. Exact multi-selection and drag-to-compare gestures remain to be designed.
- Hovering alone does not change focus, trigger actions, or override an explicitly selected item. If multiple targets are plausible, Commander asks briefly and highlights the candidates.
- Commander can briefly highlight the interpreted target so the user can correct it naturally. Awareness of elements inside a live browser depends on that browser integration; it is not an existing universal capability.
- Commander has its own visually distinct pointer, separate from the user's cursor. It appears for purposeful explanation or browser actions rather than moving continuously.
- Highlight treatment follows the target: a brief illuminated outline for a whole panel; a spotlight or underline for a particular chart value, sentence, or image region; a visible action pointer for browser clicks and drags.
- Pointer and highlight timing follows Commander's reference or action. Explanatory highlights fade afterward. Neither steals or moves the user's cursor.
- The orb remains the conversational presence. The pointer communicates specific attention or action, and Commander's browser action pointer yields on human takeover.
- Exact colors, animation, accessibility alternatives, and indication of intended versus completed actions remain visual-design work.

### Interactive content and browser control

- Company records support meaningful actions in the canvas, subject to existing permissions and approval requirements.
- The browser vision is a **real shared, controllable browser**, not merely a webpage preview.
- Users can watch Commander operate the browser and interact themselves.
- Clicking or beginning to type in the browser automatically requests human takeover; Commander must yield further browser actions. Already completed actions cannot be undone merely by takeover.
- While the user controls the browser, conversation with Commander can continue.
- Inactivity can prompt “Shall I continue?” It does not silently return control to Commander.
- The user can hand control back through conversation. Automatic resume with a countdown was mentioned as a possible later preference, not the default or committed scope.
- Exact treatment of scrolling, hovering, in-flight actions, and connection loss needs a walkthrough.

### Background work

- Authorized work continues when the user changes topics or puts its panel away, within its existing limits.
- A compact indication makes ongoing work discoverable. Completion should attract appropriate attention without forcibly taking focus.
- Proposed notification treatment, accepted as a direction to explore: completed results receive a tray marker and may briefly show a small preview in an available corner. Requests waiting for an answer or approval retain a “Needs you” indicator while unresolved. Placement, duration, and motion remain open; “Ready” must be distinguishable from “Needs you.”
- Work requiring an answer or approval pauses at that boundary and asks.
- Hiding a browser under human control does not return control to Commander.
- Presentation and execution are separate: changing what is visible does not change what the user asked to be done.

### Failure and recovery

- If image generation fails, a browser disconnects, or another surface encounters an error, preserve its panel and available user inputs. Explain what happened in place and offer an appropriate recovery action or alternative.
- The rest of the canvas remains usable. Commander calls attention to failures blocking the current work; background failures remain clearly marked and discoverable without forcibly interrupting unrelated work.
- A recovery action must match the situation; retrying must not be presented as universally safe or equivalent to reconnecting an existing session. Technical retry behavior remains for later design.

### Returning and referring across conversations

- Each conversation remembers its canvas, including pinned items, open content, and focus; exact restoration behavior remains to be refined.
- Live content refreshes to current state. A browser reconnects only if the underlying session still exists; an expired session is not presented as live.
- Commander can retrieve relevant context from other authorized conversations within the company, when asked or when relevant on its own.
- Retrieved material retains an understandable source reference. Historical conclusions and current live records must be distinguishable.
- Referencing a live task in two canvases does not create two independent tasks.
- Cross-conversation reference does not mean copying all historical conversations into every response or granting access to another user's private material.

### Bringing in user material

- Support dropping an image or document onto the canvas, pasting a link, or selecting a file through conversation controls. The exact affordances remain visual-design work.
- Added material becomes a visible conversation item. Commander can use the newly added item as context for “look at this,” alongside selection and other reference cues.
- Adding material alone does not authorize starting a work job; users may want to explain their intent first. Loading and processing states must distinguish an attached item from content Commander has actually read.

### Generated interfaces

- Commander can compose familiar components and create custom interactive interfaces when the work calls for them.
- Examples include a comparison, interactive chart, and scenario calculator. Full internal applications are part of the future vision; their launch timing is unresolved.
- Generated work saves automatically with its conversation. Users should not have to decide whether to save while working.
- It can be recalled in another conversation. Frequently used creations can be added to a reusable tools collection.
- Sharing is deliberate and separate from saving. Sharing a tool does not expose the rest of the conversation or bypass data permissions.
- Users can request changes conversationally, such as “make it wider,” “add a filter,” or “change the chart.” Preserve existing inputs where compatible; behavior when an edit invalidates them remains open.
- For substantial creative alternatives, such as a different image style, retain the original and show the alternative alongside it. Small chart or tool changes update the visible item in place, with undo and accessible version history rather than another panel for every edit. “In place” describes presentation, not mutation of immutable artifact versions; technical design must preserve existing artifact invariants.
- The precise custom-interface safety and action model belongs to later technical design.

### One conductor

Commander is the conversational endpoint. Other agents are dispatched and report through Commander or their work surfaces. Inline questions from agents can be answered in context without creating a separate voice personality for each agent.

## 3. Proposed end-to-end walkthrough

### Supporting surfaces under exploration

#### Current composition direction — polished prototype (2026-09-10)

TK requested a more resolved interactive design, beyond the rough flow mock. The next study uses a floating top dock for navigation/work sources and a unified bottom conversation area for typing, captions, voice controls, and expandable transcript. This supersedes the earlier separated top-caption/bottom-input arrangement for this study.

The typing box is available by default, including during voice. TK subsequently asked to explore deliberately collapsing both the dock and conversation area into tiny controls; this is an explicit user-triggered exception to the default visible input. Each retains its own discoverable handle. They are not merged into one remote control, and controls never vanish completely. Expanding the transcript grows the bottom conversation surface without changing conversation identity. Commander moves independently of readable captions.

Prototype plan: (1) resolve typography, surfaces, lighting, and spatial proportions as one cinematic composition; (2) build top-dock and bottom-conversation expansion/collapse; (3) integrate purposeful orb motion and user placement; (4) demonstrate focus with corner previews, comparison, browser takeover, and a usable generated calculator; (5) expose a compact set of appearance preferences; (6) review this coherent prototype before further polish. These are local simulated interactions, not production implementation or a revised platform architecture.

Study created as `cockpit-design-study.html` in this conversation's visualization directory. Local browser checks covered both collapse/reopen flows, transcript expansion, browser takeover/handback, and calculator arithmetic. No page errors or horizontal overflow were observed in the tested 360px layout. Review found and corrected transcript overlap with the browser handback control. This verification covers the prototype interactions only; no production application tests or platform integration checks were run. The broader earlier mock remains a flow reference, while this study explores a more resolved visual composition.

Latest feedback (2026-09-10): TK finds the rough mock useful and wants to explore a floating, icon-led, expandable dock instead of the current full-width bottom bar. Its placement, collapse/hide behavior, and controls remain to be designed. The existing Commander cockpit contains useful sources such as running work, reviews, tasks, approvals, pinned items, memory, and budget; reuse their capabilities where appropriate, without assuming all categories belong permanently in the dock. Source checked: `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` on main.

TK also wants to move Commander's orb manually. Proposed behavior: manual placement remains respected until the user releases it back to automatic choreography. How placement interacts with the caption area and small screens remains open.

Experience customization is a design topic now, even though storage/configuration implementation is deferred. Proposed small set: dock position and auto-hide; visible shortcuts; orb automatic versus user-placed positioning; motion intensity including reduced motion; live-caption visibility; independent microphone and spoken-response controls. Keep a discoverable way to reveal hidden controls. Scope and defaults are not yet approved.

Subsequent agreement: group useful customization into one compact “Experience” menu, with good initial defaults, remembered user choices, and reset to defaults. Captions, microphone/spoken replies, motion, dock behavior, and orb placement are the intended categories; exact toggles and defaults will be refined together rather than treated as separate founder decisions.

- One collapsible tray holds earlier content, with related items grouped and progress markers for running work. Multiple trays are not currently recommended; the number and placement remain open for visual testing.
- A small live conversation area shows current speech and Commander's latest reply. It can expand into conversation history and collapse without leaving the canvas. Voice and typing controls may sit alongside it.
- The conversation area and content tray serve different purposes. Neither implies fixed content zones; their size, placement, and visibility remain proposals.
- On first entering canvas midway through a conversation, a proposed behavior is to surface the currently discussed content and make older material available in the tray. This automatic composition has not been explicitly settled.

This sequence is a discussion aid, not a finalized flow.

1. Open a Commander conversation and select its canvas icon. Commander is central in the fresh space.
2. Ask to work on a launch. A task and campaign image appear; Commander moves aside.
3. Say “focus on the image.” The image becomes dominant. The task remains accessible.
4. Ask for a second version. Work continues while the conversation moves to pricing.
5. Commander creates a scenario calculator. Change its inputs directly, then ask for another comparison field without losing compatible inputs.
6. Open a relevant website. Commander navigates; clicking inside requests takeover. Commander yields, and resumes only after the user agrees.
7. The image work finishes. A result indication appears without displacing the calculator or browser being used.
8. Leave and reopen the conversation. Saved content returns with current job and session status.
9. In a new conversation, ask for the earlier calculator. It appears with its source and the appropriate saved-versus-live data distinction.

## 4. Replatform alignment — context, not a new architecture

The local replatform integration checkout was inspected on 2026-09-09. Its program design already establishes a cloud control plane, multiple execution-target classes, governed browser sessions, and a planned Commander browser integration. Browser runtime code exists; that is not evidence that the entire browser journey is complete or release-ready.

The canvas should consume that foundation. It should not introduce a competing browser runtime, credential authority, or execution system. The inspected browser plan includes observations, artifacts, approvals, and cancellation. A complete live shared-view and human-takeover experience was not established by the inspected material and must be reconciled with the replatform owners during technical design.

The main-checkout handoff also overstates existing entity coverage: current ShowRef kinds do not directly include agent, objective, or budget. Reuse is a strong starting point, not proof every requested surface already exists.

Replatform source references, on branch `docs/replatform-program`:

- `docs/replatform/program-design.md`
- `docs/replatform/epics/E8-browser-automation/scope-addendum-agent-and-commander.md`
- `packages/browser-runtime/src/playwright-driver.ts`

These are branch-qualified references, not claims that the files exist in this main checkout. Recheck the evolving branch before technical planning.

## 5. Experience review — unresolved details

The first self-review found these questions worth resolving before the design is called complete:

| Area | What remains to experience or decide |
|---|---|
| First-use journey | Voice-enabled entry versus chat entry is settled in principle. Refine activation wording, microphone permission timing, capability discovery, and unavailable-voice feedback. |
| Focus and motion | Selection and cursor cues, manual-layout priority, and purposeful pointer/highlight direction are settled. Refine protection while reading, reduced-motion behavior, and how many simultaneous items remain usable. |
| Stage management | Pinning authority and preserving pins on clear are settled. Refine gestures, undo and recall, and overflow when many items are pinned. |
| Background work | Progress location, completion announcements, multiple simultaneous results, and exit behavior. |
| Browser handover | Feedback that takeover succeeded; scroll behavior; in-flight actions; reconnect; sign-in; expired sessions. |
| Conversation recall | When Commander retrieves proactively; how sources appear; avoiding surprising unrelated material. |
| Generated work | Versions and undo, preserving inputs through edits, saved versus refreshed data, reuse versus copying, recipients and sharing controls. |
| Voice failure | Poor recognition, unsupported voice setup, network loss, false interruptions, and switching smoothly to typing. |
| Entry and restoration | Lobby destination, remembering view preference, returning to old focus on a different screen size. |
| Visual identity | Cinematic character and pointer/highlight roles are settled. Refine orb behavior, exact visual treatments, sound, contrast, accessibility, and final name. |
| Release scope | Which portions must arrive together and which can follow without compromising the promised experience. |

## 6. Review findings and corrections

- **Avoid artificial either-or choices.** One item versus many, keeping versus tucking away, and local versus cloud can coexist under clear rules.
- **Saving and sharing are different.** Automatic persistence must not imply company-wide publication.
- **Hiding and stopping are different.** A visual transition must not silently cancel work or resume browser automation.
- **Interrupting speech and cancelling work are different.** The conversational rule is settled above. The interface must also distinguish cancellation requested from work actually stopped; stopping playback alone must not be represented as stopping a job.
- **Cinematic and usable must both be observable.** The intended animation needs a representative visual walkthrough, including reading and editing, before approval.
- **Voice quality is unproven.** Natural interruption is not exclusive to hosted realtime models; both local and hosted pipelines require evaluation. A provider key alone does not guarantee the requested feel.
- **Launch scope is not settled.** Agreement that capabilities belong in the vision is not agreement to ship all of them in the first release.
- **Technical choices remain deferred.** This draft does not define schemas, APIs, provider contracts, streaming transport, or a generated-code sandbox.

## 7. Next discussion

Remaining experience work is grouped into three areas: (1) refine the full interface composition, cinematic choreography, personalization, and name, (2) exercise complete journeys including internal applications, reusable tools, return/switch, interruption/recovery, and crowded/small-screen cases, and (3) review the full experience for gaps and consolidate it. Next is visual composition: the relationship of Commander, captions/input, floating dock, focused content, and corner previews. No first-release narrowing is required here. Technical architecture follows experience review; epics and version slices follow technical design.

An interactive concept mock was created on 2026-09-10 for review in the current conversation. It explores conversation, focus, comparison, browser takeover, and an approval card, with clickable tray/session navigation, pinning, clear/undo, and transcript expansion. Voice, browser activity, and approval effects are simulated; it is not application implementation. Dragging is illustrative; resizing and production persistence are not implemented. Approval-by-voice remains an open proposal. The mock is a discussion aid, not approval of its layout or release scope.

Revision 2 explores a floating icon-led dock, expandable earlier items and company-work examples, hide/reveal with a persistent handle, dock alignment, manually movable Commander with return to automatic placement, and separate simulated microphone/spoken-response controls. Orb movement supports dragging and arrow keys at desktop width. Narrow screens use automatic layout. These controls are proposals for review, not finalized product settings.

Revision 3 adds a presentation journey: select example source material, start simulated background preparation, put it aside, simulate completion, inspect three example slides, request a fixed sample revision of one slide, compare with its original, and explore separate download/sharing steps. Source previews remain in a corner of the focused presentation and can be brought forward. No live generation, actual PowerPoint export, sharing, or microphone capture occurs. The user agreed that the first result should be the presentation itself ready to inspect, accompanied by a short explanation; direct slide revisions and panel-level export are included in the journey for review.

Narration level remains a secondary personalization detail. The immediate next discussion is dock contents and what each control opens, followed by the bottom conversation area's compact, typing, and expanded-history states.

Walk through one complete experience visually, starting with opening a fresh canvas and bringing up the first piece of work. Refine the transitions and controls in this document as decisions are made. Then review a comparison, browser takeover, background completion, and returning later.

Once TK is satisfied with the full experience, review the design as a whole. Then proceed to technical design, and afterward divide the work into dependency-aware epics and release/version slices for implementation planning.

Document check: self-reviewed for internal contradictions, overclaims of shipped behavior, and accidental conversion of proposals into decisions. Open questions are intentional because this is a living draft. No application code was changed and no runtime tests were run for this document.

## 8. Quick external pattern review — 2026-09-10

This is a primary-source documentation review, not hands-on competitive testing or proof that any layout is superior. The following implications are design proposals, not new locked decisions.

| Reference | Documented behavior | Learning for Commander |
|---|---|---|
| [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) | Dedicated content window beside conversation; selection-based editing; version switching; multiple artifacts and downloads. | Keep the current editing target obvious, put version/export controls with the item, and make earlier work easy to recover. |
| [Gemini Canvas](https://support.google.com/gemini/answer/16047321?hl=en) | Documents, apps and slides; direct editing or conversational changes; Select & ask; autosave and export. | Support pointing and typing together. A generated result should be usable immediately and retain its own relevant controls. |
| [Google Opal in Gemini](https://blog.google/innovation-and-ai/models-and-research/google-labs/mini-apps-opal-gemini-app-experiment/) | Experimental reusable mini-apps accessible through the Gems manager. | Separate temporary conversation output from deliberately organized reusable tools, without forcing organization during creation. |

Browser-reference freshness: [OpenAI's Atlas transition guidance](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work) describes the standalone browser's retirement and distinguishes conversation history from browser data. Treat Atlas launch material as historical, not a current product baseline. For our design, restoring a canvas must clearly distinguish saved conversation content from a still-live browser session.

Superseded proposal: the generic Conversations / Canvas items / Work / Tools dock grouping was not accepted by TK. Do not treat it as the design baseline. First inventory the current Commander cockpit, explain each capability's purpose, and decide how those capabilities carry into the canvas; only then choose grouping and placement.

Current-source inventory: the cockpit has five groups: Triage (Inbox, Awaiting review, Approvals); My Work (Active work split Mine/Managed, Today, Sticky notes); Conversations (Discussions); Watch (Running now, plus opt-in Goals at risk, Budget pulse, Done today, Proactive findings, Teammates' activity); Memory & Context (Pinned, plus opt-in Memory retrieval audit). A separate In this conversation area lists conversation references. The registry contains nine default-on and six opt-in cards; actual visibility depends on preferences and data. The old registry-count comment is stale. The collapsed rail already exposes active-card icons, and settings let users show/hide cards.

Design interpretation: preserve access to these operational capabilities when entering canvas. Evaluate their individual jobs before collapsing categories. Conversation references can become canvas content/recall; company-level pins must remain distinct from the new instruction to keep a panel physically visible; Memory is retrieval inspection, not the transcript; Discussions are company discussion records, not Commander session switching. Placement and final dock grouping remain open.

Keep item-specific actions (edit, compare, versions, export) beside the focused item. Keep voice, typing, captions and transcript in the bottom conversation area. Test whether a user can find an earlier image, a pending decision, another conversation and a reusable tool without explanation. Then test both bars collapsed and a crowded canvas. Competitor documentation does not validate our animation, dock placement or discoverability; the prototype must establish those.

## 9. Deferred extension: Discussions, shared canvases and meetings

### Recorded decision: voice destination and agent communication

### Recorded decision: adding and forwarding material

Dropping a file onto empty canvas space adds material to the Commander conversation without starting work or posting to another thread. Dropping into a task/discussion reply composer, or choosing Attach there, adds it to that draft for review and sending. Drag targets highlight and explicitly label Add to canvas versus Attach to this task/discussion. The user may ask Commander to retrieve an accessible reference from elsewhere and bring it onto the canvas or relay it to the specified agent/task. Preserve source provenance and destination clarity. Fetching a reference does not itself authorize sending it elsewhere. Outgoing relayed messages are visibly attributed to Commander acting on behalf of the user; direct messages remain attributed to the user, and agent replies to the agent. Attachment interactions are agreed experience requirements; the current mock does not yet implement task attachment controls or drag destinations.

Voice addresses Commander by default, including while a task or agent conversation is focused. Opening or focusing a panel never silently changes the recipient. The primary experience is Commander communicating with an agent on the user's behalf when instructed, showing the destination and sent status and returning the agent's response to the user. Ordinary discussion with Commander is not automatically posted to the task or agent. Direct voice conversation with an agent remains a future explicit mode, not the default. Task/discussion text reply controls retain their clearly labelled destination. This decision applies to the current Commander canvas, independently of the deferred collaboration extension below.

TK explicitly separated this workstream from the current Commander canvas design. Preserve these ideas for a separate discussion and foundation-design effort; they are not implementation requirements for the present prototype. Commander canvas remains the active focus. Extend the canvas experience into Discussions after the relevant communication and collaboration foundations are established. This does not require all Commander canvas work to wait for Discussions.

### Direction to carry into the separate workstream

- Evolve Discussions into live human and agent collaboration: ongoing team/project channels, topic threads, direct messages and group conversations, while preserving links from conversations to tasks, decisions, goals and artifacts.
- Consider a broader UI name such as Conversations; naming, channel/thread hierarchy and classification are proposals, not locked changes. No DB/API rename is implied.
- A discussion thread may have both conversation and canvas views of the same work. Bringing a discussion into a Commander canvas is distinct from entering that discussion's own canvas. Whether a channel has an overview canvas, and how it relates to thread canvases, remains unresolved.
- Inviting someone into a personal Commander canvas is also an exploratory collaboration capability. Personal means private by default. Shared scope, history visibility and view/edit access need explicit experience design.
- Latest preferred collaboration model supersedes the earlier personal-arrangement suggestion: shared objects and shared layout, independent pan/zoom, optional follow/spotlight. Moving a shared item affects the common layout. Commander can participate and point to shared material without automatically rearranging content people are using.
- Explore meetings as live sessions associated with the workspace: participants, transcription, supporting material, notes and proposed action items; retain the resulting material with the discussion after the meeting. Meet, Teams and Zoom are integration candidates, not verified embedding or live-transcription capabilities. Native meetings versus linked provider windows remains open.
- Distinguish addressing Commander from ordinary meeting speech, and private assistance from contributions visible to the group. Participant access and recording/transcription awareness require design in the separate workstream.
- Organization invitations and invitations to a particular conversation/canvas are separate actions; Team and participant controls are candidate entry points.

Reference: [Buzz by Block](https://github.com/block/buzz) documents shared human/agent rooms, canvases and voice huddles. It is an adjacent product reference, not a specification to copy or evidence that equivalent AoA capabilities exist.

### Current canvas discussion checkpoint

Tray proposal under review: Canvas, Inbox, Work, Discussions, Goals; Saved may be a separate entry or secondary access. TK did not want a broad Overview entry; Goals should expose relevant goals rather than only at-risk goals. Budget/team monitoring can remain accessible without permanent tray entries. Reminders and notes remain useful existing capabilities. Memory inspection is conversation-level retrieval inspection, not proven per-answer citation attribution.

Proposed item behavior: selecting/dropping a task opens its workspace panel with conversation/status/outputs; opening an artifact brings the same underlying artifact forward with a link to its task. A discussion opens its thread panel; linked work can open beside it. Task/discussion replies must have a clearly distinct destination from Commander input. These are experience proposals, not claims of implemented canvas interactions.
