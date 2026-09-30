# Invited welcome terminal — company orientation (v1)

**Goal:** Replace the generic node-diagram (`MiniMap` / `MapDiagram`) on the
invited-teammate "admitted" terminal with a simple, **company-specific**
orientation — showing whatever real data the joined company has — rendered in
the new `JourneyCard` visual language.

**Status:** design approved (2026-07-22). Small, single-surface change.

---

## Context

`ui/src/onboarding/InvitedJoinTerminal.tsx` (`phase === "admitted"`, ~lines
371–391) renders:

```
<DarkShell>
  <StepHeading title="Welcome to {company}." subtitle="Here's how {company} already works — you'll plug right in." />
  <MiniMap className="w-full text-left" />          ← the old generic node diagram
  <Button onClick={finishEnter}>Enter {company}</Button>
</DarkShell>
```

The `MiniMap` shows a **generic** AoA node graph (Commander → Task → Agent/Human
→ Review, Memory) — not the company the teammate is actually joining. The
founder Map fork was rebuilt into big `JourneyCard`s (`ui/src/onboarding/Map.tsx`);
this screen is the last one still on the old diagram.

The founder's 3-card Map is a **fork** (pick a journey). An invited teammate
does not pick a journey — so this screen is NOT a fork. It is a read-only
"here's what you're plugging into" orientation.

## Design

**Keeps:** the dark shell, the `Welcome to {company}.` heading + current
subtitle, and the `Enter {company}` button (the e2e helper clicks it).

**Replaces `MiniMap`** with a new read-only component `CompanyOrientation`
(`ui/src/onboarding/CompanyOrientation.tsx`) — a row of **3 orientation cards**
in the `JourneyCard` visual language (rounded-2xl, top hairline, icon/emoji
tile, per-card accent hue, soft glow) but **static** (rendered as
`<article>`/`<div>`, never `<button>`, no `onPick`):

| Card | Accent | Content | Empty fallback |
|------|--------|---------|----------------|
| 🎯 **What we're building** | brand | `company.vision` \|\| `company.mission` | "Your team is shaping this as they go." |
| 🏢 **Departments** | teal | department names as chips (from `projects` where `type === "department"`) | "No departments yet." |
| 👥 **Who's here** | amber | `"{teammates} teammate(s) · {agents} agent(s) already working"` | "You're one of the first here." (0/0) |

"Show whatever data is available": each card degrades independently. If a fetch
fails, that card shows its fallback — the terminal never blocks and the Enter
button is always live.

### Data

On the `admitted` phase only, `CompanyOrientation` fetches (React Query,
company already a confirmed membership so authorized):

- `companiesApi.get(companyId)` → `vision` / `mission`
- `projectsApi.list(companyId)` → filter `type === "department"` → names
- `agentsApi.list(companyId)` → count
- `teamApi.get(companyId)` → member count

`enabled` only when `companyId` is present. While loading, cards render a low
static skeleton (three muted placeholder cards, same footprint) so the layout
doesn't jump; the heading + Enter button render immediately.

`InvitedJoinTerminal` already resolves the admitted company **name**; it does
NOT currently thread the company **id** into the admitted render. The id is
available as `anchoredTargetRef.current` — pass it (plus the name) into
`CompanyOrientation` as props. If the id is somehow null (deep-link race,
name-only backfill), `CompanyOrientation` renders all three fallbacks (no
fetch) — never an error.

### Component boundary

- `CompanyOrientation({ companyId, companyName })` — owns its own data fetching
  and fallbacks. Pure presentational below the fetch: an internal
  `OrientationCard` (static variant of `Map.tsx`'s `JourneyCard` — same chrome,
  no button/onClick/cta-arrow).
- `InvitedJoinTerminal` only swaps `<MiniMap/>` → `<CompanyOrientation companyId={…} companyName={…}/>`. No change to the polling/finalize state machine.
- `MiniMap.tsx` / `mapDiagram.tsx` stay in the repo (still imported by their own
  tests; unused by the invited terminal now) — no deletion, no collateral churn.

## Testing

- **Component test** `CompanyOrientation.test.tsx`: mock the four api clients;
  assert (a) populated cards from data (vision text, department chips, the
  "N teammates · M agents" line), (b) each fallback when its datum is
  empty/missing, (c) null `companyId` → all fallbacks, no fetch.
- **InvitedJoinTerminal.test.tsx**: the admitted phase renders
  `CompanyOrientation` (not `MiniMap`) and the `Enter {company}` button. Keep
  the existing admitted-phase assertions that still hold.
- **E2E**: `onboarding-invited.spec.ts` `expectInsideCompany` is unchanged — it
  already clicks `Enter {company}` then asserts the Lobby. Re-run locally
  (`AOA_E2E_FORCE_WINDOWS=1`) to confirm the redesigned terminal still gates on
  Enter.

## Out of scope (v1)

- No interactions on the cards (no drill-in, no links).
- No new server endpoints — reuse existing company/projects/agents/team reads.
- No redesign of the consent/pending/not-approved phases (only `admitted`).
- Company-specific styling from `brandColor` — deferred; v1 uses the fixed
  brand/teal/amber accents.
