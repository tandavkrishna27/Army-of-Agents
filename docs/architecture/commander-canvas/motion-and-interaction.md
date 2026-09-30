# Universe — motion and interaction acceptance

September 11, 2026. Companion to [UI decisions](ui-review-decisions.md). All behavior is planned. Durations are recommended starting values for review, not user-locked timing or measured performance promises.

| Trigger | Motion/completion | Reduced motion | Acceptance |
|---|---|---|---|
| Tray expand/collapse | Wings extend/retract around stationary logo, 180–240 ms | Immediate | Center/size unchanged; one menu; focus never stranded |
| Menu switch | Replace old menu, 120–180 ms reveal | Immediate | No stacked dropdowns; Escape/outside dismissal |
| Side preview | About 200 ms hover intent delay, continuous pointer corridor | Delay without travel | Keyboard/tap equivalent; no live control clones |
| Open panel | Bounded current-view placement, 160–220 ms settlement | Immediate | Existing panels preserved, task not oversized |
| Drag/resize | Direct pointer following, no easing lag | Same | All edges; inputs excluded; capture released on cancel |
| Select | Steady slight header tint/title brightness | Same | No border/glow, preserves text cursor |
| Minimize | Connection toward Open panels, 180–260 ms | Immediate hide/registry update | Actual visibility changes, not only an animation copy |
| Restore | Reverse connection and saved geometry | Immediate | Same live instance and draft, readable view |
| Maximize/restore | Geometry transition 200–280 ms | Immediate | Usable workspace filled, exact restore, controls reachable |
| Requested pan/zoom/fit | 220–350 ms anchored travel | Immediate target view | Manual manipulation wins, obsolete transitions cancelled |
| Commander highlight | Bring target into view, bloom once and fade over 2–2.5 s | Temporary static emphasis | No pin, cursor movement or completion claim |
| Background result | Quiet attention update | Same | No camera theft or flashing work |
| Question | Bottom-right 150–200 ms appearance | Immediate | Movable; resolution waits for acknowledged answer |
| Chat expand/compact | History grows above stable input, 180–240 ms | Immediate | Draft/cursor preserved; exit max geometry before compact |
| Chat tuck/restore | Connection to Commander icon, 180–240 ms | Immediate | Blob/captions/voice unaffected; recovery discoverable |
| Blob controls | Straight row fade 100–150 ms | Immediate | No rectangular blob hover; continuous clickable region |
| Idle/disconnected blob | Optional gentle breathing | Static | Does not imply listening; no fabricated waveform |
| Connecting/reconnecting | Restrained motion plus clear state | Static status | No listening before acknowledgement; end/cancel accessible |
| Listening | Subtle response to actual input | Static indicator | Muted state persistent; no simulated audio in production |
| Thinking | Restrained state transition | Static indicator | No invented progress or constant urgent pulsing |
| Speaking | Actual output envelope, settling after speech | Static speaking + captions | Interrupt/silence stops speaking motion promptly |
| End voice | Settle to disconnected, blob remains | Immediate | Connection ends; work/conversation retained |
| Theme/grid | Immediate or brief color interpolation | Immediate | No geometry reset, contrast loss or flash |
| Save/reconnect/error | Non-destructive clear status | Same | No success before acknowledgement or action replay |

## Shared rules

Use one motion token set and one panel state controller. Animation decorates a state transition; it cannot be the only mechanism changing visibility. Clean up cancelled animations/pointer capture on close, switch, unmount or lost focus. Rapid repeated actions converge to the last valid requested state without duplicate panels or orphaned overlays.

Never animate the user's cursor, hide focused controls or scale accessible hit targets into unusability. Caption selection and input focus survive updates. OS reduced motion remains respected even with app full motion selected. Information must not depend solely on color or motion.

## Connected acceptance checklist

- [ ] Same task from Work, Inbox, right attention, artifact source link and Open panels; repeat after close/minimize; one correct live view.
- [ ] Task/artwork/browser overlap, all resize edges and header drag at multiple zooms; content typing/selection/scroll unaffected.
- [ ] Pin → Commander arrange → human move → unpin → minimize/restore → maximize/restore → close/reopen; preserve geometry/draft/work.
- [ ] Rapid transitions and pointer release outside viewport; no stuck gesture, phantom panel or animation-only minimize.
- [ ] Highlight visible/off-screen/minimized targets and while typing; readable targeting with safe camera deferral.
- [ ] Compact/expanded/maximized/tucked chat, independent blob/captions, voice start/stop/mute/silence; no duplicate captions or lost restore.
- [ ] Tray collapse/auto-hide/menu switches, preview hover/focus/tap, overview paging and hidden rails; no inaccessible work.
- [ ] Narrow screen, text scaling, keyboard, touch, screen reader, reduced motion; usable controls and no horizontal overview strip.
- [ ] Reload/save failure/concurrent tab/company or conversation switch/provider or worker disconnect/revocation; recover without unauthorized replay.

These remain acceptance requirements for E1.0/E1.6 and consuming epics, not passed boxes. Record actual host, device, viewport, motion setting and entry route when verifying the intermittent defect.
