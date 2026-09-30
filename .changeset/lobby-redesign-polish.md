---
"@armyofagents/ui": patch
---

Lobby redesign — polish pass:
- Diagonal purple-wash gradient page background (`bg-[linear-gradient(135deg,hsl(260_40%_8%),hsl(240_25%_5%)_60%,hsl(220_30%_4%))]`) replaces the flat `bg-background` on the lobby root. Cards already use `bg-card/85` from the structural pass so the wash breathes through.
- Mount choreography via CSS keyframes (no new dependency — `framer-motion` isn't in the UI bundle, so this follows the existing `@keyframes dashboard-activity-enter` pattern): sidebar slides in from the left (200ms), heading fades+rises (200ms after a 200ms delay), cards stagger fade+rise 30ms apart starting at 250ms.
- Card hover scale `1.02` via Tailwind `hover:scale-[1.02]`, paired with `motion-reduce:hover:scale-100` so users with `prefers-reduced-motion` don't see the transform. All entry animations also respect `prefers-reduced-motion` via a single `@media` block in `index.css`.
