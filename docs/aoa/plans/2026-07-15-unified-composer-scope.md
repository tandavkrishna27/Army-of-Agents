# Unified Composer Experience — Product Scope

**Status:** Draft for founder review  
**Date:** 2026-07-15  
**Baseline audited:** `origin/main` at `a0afa102c` (PR #288 merged)  
**Scope type:** Product and UX contract; not an implementation plan  
**Surfaces:** Commander, Discussions, Workspace, Task detail/comments, Commander focus panes

## 1. Executive summary

AoA currently presents several chat-like inputs that look and behave differently even when they render the same underlying component. The product does not need one universal backend message type. It needs one reliable, recognizable composer experience with capability profiles for three different communication domains:

1. **Commander:** a private, streamed conversation with AoA's operating assistant.
2. **Discussion:** a collaborative thread where people and agents coordinate, attach evidence, and create durable organizational context.
3. **Task/Workspace:** execution feedback recorded as task comments that may wake, interrupt, or redirect an assigned agent.

The scope establishes:

- One shared visual anatomy and interaction contract.
- Attachments, including images, across every composer.
- Structured mentions whose meaning is explicit per surface.
- A shared slash-command framework with surface-specific command registries.
- Safe draft, upload, submission, retry, and duplicate-prevention behavior.
- Conversation-isolated Commander CLI sessions.
- Correct Discussion posting authorization.
- Responsive behavior for full pages, focus panes, slide-overs, and mobile.

The scope does **not** collapse Commander messages, Discussion entries, and task comments into one persistence model. Their lifecycle, permissions, side effects, and audit requirements remain distinct.

## 2. Problem statement

Users encounter chat-like composers in multiple places but cannot rely on the same controls or behavior:

- Attachments exist in Discussions and Workspaces, are image-only in Task Comments, and are unavailable in Commander.
- `/skill` is real in Commander, dormant in one shared editor, and absent elsewhere.
- `@mentions` are rich in Discussions and Task Comments, unavailable in Workspace UI, and shown as disabled chrome in Commander.
- Enter sends in Commander while Cmd/Ctrl+Enter sends elsewhere.
- Draft and error recovery differ by surface.
- The same task-comment backend has different capabilities in Workspace and Task Comments.
- Some controls imply effects that do not happen, such as “Message Agent” on a closed task where the server records a comment but does not wake the agent.

This inconsistency increases hesitation, causes data loss on failures, and makes narrow panes feel like reduced products instead of alternate presentations of the same capability.

## 3. Verified current-state map

This scope uses the merged Commander pane implementation on `origin/main`.

| User-visible surface | Current implementation | Domain record created |
|---|---|---|
| Commander page | `CommanderInput` inside `InternalAgentPanel` | `internal_agent_messages` in a Commander conversation |
| Commander Discussion focus pane | Embedded `ThreadDetail` → `ThreadTab` → `EntryComposer` | Discussion entry |
| Full Discussion | `ThreadDetail` → `ThreadTab` → `EntryComposer` | Discussion entry |
| Full Workspace | `WorkspaceLayout` → `WorkspaceTimeline` | Task comment, possibly followed by agent wakeup |
| Task slide-over Workspace mode | `TaskDetail` → `WorkspaceTimeline` | Same task comment contract |
| Commander task/workspace focus pane | `CommanderTaskFocusPane` → `TaskDetail(initialMode="workspace")` → `WorkspaceTimeline` | Same task comment contract |
| Task Comments tab | `CommentThread` → `MarkdownEditor` | Same task comment domain with different UI capabilities |

Commander also has a lightweight Discussion reference preview inside its generic viewer. That preview is not a second Discussion composer and remains read-oriented.

## 4. Product principles

### 4.1 Consistent does not mean identical

Every composer should be immediately recognizable, but controls appear only when their behavior is real. A disabled paperclip or mention button marked “coming soon” creates noise and false expectations.

### 4.2 A file is not complete when it uploads

Attachment support is complete only when all four stages work:

1. The user can select, paste, or drop it.
2. The message and attachment persist atomically or recover safely.
3. Other users can preview or download it.
4. The intended Commander/agent can access its bytes or extracted content, subject to adapter capability and permission.

### 4.3 Visible content and routed metadata must agree

Mentions, attachment tokens, and skill tokens must have one source of truth. Removing a visible token removes its routing metadata. Editing text cannot leave hidden stale routing state.

### 4.4 Failures must be recoverable

No failed send or upload may silently discard text, tokens, or files. A user should always be able to Retry, Edit, or Discard.

### 4.5 Durable knowledge has a deliberate home

Commander attachments are conversation-local by default. Users may promote them to Artifacts or Discussions. This preserves DA-22: Commander is not the accidental permanent home for organizational knowledge.

### 4.6 Domain side effects remain explicit

- Commander Send starts or resumes an assistant turn.
- Discussion Send adds a durable collaborative entry and may summon/notify mentioned participants.
- Workspace Send adds a task comment and may wake an agent.
- Closed-task and planning-mode behavior must be stated before submission.

## 5. Goals

1. Make every composer look and behave like part of one AoA system.
2. Support files and images on every surface.
3. Give attachments consistent selection, preview, progress, retry, removal, and accessibility behavior.
4. Make recipient access to attachment content part of the attachment contract.
5. Provide structured, unambiguous mentions wherever a real routing action exists.
6. Provide one slash-command interaction model with commands filtered by surface and permission.
7. Preserve drafts across full-page, pane, slide-over, and mobile presentations.
8. Prevent duplicate sends and newer-draft erasure.
9. Surface offline, upload, send, permission, and domain-state failures inline.
10. Preserve existing domain-specific persistence, permissions, activity logs, and side effects.
11. Fix the two verified contract problems before calling the experience reliable.
12. Meet keyboard, touch-target, focus, screen-reader, reduced-motion, and narrow-layout requirements.

## 6. Non-goals

1. Replacing Commander, Discussion, and task-comment tables with a universal messages table.
2. Converting every editor to Markdown as a prerequisite.
3. Adding voice recording or transcription to every composer in this workstream.
4. Inventing Discussion or Workspace slash commands that have no server contract.
5. Making every model vision-capable. The UI must disclose when an attachment is stored but cannot be interpreted by the active runtime.
6. Redesigning message bubbles, full timelines, Discussion extraction cards, run viewers, or the broader pane system except where required to integrate the composer.
7. Changing locked Discussion intake, task checkout, approval, budget, or heartbeat semantics.
8. Treating a visual mockup as an implementation specification. Engineering planning follows founder selection.

## 7. Shared composer anatomy

Every variant is composed from the same conceptual regions. Regions with no active capability are omitted rather than disabled.

```text
┌──────────────────────────────────────────────────────────────┐
│ Context/status strip (optional)                              │
│ Reply target · agent/run state · closed/planning state       │
├──────────────────────────────────────────────────────────────┤
│ Token and attachment tray (when populated)                   │
│ @mentions · /skills · files · upload progress · failed items │
├──────────────────────────────────────────────────────────────┤
│ Auto-growing editor                                          │
│ Context-specific placeholder and accessible label            │
├──────────────────────────────────────────────────────────────┤
│ + Add   context tools                    shortcut   Send/Stop │
└──────────────────────────────────────────────────────────────┘
│ Inline error / Retry / Edit / Discard (when needed)          │
```

### 7.1 Required shared primitives

- `ComposerFrame`
- `ComposerContextStrip`
- `ComposerEditor`
- `ComposerTokenTray`
- `ComposerAttachmentTray`
- `ComposerAddMenu`
- `ComposerCommandMenu`
- `ComposerSubmitControl`
- `ComposerSubmissionError`
- `useComposerDraft`
- `useComposerSubmission`
- `useComposerAttachments`

These names describe responsibility, not a locked implementation architecture.

## 8. Shared interaction contract

### 8.1 Keyboard

- `Enter`: send (approved founder decision).
- `Shift+Enter`: newline.
- `Cmd/Ctrl+Enter`: send alias.
- `Enter` while an `@` or `/` menu is open: choose the highlighted result; never send.
- `Escape`: close the active autocomplete/menu before closing a pane.
- IME composition Enter never sends.
- Every submit path calls the same synchronous in-flight guard.

The Enter-to-send choice is approved for all surfaces. Long-form capture uses `Shift+Enter` for newlines.

### 8.2 Submission

1. Snapshot text, structured tokens, files, reply target, and domain action.
2. Generate a client submission/idempotency key.
3. Block a second submission synchronously.
4. Submit the snapshot, not live editor state.
5. Clear only the snapshot that was accepted.
6. Never clear newer content typed while an older request is pending.
7. On failure, retain or restore the snapshot and expose Retry, Edit, and Discard.
8. A retry reuses the idempotency key where supported.

### 8.3 Drafts

Draft keys include:

- Company ID.
- User ID.
- Surface/domain.
- Entity ID: Commander conversation, Discussion/thread plus reply target, or task.

Drafts include text, tokens, attachment references/upload state, and selected domain action. Drafts survive switching between full-page and embedded presentations of the same entity. Successfully accepted content is removed from the draft.

`sessionStorage` is the minimum privacy-preserving baseline. Longer-lived local drafts may be considered later.

### 8.4 Offline and reconnecting

- Known-offline state disables network submission but preserves editing.
- The context strip states “Offline — draft saved” or “Reconnecting…”.
- Already-uploaded attachments remain attached.
- Pending uploads either pause safely or fail visibly with Retry.

## 9. Attachment contract

### 9.1 Universal entry points

Every composer supports:

- File picker.
- Paste from clipboard.
- Drag and drop.
- Add existing AoA Artifact, where permitted.
- Upload as tracked Artifact, where permitted.

Images are files, not a separate attachment mode.

### 9.2 Initial common allowlist

- Images: PNG, JPEG, WebP, GIF.
- Documents: PDF.
- Text: TXT, Markdown, JSON.
- Maximum 5 attachments per message.
- Maximum 10 MB per attachment.

Existing Discussion generic-asset limits must be reconciled with this composer contract. Future Office document types require an explicit preview/extraction strategy rather than being silently accepted.

### 9.3 Attachment tray

Each item shows:

- Thumbnail for images; type icon otherwise.
- Filename and compact size.
- Uploading/progress state.
- Uploaded state.
- Failed state with reason and Retry.
- Remove action.
- “Saved as Artifact” state when applicable.

The same tray supports keyboard removal and announces progress/errors through an appropriate live region.

### 9.4 Persistence by domain

#### Commander

- Create a company-scoped asset.
- Link it to the Commander conversation/message.
- Add an `asset` Commander input-reference kind.
- Expose the asset to Commander through a governed read mechanism or adapter-resolved local path.
- Conversation-local by default.
- Offer “Save as Artifact” and “Send to Discussion” promotion actions.

#### Discussion

- Reuse Discussion entry attachment records.
- Persist entry plus attachment references atomically.
- Include pending attachments in the draft.
- Render image previews in the thread.
- Make attachment bytes/text available to extraction and summoned agents through a governed attachment context contract.

#### Task/Workspace

- Use one task-comment attachment contract in Workspace and Task Comments.
- Persist comment plus attachments atomically.
- Preserve attachment metadata in wakeup context.
- Make supported files available to the assigned/mentioned agent.
- Replace Task Comments' image-only picker with the shared allowlist.

### 9.5 Attachment-only messages

Recommended product rule: allow attachment-only messages on all three domains.

- Accessible fallback label: “Attached N files.”
- The fallback is presentation metadata, not fake user-authored prose.
- Discussion extraction receives explicit attachment metadata/content, not merely the fallback label.

This changes the current Discussion validator and must be implemented across shared validation, server behavior, UI, and tests together.

### 9.6 Runtime understanding

The recipient-access contract distinguishes:

- **Text-readable:** the runtime can read extracted/plain text.
- **Vision-readable:** the active adapter/model can receive the image.
- **Stored only:** the file is preserved and downloadable, but the active runtime cannot interpret it.

The UI must not imply that an agent “saw” an image when it only received a filename. Unsupported cases show a concise disclosure and may offer OCR or model-switch actions in a later workstream.

## 10. Mention contract

### 10.1 Shared token model

Mention tokens carry structured data:

```ts
type ComposerMention = {
  kind: "agent" | "human" | "project";
  id: string;
  label: string;
};
```

- The visible token and submitted routing data derive from the same model.
- Removing the token removes its routing data.
- Server validation verifies company membership and authorization.
- Raw `@Name` parsing remains backward compatibility, not the canonical path.
- Duplicate display names never determine routing.

### 10.2 Meaning by surface

| Surface | `@agent` | `@human` | `@project` |
|---|---|---|---|
| Commander | Add context for Commander; no direct wakeup | Add context for Commander; no direct notification | Add project context |
| Discussion | Summon/route agent into thread | Notify participant | Add context/link only |
| Task/Workspace | Wake mentioned agent against task | Notify person | Add task context/link only |

Commander delegation remains a governed tool action. Merely mentioning someone must never bypass approval or permission rules.

## 11. Slash-command contract

One command-menu interaction is shared; command registries are surface-specific.

### 11.1 Commander

- `/skill` is active.
- Skill selection inserts an atomic token.
- The token expands to the governed `use_skill` directive on send.
- The `+` menu and slash trigger open the same skill registry.

### 11.2 Discussion

- `/` remains ordinary text until real Discussion commands ship.
- Candidate future commands: `/summarize`, `/scope`, `/extract`, `/dispatch`.
- No command is shown until its permission, confirmation, activity-log, and error contracts exist.

### 11.3 Task/Workspace

- `/` remains ordinary text initially.
- Candidate future commands: `/reopen`, `/interrupt`, `/assign`, or an explicit agent-skill invocation.
- A command must state whether it adds a comment, changes task state, wakes an agent, or interrupts a run.

### 11.4 Task Comments dormant behavior

The shared Markdown editor's unused slash capability must either receive a valid registry and company context or stay intentionally inactive. Dormant autocomplete is not considered delivered functionality.

## 12. Surface profiles

### 12.1 Commander profile

**Context strip:** active conversation/context references when present.  
**Editor:** rich token-aware editor.  
**Capabilities:** skills, structured entity mentions, files/images, referenced AoA entities.  
**Submit:** streamed Send → Stop.  
**Copy:** “Message Commander…”  
**Special states:** streaming, stopping, tool confirmation, runtime error, retry turn.

Unavailable controls are hidden, not disabled as “coming soon.”

### 12.2 Discussion profile

**Context strip:** reply target, offline/reconnecting, thread phase when action-relevant.  
**Editor:** token-aware multiline chat editor.  
**Capabilities:** agent/human mentions, files/images, existing/tracked artifacts, reply.  
**Submit:** durable entry with optimistic echo only when rollback is reliable.  
**Copy:** “Message discussion… @mention to bring someone in.”  
**Special states:** upload failure, summon receipt, sent/not-sent receipt, presence.

The same profile is used full-page and inside Commander. Commander may supply the draft owner but cannot change message semantics.

### 12.3 Task/Workspace profile

**Context strip:** assigned agent, run state, task state, planning/closed state.  
**Editor:** token-aware task-comment editor.  
**Capabilities:** files/images, agent/human mentions, project context, assigned-agent actions.  
**Submit:** explicit domain action.

Open task actions:

- “Send and wake agent” when dispatchable.
- “Add comment” when no agent is assigned.
- “Comment only” when policy suppresses wakeup.

Closed task actions:

- “Add comment.”
- “Reopen and send” when permitted.

Active run actions:

- Send a non-interrupting comment.
- Separate permission-gated “Stop run” or “Interrupt and send” action.

The same profile is used in full Workspace, Task slide-over Workspace mode, Commander task focus, and Task Comments. Host density may differ; semantics may not.

## 13. Responsive and host behavior

### 13.1 Density variants

- **Comfortable:** full-page Commander, Discussion, and Workspace.
- **Compact:** Commander focus panes and Task slide-over.
- **Mobile:** full-width sheet/page with bottom-safe-area padding.

Density changes spacing and label presentation, not available capabilities or draft behavior.

### 13.2 Narrow layout rules

- Primary Send/Stop remains visible.
- Attachment and context tokens wrap above the editor.
- Secondary actions move into `+` overflow.
- Status copy truncates with an accessible full label.
- No horizontal composer scrolling.
- Touch targets are at least 44×44 CSS pixels or meet the WCAG spacing exception.
- Composer respects mobile safe-area insets.

## 14. Visual system

- Use semantic design tokens only; no literal `#b82d1c` or fallback surface hexes.
- Brand red is reserved for the primary Send action and critical active Stop state.
- Composer frame uses neutral card/field surfaces.
- Focus follows the design-system 3px brand glow plus brand border.
- Error state uses semantic destructive tokens without replacing the draft.
- Mention, skill, file, and entity tokens use distinct semantic token families but remain readable in dark and light themes.
- Commander message bubbles remain governed by Decision #101 and are outside this composer's visual redesign.

## 15. Accessibility contract

1. Every editor has a persistent programmatic label, not only placeholder text.
2. Toolbar buttons have visible labels or accessible names and tooltips.
3. Upload progress, failures, sent state, and reconnecting state are announced without excessive repetition.
4. Token removal is keyboard accessible.
5. Autocomplete exposes listbox/option semantics and active descendant state.
6. Focus is always visible.
7. Color is never the only indicator of token kind, failure, or selection.
8. Reduced motion disables upload shimmer, pulse, and nonessential transitions.
9. Screen readers receive attachment filename, type, size, state, and removal label.
10. Mobile zoom and software keyboard do not obscure the Send control.

## 16. Verified correctness prerequisites

These are part of the workstream, not optional cleanup.

### 16.1 Commander CLI session isolation

Current Codex runtime continuity is keyed by `companyId:userId` while the UI and database support multiple Commander conversations.

Required contract:

```text
companyId:userId:conversationId
```

All runtime-session lookup, resume, replacement, idle cleanup, conversation deletion, and reset paths must use the conversation-specific key. Regression coverage alternates A → B → A and proves independent provider session IDs and context.

### 16.2 Discussion posting authorization

Create one canonical `assertCanPostToThread` policy aligned with visibility and participation rules.

Coverage must include:

- Founder.
- In-scope lead.
- Out-of-scope lead.
- Private-thread participant.
- Private-thread nonparticipant.
- Team member participant.
- Agent participant/caller where supported.
- Cross-company denial.

Hidden threads return the established non-disclosing error behavior.

### 16.3 Submission reliability

- Discussion parent submission rejection must propagate to the composer.
- Workspace must expose plain and multipart failures.
- Workspace must not clear newer drafts.
- All paths must prevent concurrent duplicate submission.
- File-upload failures must never be silently swallowed.

## 17. Capability matrix — target state

| Capability | Commander | Discussion | Task/Workspace |
|---|---:|---:|---:|
| Text and multiline | Yes | Yes | Yes |
| Files and images | Yes | Yes | Yes |
| Paste/drop | Yes | Yes | Yes |
| Attachment-only | Yes | Yes | Yes |
| Existing Artifact | Yes | Yes | Yes, where relevant |
| Tracked Artifact upload | Optional/promote | Permission-gated | Permission-gated |
| Structured `@agent` | Context | Summon | Wake against task |
| Structured `@human` | Context | Notify | Notify |
| `/skill` | Yes | No initially | No initially |
| Draft persistence | Conversation | Thread + reply target | Task |
| Inline retry | Yes | Yes | Yes |
| Send/Stop | Stream Stop | Send | Send plus run action |
| Offline disclosure | Yes | Yes | Yes |
| Full/narrow/mobile parity | Yes | Yes | Yes |

## 18. Scope boundaries for engineering planning

The later implementation plan should divide work by contract boundary, not by page:

1. Correctness and security prerequisites.
2. Shared composer state and visual primitives.
3. Shared structured mention and command model.
4. Shared attachment upload/draft/presentation pipeline.
5. Commander adapter and conversation-attachment delivery.
6. Discussion adapter and extraction/agent attachment delivery.
7. Task-comment adapter and Workspace/Comments consolidation.
8. Host migration: full pages, Commander focus panes, Task slide-over, mobile.
9. Cross-surface QA, accessibility, and failure injection.

No page should ship a partially migrated composer that looks complete while retaining silent failure or inaccessible attachment behavior.

## 19. Acceptance criteria

### 19.1 Universal

- The same entity draft appears when switching between full and embedded presentations.
- Files can be selected, pasted, and dropped.
- Images show previews; other files show type, name, and size.
- Upload and send failures preserve recoverable state.
- Repeated keyboard/button submission creates one domain message.
- A later draft is not erased when an earlier request completes.
- Every visible control has a real supported action.
- Keyboard, screen reader, mobile, dark mode, light mode, and reduced-motion checks pass.

### 19.2 Commander

- Separate conversations never share provider resume sessions.
- File/image attachments persist with the message and are available to the active runtime when supported.
- Unsupported runtime interpretation is disclosed.
- `/skill`, entity context tokens, files, Send, and Stop coexist without editor corruption.
- Failed turns offer Retry without manual copying.

### 19.3 Discussion

- Posting permission matches the approved visibility/participant policy.
- Mention removal cannot leave hidden or contradictory routing.
- Failed entry sends retain text, mentions, and attachments.
- Full-page and Commander-embedded Discussion use the same capabilities.
- Attachment-only entries persist and render accessibly if that recommendation is approved.

### 19.4 Task/Workspace

- Full Workspace, Task slide-over, Commander task focus, and Task Comments share task-comment composer semantics.
- Closed/planning/unassigned/active-run states state the actual side effect before send.
- Mentions route by structured IDs.
- General files and images work in Task Comments, not only Workspace.
- Stop/interrupt remains separate, permission-gated, and auditable.

## 20. Test and QA matrix

Required automated coverage includes:

- Plain send success/failure.
- Multipart success/failure.
- Per-file upload failure and retry.
- Attachment-only send.
- Delete mention text; remove mention token; duplicate names.
- Slash selection, Escape, Enter, Shift+Enter, Cmd/Ctrl+Enter, IME Enter.
- Deferred request followed by a newer draft.
- Rapid/repeated submit.
- Offline and reconnect transitions.
- Conversation/thread/task draft-key isolation.
- Commander A → B → A runtime isolation.
- Discussion posting authorization matrix.
- Closed, planning, unassigned, active-run task states.
- Full page, Commander focus pane, Task slide-over, and mobile.
- 375px, tablet, standard desktop, and ultrawide layouts.
- Keyboard focus order and accessible names.
- Dark/light/high-contrast and reduced-motion behavior.
- Adapter supports text only, text-file reading, and vision-capable image input.

## 21. Mockup brief

Mockups should demonstrate the system rather than one isolated empty textarea.

### Required screens/states

1. Full-page Commander composer with skill token, entity mention, image, PDF, and streaming Stop.
2. Commander Discussion focus pane with presence, agent/human mentions, failed upload retry, and nested viewer edge.
3. Full Workspace with assigned-agent status, task state, files, mention, Send, and Stop-run affordance.
4. Task slide-over compact Workspace composer.
5. Mobile Discussion or Task composer with wrapped tokens, attachment preview, and software-keyboard-safe actions.
6. Inline failed-send recovery state.

### Proposed design directions

#### A. Quiet Operator

One neutral framed composer, compact contextual header, calm attachment tray, and a single strong Send/Stop control. Optimizes clarity, density, and consistency with AoA's existing dark operating-system aesthetic.

#### B. Layered Workbench

Editor remains visually central while context, files, and commands occupy collapsible layers above and below it. Optimizes power-user capability and complex Workspace/Discussion states without crowding the writing area.

#### C. Context Rail

A narrow contextual rail or leading column carries actor/run/reply state while the editor and attachment canvas remain clean. Optimizes panes and wide screens, with a stacked transformation on mobile.

The mock stage should compare hierarchy, discoverability, narrow-pane behavior, attachment handling, and error recovery—not merely color themes.

## 22. Founder decisions before engineering planning

1. **Keyboard:** approve Enter-to-send everywhere, with Shift+Enter newline and Cmd/Ctrl+Enter alias?
2. **Discussion attachment-only:** approve changing the current contract to allow it?
3. **Commander file lifetime:** approve conversation-local by default with explicit promotion to Artifact/Discussion?
4. **Runtime interpretation:** should OCR fallback for non-vision models be in this workstream or a follow-up?
5. **Task active-run send:** default to non-interrupting comment, with a separate “Interrupt and send” action?
6. **Mock directions:** generate A, B, and C, or adjust/drop a direction before image generation?

## 23. Recommended defaults

- Approve Enter-to-send with the stated safeguards.
- Allow attachment-only messages everywhere.
- Keep Commander attachments conversation-local unless promoted.
- Treat OCR fallback as a follow-up; accurately disclose stored-only images now.
- Default task send to non-interrupting; make interrupt explicit and governed.
- Generate all three mock directions before selecting one.

## 24. Design direction decision

**Selected: A — Quiet Operator.**

Quiet Operator is the baseline for detailed design and engineering planning. The conversation remains visually primary; contextual controls appear progressively instead of permanently competing with the message history and writing area.

The following useful ideas from the other explorations remain available as conditional patterns:

- Use a compact disclosure or tray when a composer has multiple attachments, commands, or contextual entities. Do not show the full Layered Workbench stack by default.
- Use a compact horizontal context summary in narrow panes when destination, visibility, participants, files, or agent-run state would otherwise disappear. Do not add a permanent desktop Context Rail.
- Keep the same Quiet Operator anatomy across Commander, Discussion, Workspace, embedded panes, and slide-overs; vary only the domain-specific context and actions described in this document.

This decision supersedes the open mock-direction question in section 22. The recommended behavioral defaults in section 23 are also approved for planning.

## 25. Quiet Operator design contract

The approved direction is a layout contract, not just a mood. These rules remove the ambiguity visible in the first mock board.

### 25.1 One composer frame

Every surface uses one bordered `ComposerFrame` containing, in this order:

```text
Context/status strip (only when action-relevant)
Attachment and token tray (only when populated)
Auto-growing editor
Toolbar and primary Send/Stop control
Inline error/retry row (only when needed)
```

Attachments never render in a detached side panel, outside the task pane, or below the host container. In the Task/Workspace pane they remain visibly inside the composer frame, immediately above the editor.

### 25.2 Attachment presentation

- Desktop/full page: attachment cards sit in one horizontal row inside the frame; image cards show a thumbnail, non-images show a type icon, and every card shows filename, compact size, state, and Remove.
- Compact pane/slide-over: cards remain inside the frame and wrap to multiple rows; each card has a minimum readable width, then collapses to a compact row with filename, state, and an accessible overflow menu.
- Narrow/mobile: cards become a vertical list inside the frame; the editor remains below the list and the Send/Stop control remains fixed in the frame footer.
- Uploading and failed cards occupy the same slot as ready cards. Failure adds Retry and Remove; it never moves the item to a separate error area.
- Attachment-only messages show the ready cards in the frame with no invented text in the editor.

### 25.3 Surface differences that are intentional

| Surface | Persistent context visible above frame | Attachment placement | Primary action |
|---|---|---|---|
| Commander | Conversation and active stream state | Inside frame, above editor | Send or Stop |
| Discussion | Reply target and visibility/participant state | Inside frame, above editor | Send |
| Workspace/task pane | Assigned agent, task state, and run state | Inside frame, above editor | Send/wake, Comment, or governed Interrupt |
| Embedded Commander discussion | Discussion destination and reply target | Same Discussion frame inside pane | Send |

The frame anatomy, attachment placement, token behavior, draft ownership, and error recovery are shared. Only the context strip, copy, and domain action differ.

### 25.4 Required focused mock states before implementation

The next design artifact must show each of these at readable size, with the attachment tray inside the same frame:

1. Commander desktop: two ready files, one image thumbnail, `@Maya`, `/research`, and streaming Stop.
2. Discussion full page: image plus PDF, mention menu, and failed-upload Retry.
3. Task/Workspace slide-over: one attached file visibly inside the pane composer, `Atlas is working`, queued-send notice, and separate Interrupt.
4. Embedded Commander discussion pane: compact wrapped attachment row and preserved destination header.
5. Narrow/mobile: vertical attachment list, attachment-only send, and safe-area footer.
6. Send failure: draft, tokens, and attachments remain in the same frame with Retry/Edit/Discard.

These focused mocks are the visual reference for engineering planning. The earlier comparison board remains useful for direction selection but is not sufficient as an implementation reference.

## 26. Approved mockups

The founder approved the focused Quiet Operator references on 2026-07-15.

| Reference | Path | Use |
|---|---|---|
| Surface reference | `C:\Users\TK\.gstack\projects\aoa-2-5\designs\quiet-operator\quiet-operator-surface-reference.png` | Commander, Discussion, Task/Workspace slide-over, and embedded pane anatomy |
| Responsive and recovery states | `C:\Users\TK\.gstack\projects\aoa-2-5\designs\quiet-operator\quiet-operator-responsive-recovery.png` | Mobile, compact pane, drag-over, upload, failure, attachment-only, and offline behavior |

The attachment placement shown in these boards is binding: the attachment tray is inside the ComposerFrame and above the editor at every density.
