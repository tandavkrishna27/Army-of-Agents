// ui/src/components/commander/cockpit/cockpitCardModel.ts
// Pure model — no React, no side effects, safe to unit-test in isolation.

export type CockpitSectionId =
  | "triage"
  | "my_work"
  | "conversations"
  | "watch"
  | "memory_context";

export interface CockpitSectionDef {
  id: CockpitSectionId;
  title: string;
}

export const COCKPIT_SECTIONS: CockpitSectionDef[] = [
  { id: "triage", title: "Triage" },
  { id: "my_work", title: "My Work" },
  { id: "conversations", title: "Conversations" },
  { id: "watch", title: "Watch" },
  { id: "memory_context", title: "Memory & Context" },
];

export interface CockpitCardDef {
  id: string;
  title: string;
  /** lucide icon name handled by the component; kept out of the pure model */
  defaultOn: boolean;
  sectionId: CockpitSectionId;
}

export interface CockpitVisibilityInput<T extends CockpitCardDef = CockpitCardDef> {
  registry: T[];
  hidden: string[];          // prefs.hidden
  order: string[];           // prefs.order
  active: Record<string, boolean>; // cardId -> has data
  enabled?: string[];        // prefs.enabled — opt-in card ids (defaultOn:false) the user turned on
}

/** Cards in render order: prefs.order first, then registry order for the rest.
 *  Generic so the registry's richer item type (with a `render` fn) is preserved. */
export function orderCards<T extends CockpitCardDef>(registry: T[], order: string[]): T[] {
  const byId = new Map(registry.map((c) => [c.id, c]));
  return [
    ...order.map((id) => byId.get(id)).filter((c): c is T => !!c),
    ...registry.filter((c) => !order.includes(c.id)),
  ];
}

/** Cards that should MOUNT (ordered, not hidden, defaultOn OR explicitly enabled).
 *  They self-report `active` and render null when empty.
 *  Order drives the DOM — single source of truth.
 *  `enabled` is optional (defaults to []) so existing call sites without it don't break. */
export function mountableCards<T extends CockpitCardDef>(
  registry: T[],
  hidden: string[],
  order: string[],
  enabled: string[] = [],
): T[] {
  return orderCards(registry, order).filter(
    (c) => !hidden.includes(c.id) && (c.defaultOn || enabled.includes(c.id)),
  );
}

/** Cards currently VISIBLE (mountable + has data) — drives the "All clear" decision.
 *  show-only-active: empty cards drop out (unless a future pin). */
export function selectVisibleCards<T extends CockpitCardDef>(input: CockpitVisibilityInput<T>): T[] {
  const { registry, hidden, order, active, enabled } = input;
  return mountableCards(registry, hidden, order, enabled ?? []).filter((c) => active[c.id] === true);
}

export function groupCardsBySection<T extends CockpitCardDef>(cards: T[]): Array<{
  section: CockpitSectionDef;
  cards: T[];
}> {
  return COCKPIT_SECTIONS
    .map((section) => ({
      section,
      cards: cards.filter((card) => card.sectionId === section.id),
    }))
    .filter((group) => group.cards.length > 0);
}

export function selectVisibleSectionGroups<T extends CockpitCardDef>(
  input: CockpitVisibilityInput<T>,
): Array<{ section: CockpitSectionDef; cards: T[] }> {
  return groupCardsBySection(selectVisibleCards(input));
}
