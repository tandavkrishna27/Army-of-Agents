# Routines Page Redesign — Design Spec

## Problem

The Routines list page uses a plain HTML table and the detail page has a flat layout with no visual structure. Compared to the Agents page (card grid, status dots, hover actions) and other polished pages in AoA, Routines feels like a different app. Specific UX issues:

- **List page**: No cards, no icons, no visual hierarchy — just a spreadsheet-style table
- **Detail page**: Save button always visible (even when nothing changed), Add trigger form always expanded (takes half the page), action buttons scattered across different spots, delivery settings in a random collapsible, no visual sections

## Solution

Redesign both pages to match the AoA design system patterns established by the Agents page, Home page, and Skills page.

---

## List Page (`ui/src/pages/Routines.tsx`)

### Header

- Title: "Routines" with subtitle showing count ("3 routines")
- Filter tabs: `All | Active | Paused | Archived` — same pattern as Agents page
- View toggle: Grid (default) / List icons — same toggle component as Agents page
- `[+ Create routine]` button right-aligned

### Card Grid View (default)

Layout: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`

Each routine card follows the AgentCard pattern:

```
Container: border border-border bg-card rounded-lg p-4 cursor-pointer
           hover:border-border/80 transition-all
           Live run state (when routine has a run with status "received" or "issue_created" with a non-terminal linked issue):
             border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.06)]

Structure:
┌──────────────────────────────────────────┐
│  [Repeat icon]  Title           [Toggle] │  ← Header row
│  ● Project · ◇ Agent                    │  ← Metadata line
│                                          │
│  🕐 Every day at 10:00 AM               │  ← Schedule (from describeSchedule)
│  Last: 8m ago · issue created            │  ← Last run status
│                                          │
│  ── border-t border-border/50 ────────── │  ← Divider (on hover)
│  [▶ Run now]                      [···]  │  ← Footer actions (on hover)
└──────────────────────────────────────────┘
```

Card contents:
- **Icon**: Repeat icon (lucide `Repeat`) in a `h-10 w-10 rounded-lg bg-accent` container
- **Title**: bold, `truncate` class for overflow
- **Toggle**: enabled/paused switch, top-right corner
- **Metadata**: project name with color dot + agent name with agent icon, `·` separated, `text-sm text-muted-foreground`
- **Schedule**: clock icon + `describeSchedule(cronExpression)` output. If no schedule triggers, show "No schedule" in muted text. If multiple triggers, show count "2 triggers"
- **Last run**: relative time + status badge. Color-coded: green for completed/issue_created, red for failed, gray for skipped/coalesced, muted for "Never"
- **Footer** (hover-only via `opacity-0 group-hover:opacity-100`): "Run now" ghost button, three-dot dropdown menu (Edit, Pause/Resume, Archive)
- **Click** card body: navigate to `/routines/:id`

### List View (toggle)

Keep the current table structure but polish:
- Project column: add color dot before name
- Agent column: add agent icon before name
- Last run column: color-coded status badge
- Enabled column: styled toggle (already done)
- Row hover: `hover:bg-accent/50`

### Empty State

Use the `EmptyState` component:
- Icon: `Repeat`
- Message: "No routines yet"
- Description: "Create your first routine to automate recurring work."
- Action: [+ Create routine] button

### Create Dialog

No changes — current dialog works well.

---

## Detail Page (`ui/src/pages/RoutineDetail.tsx`)

### Above Tabs — Routine Definition Card

Everything above the tabs is wrapped in a single bordered card: `border border-border rounded-lg bg-card p-5 space-y-4`

```
┌───────────────────────────────────────────────────────────────┐
│  Title (editable textarea)            [▶ Run now] [●━━ On]   │
│  ● Project · ◇ Agent · ⬡ Priority                            │
│                                                               │
│  ┌─ Instructions ──────────────────────────────────────────┐  │
│  │  Markdown editor (min-height: 80px)                     │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Concurrency: Coalesce if active ▾   Catch-up: Skip missed ▾ │
└───────────────────────────────────────────────────────────────┘
```

**Title row** (`flex items-start justify-between`):
- Left: editable `<textarea>` for title, `text-xl font-semibold`, auto-resize
- Right: flex row with "Run now" button (outline, small) + active/paused toggle switch

**Metadata row** (`flex items-center gap-2 text-sm text-muted-foreground`):
- Project: color dot + name, clickable via InlineEntitySelector
- Agent: agent icon + name, clickable via InlineEntitySelector
- Priority: priority icon + label, clickable via dropdown
- Separated by `·`

**Instructions section**:
- Label "Instructions" in `text-xs font-medium text-muted-foreground uppercase tracking-wide`
- Markdown editor in a subtle bordered container (`border border-border/50 rounded-md`)
- Min height 80px, placeholder "Add instructions..."

**Delivery settings row** (`flex items-center gap-6 text-sm`):
- "Concurrency: [dropdown]" and "Catch-up: [dropdown]"
- Each is a label + inline Select component
- Compact, always visible (not collapsible)

### Sticky Save Bar

Only renders when `isDirty` is true:

```css
sticky bottom-0 z-10 border-t border-amber-500/30 bg-amber-950/50
backdrop-blur-sm px-5 py-3 flex items-center justify-between
```

Content:
- Left: "⚠ Unsaved changes" in `text-sm text-amber-200`
- Right: [Discard] ghost button + [Save] primary button

When not dirty: nothing renders. No "Save routine" button visible at all.

### Tabs

Tab bar with count badges: `Triggers (1)`, `Runs (6)`, `Activity (12)`
- Badge: `text-xs bg-muted text-muted-foreground rounded-full px-1.5` after tab label
- Icons on tabs: Clock for Triggers, Play for Runs, Activity for Activity

---

### Triggers Tab

**Existing trigger cards** — each trigger is a bordered card:

```
Container: border border-l-4 rounded-lg p-4
           border-l color: blue-500 for schedule, purple-500 for webhook, gray-500 for api

