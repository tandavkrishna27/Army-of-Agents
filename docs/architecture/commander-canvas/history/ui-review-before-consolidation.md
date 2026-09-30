# Universe UI review — 11 September 2026

Status: agreed design direction; interactive mock only, not production behavior.

## AoA theme follow-up

Unified dock follow-up: replace separate Conversations and Commander restore icons with one Commander action plus a history dropdown. Main action restores current presentation; dropdown switches or starts conversations. Open panels occupy a separate stable-order dock group; available width determines visible icons, with remaining items behind a counted overflow list containing thumbnails, titles, and search. Left shortcuts reference the same conversation-scoped open-panel registry. Minimize retains the dock entry; close removes it without canceling work. Chat has independent width/height resizing, maximize/restore, a scrollable history area, and fixed header/input. Latest mock is `universe-unified-dock.html`. A headless browser check verified restore, chat maximize/restore, overflow, and history scroll styling without script errors. The standalone check did not load the host-supplied icon renderer; appearance should still be reviewed in the inline mock. Production behavior and backend persistence remain unimplemented.

Commander presentation follow-up: movable/resizable chat with return-to-bottom action; blob with plain captions and a separate open-chat action; fully tucked presentation recoverable through the tray. Drafts and authorized work remain intact. Mute mic, silence speaker, and end voice appear beneath the blob on hover/focus or tap, with persistent muted-state hints. End voice is distinct from hiding Commander. Panel warnings must not become transcript labels. AoA mark toggles the tray; remove the separate collapse arrow. Updated mock: `universe-commander-controls.html`. Voice is simulated; scripts pass syntax parsing, but this iteration has not had browser interaction validation.

Latest tray default correction: start expanded (Always visible). Show the AoA mark at the start of the expanded tray, followed by a subtle separator and action icons. Remove the duplicate canvas-corner brand. The same mark remains as the collapsed reveal button. Auto-hide is opt-in; this supersedes the initial Auto-hide mock default below.

Tray follow-up: keep top placement for the first version. Settings offers Always visible and Auto-hide. Auto-hide leaves a small real AoA wordmark reveal button, with no running/needs-you sentence. Mouse hover, click/tap, and keyboard focus reveal the icons; open menus keep the tray available. Returning to work dismisses it. Detailed status stays in the right attention area; future badge counts belong on relevant tray icons. The `universe-brand-tray.html` mock demonstrates this behavior with Auto-hide initially selected. Other docking edges are deferred.

The default Universe theme uses the actual AoA wordmark from `ui/src/onboarding/motion/AoaLogo.tsx`, including its red dot, and the neutral/red direction of `ui/src/index.css`. The mock's lighter red accent is a presentation adaptation for dark-surface readability, not a replacement brand color.

User-facing Universe settings include light/dark/system appearance, accent, Commander style (fluid, orbital rings, minimal glow), separate or matching Commander color, motion (full/subtle/reduced), grid (dots/lines/none), intensity, and snap-to-grid. Start with one AoA default; additional accents are customization choices. Reset restores the branded appearance. Motion must honor reduced-motion preferences. Listening, thinking, and speaking animation states remain implementation requirements; the mock's breathing animation is simulated and not audio-reactive.

The updated `universe-aoa-theme.html` mock preserves tray, thumbnails, visibility controls, and panel icons. Settings changes are session-local. React Flow remains the production canvas direction; this mock does not implement React Flow. Static script parsing passed; live browser interaction checks were not performed in this iteration.

- Normal arrival has no slogan or large welcome text. Voice mode centers a prominent Commander blob; text mode opens chat. First-use introduction is optional and separate.
- Compact icon tray: Conversations, Work, Artifacts & Sources, Inbox, Browser, Settings, and collapse. Conversation title sits above it. One dropdown opens at a time; search lives inside dropdowns.
- Left rail represents only previously opened panels in the current conversation that are tucked away or outside the current view. Right rail represents Needs you, Ready, and Coming up. Inbox and attention share state.
- Side items show small content previews on hover or keyboard focus, with a short hover delay. Clicking opens the corresponding work. Tray icons retain simple labels.
- Universe settings independently control Open-panel previews and Attention previews: Auto, Always show, Hidden. Hidden presentation does not remove work or pending requests; tray access remains available.
- Incoming questions use a compact bottom-right surface. Routine results update attention indicators. Incoming events never automatically replace the central workspace.
- Panel-local actions belong inside each panel header as small accessible icons: fit, arrange, pin/unpin, tuck away. Labels remain available through tooltips and accessible names.
- Work panels are movable and resizable, with usable minimum dimensions. Commander respects pins and user arrangements. Production persistence, undo, and independent panel state remain implementation requirements.
- The dark cinematic mock is one theme preset. Theme support remains in scope.

Latest review mock: `universe-evening-review.html` in the task's September 9 visualization directory. This iteration adds internal toolbar icons, content thumbnails, rail preferences, and bottom-right questions. The inherited mock still represents an active work composition rather than the full production multi-panel state model. Its preferences last for the current mock session; production settings require persistence.

Validation: static markup and JavaScript syntax checks only for this iteration. No production runtime code changed; repository typecheck, test suite, and build were not run for this documentation/mock update. Visual interaction review remains with the user.