┌─ 🕐 schedule ─────────────────────────────────────────────┐
│  Every day at 10:00 AM UTC                                 │
│  Label: "Morning check"                                    │
│                                                            │
│  Next run     Apr 1, 10:00 AM                              │
│  Last fired   Mar 31, 10:00 AM                             │
│  Last result  ● success                                    │
│                                          [✎ Edit] [🗑]     │
└────────────────────────────────────────────────────────────┘
```

- Kind badge in header (schedule/webhook/api)
- Human-readable schedule from `describeSchedule()`
- Optional label in `text-sm text-muted-foreground`
- Metadata: next run, last fired, last result as a key-value grid
- Edit button: expands inline form within the card (schedule editor, label field, save/cancel)
- Delete button: icon-only with confirmation

**"+ Add trigger" button**:
- Outline button below the trigger list: `[+ Add trigger]`
- NOT an always-open form
- Click → expands inline form: kind selector → schedule editor or webhook fields → [Add] [Cancel]
- Collapses after adding or cancelling
- If no triggers exist, show as part of the empty state

**Empty state**: "No triggers configured. Add a schedule or webhook trigger to automate this routine." with [+ Add trigger] button.

---

### Runs Tab

Bordered list container: `border border-border rounded-lg divide-y divide-border`

Each run row:
```
┌────────────────────────────────────────────────────────────────┐
│ [source badge]  [status badge]  [issue link]  [timestamp →]   │
│ (optional: failure reason in text-xs text-muted-foreground)   │
└────────────────────────────────────────────────────────────────┘
```

- **Source badge**: `manual`, `schedule`, `webhook`, `api` in `Badge variant="secondary"`
- **Status badge**: color-coded — green (`issue_created`, `completed`), red (`failed`), gray (`skipped`, `coalesced`), blue (`received`)
- **Issue link**: `TES-15` as a clickable link to the issue (only if `linkedIssueId` exists)
- **Timestamp**: right-aligned, relative ("8 minutes ago")
- **Failure reason** (only for failed runs): second line in `text-xs text-muted-foreground pl-2`
- Row padding: `px-4 py-3`

**Empty state**: "No runs yet. Use Run now or add a trigger to start."

---

### Activity Tab

Same bordered list pattern as Runs:

```
┌────────────────────────────────────────────────────────────────┐
│  routine.run_triggered                          4 minutes ago  │
│  source: manual · status: issue_created                        │
│────────────────────────────────────────────────────────────────│
│  routine.updated                               10 minutes ago  │
│  title: Daily health check v2                                  │
│────────────────────────────────────────────────────────────────│
│  routine.created                               36 minutes ago  │
│  title: Daily health check                                     │
└────────────────────────────────────────────────────────────────┘
```

- Action name: `text-sm font-medium`, formatted (e.g., "routine.run_triggered" → "Run triggered", "routine.created" → "Created")
- Details: key-value pairs in `text-xs text-muted-foreground`, `·` separated
- Timestamp: right-aligned
- Row padding: `px-4 py-3`

**Empty state**: "No activity yet."

---

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/Routines.tsx` | Card grid, filter tabs, view toggle, polished table, empty state |
| `ui/src/pages/RoutineDetail.tsx` | Definition card, sticky save bar, collapsed add-trigger, rich trigger cards, polished runs/activity |
| `ui/src/components/ScheduleEditor.tsx` | No changes (already works) |
| `ui/src/lib/routine-trigger-patch.ts` | No changes |

## New Components (optional, extract if large)

- `RoutineCard.tsx` — card for grid view (follows AgentCard pattern)
- Could stay inline in Routines.tsx if not too large

## Design Tokens Used

- Card: `border border-border bg-card rounded-lg`
- Hover: `hover:bg-accent/50`, `group-hover:opacity-100`
- Muted text: `text-muted-foreground`
- Badge: existing `Badge` component with `secondary`/`destructive`/`outline` variants
- Status colors: follow `status-colors.ts` patterns
- Grid: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`
- Sticky bar: `sticky bottom-0 z-10 backdrop-blur-sm`
- Trigger left border colors: `border-l-4 border-l-blue-500` (schedule), `border-l-purple-500` (webhook), `border-l-gray-500` (api)

## Verification

After implementation:
1. Navigate to `/routines` — verify card grid, filter tabs, view toggle
2. Create a new routine — verify dialog still works, navigation to detail
3. Detail page — verify definition card, metadata editing, instructions editor
4. Edit title — verify sticky save bar appears, save works, bar disappears
5. Add trigger — verify button expands form, form collapses after add, trigger card appears
6. Run now — verify runs appear in Runs tab with proper badges
7. Activity tab — verify filtered events only
8. Toggle active/paused — verify card and list reflect state
9. Responsive — check mobile layout stacks properly
