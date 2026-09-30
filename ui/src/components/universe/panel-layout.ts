import {
  panelKey,
  positiveInteger,
  sameScope,
  validRect,
  validRef,
  type Scope,
  type Ref,
  type Rect,
  type State,
  type Viewport,
} from "./panel-state";

export type AuthorizedLayoutSnapshot = {
  scope: Scope;
  schemaVersion: 1;
  revision: number;
  nextOpenedOrdinal: number;
  viewport: Viewport;
  panels: Array<{
    ref: Ref;
    title: string;
    rect: Rect;
    openedOrdinal: number;
    minimized: boolean;
    pinned: boolean;
  }>;
  order: string[];
  selected: string | null;
  maximized: string | null;
};
// Scope is required on both sides of the receipt journal identity boundary.
export type PendingOpen = {
  scope: Scope;
  operationId: string;
  operationIndex: number;
  key: string;
  generation: number;
};
export type OpeningAck = {
  scope: Scope;
  operationId: string;
  revision: number;
  nextOpenedOrdinal: number;
  opened: Array<{ operationIndex: number; key: string; openedOrdinal: number }>;
};
const revisionValid = (n: number) => Number.isSafeInteger(n) && n >= 0;
function keyInScope(key: string, scope: Scope): boolean {
  try {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 6) return false;
    const [companyId, userId, conversationId, kind, id, version] = parts;
    const ref = {
      companyId,
      kind,
      id,
      ...(version === null ? {} : { version }),
    };
    return (
      sameScope(scope, { companyId, userId, conversationId }) &&
      validRef(ref, scope) &&
      panelKey(scope, ref) === key
    );
  } catch {
    return false;
  }
}
const fail = (): never => {
  throw new RangeError("Invalid authorized layout snapshot");
};

export function viewportFromLayout(
  snapshot: AuthorizedLayoutSnapshot
): Viewport {
  const v = snapshot?.viewport;
  if (
    !v ||
    ![v.x, v.y, v.zoom].every(Number.isFinite) ||
    Math.abs(v.x) > 1e6 ||
    Math.abs(v.y) > 1e6 ||
    v.zoom < 0.25 ||
    v.zoom > 2
  )
    fail();
  return { ...v };
}

/** Caller must resolve pending edits before explicit replacement. Never use for dirty refresh. */
export function hydrateLayout(
  current: State,
  snapshot: AuthorizedLayoutSnapshot
): State {
  if (
    !snapshot ||
    !sameScope(current.scope, snapshot.scope) ||
    snapshot.schemaVersion !== 1 ||
    !revisionValid(snapshot.revision) ||
    snapshot.revision < (current.layoutRevision ?? 0) ||
    !positiveInteger(snapshot.nextOpenedOrdinal) ||
    !Array.isArray(snapshot.panels) ||
    !Array.isArray(snapshot.order) ||
    !positiveInteger(current.nextGeneration) ||
    current.nextGeneration + snapshot.panels.length > Number.MAX_SAFE_INTEGER
  )
    fail();
  viewportFromLayout(snapshot);
  const panels: State["panels"] = Object.create(null);
  const ordinals = new Set<number>();
  let generation = current.nextGeneration;
  for (const p of snapshot.panels) {
    if (
      !p ||
      !validRef(p.ref, current.scope) ||
      typeof p.title !== "string" ||
      !validRect(p.rect) ||
      !positiveInteger(p.openedOrdinal) ||
      p.openedOrdinal >= snapshot.nextOpenedOrdinal ||
      ordinals.has(p.openedOrdinal) ||
      typeof p.minimized !== "boolean" ||
      typeof p.pinned !== "boolean"
    )
      fail();
    const key = panelKey(current.scope, p.ref);
    if (Object.hasOwn(panels, key)) fail();
    ordinals.add(p.openedOrdinal);
    panels[key] = {
      ...p,
      ref: { ...p.ref },
      rect: { ...p.rect },
      key,
      generation: generation++,
    };
  }
  if (
    snapshot.order.length !== snapshot.panels.length ||
    new Set(snapshot.order).size !== snapshot.order.length ||
    snapshot.order.some(
      (k) => typeof k !== "string" || !Object.hasOwn(panels, k)
    )
  )
    fail();
  const visible = (key: string | null) =>
    key === null ||
    (typeof key === "string" &&
      Object.hasOwn(panels, key) &&
      !panels[key].minimized);
  if (
    !visible(snapshot.selected) ||
    !visible(snapshot.maximized) ||
    (snapshot.maximized !== null &&
      (snapshot.maximized !== snapshot.selected ||
        snapshot.order.at(-1) !== snapshot.maximized))
  )
    fail();
  return {
    scope: { ...current.scope },
    panels,
    order: [...snapshot.order],
    selected: snapshot.selected,
    maximized: snapshot.maximized,
    nextGeneration: generation,
    nextOpenedOrdinal: Math.max(
      current.nextOpenedOrdinal,
      snapshot.nextOpenedOrdinal
    ),
    layoutRevision: snapshot.revision,
  };
}

/** Validated journals are caller-owned. Unknown/stale receipts require canonical reconciliation. */
export function reconcileOpeningAck(
  current: State,
  ack: OpeningAck,
  pending: readonly PendingOpen[]
): State {
  if (
    !ack ||
    !sameScope(current.scope, ack.scope) ||
    !revisionValid(ack.revision) ||
    ack.revision <= (current.layoutRevision ?? -1) ||
    !positiveInteger(ack.nextOpenedOrdinal) ||
    typeof ack.operationId !== "string" ||
    !ack.operationId.trim() ||
    !Array.isArray(ack.opened) ||
    !Array.isArray(pending)
  )
    return current;
  const journal = pending.filter((p) => p && p.operationId === ack.operationId);
  if (!journal.length || journal.length !== ack.opened.length) return current;
  const indexes = new Set<number>();
  for (const p of journal) {
    if (
      !sameScope(current.scope, p.scope) ||
      !revisionValid(p.operationIndex) ||
      !positiveInteger(p.generation) ||
      typeof p.key !== "string" ||
      !keyInScope(p.key, current.scope) ||
      indexes.has(p.operationIndex)
    )
      return current;
    indexes.add(p.operationIndex);
  }
  const sorted = [...journal].sort(
    (a, b) => a.operationIndex - b.operationIndex
  );
  const ordinalByIncarnation = new Map<string, number>();
  const incarnationByOrdinal = new Map<number, string>();
  for (let i = 0; i < ack.opened.length; i++) {
    const mapping = ack.opened[i];
    const p = sorted[i];
    if (
      !mapping ||
      mapping.operationIndex !== p.operationIndex ||
      mapping.key !== p.key ||
      !positiveInteger(mapping.openedOrdinal) ||
      mapping.openedOrdinal >= ack.nextOpenedOrdinal
    )
      return current;
    // Validate the entire journal, including instances no longer in the registry.
    const incarnation = JSON.stringify([p.key, p.generation]);
    const previousOrdinal = ordinalByIncarnation.get(incarnation);
    const previousIncarnation = incarnationByOrdinal.get(mapping.openedOrdinal);
    if (
      (previousOrdinal !== undefined &&
        previousOrdinal !== mapping.openedOrdinal) ||
      (previousIncarnation !== undefined && previousIncarnation !== incarnation)
    )
      return current;
    ordinalByIncarnation.set(incarnation, mapping.openedOrdinal);
    incarnationByOrdinal.set(mapping.openedOrdinal, incarnation);
  }
  const panels = { ...current.panels };
  for (let i = 0; i < ack.opened.length; i++) {
    const mapping = ack.opened[i];
    const p = sorted[i];
    const panel = Object.hasOwn(panels, p.key) ? panels[p.key] : undefined;
    if (panel && panel.generation === p.generation)
      panels[p.key] = { ...panel, openedOrdinal: mapping.openedOrdinal };
  }
  // Do not collide canonical allocations with still-optimistic ordinals; E1.2 must rebase them.
  const ordinals = Object.values(panels).map((p) => p.openedOrdinal);
  if (
    new Set(ordinals).size !== ordinals.length ||
    ordinals.some((n) => !positiveInteger(n) || n >= Number.MAX_SAFE_INTEGER)
  )
    return current;
  const nextOpenedOrdinal = Math.max(
    current.nextOpenedOrdinal,
    ack.nextOpenedOrdinal,
    ...ordinals.map((n) => n + 1)
  );
  return {
    ...current,
    panels,
    nextOpenedOrdinal,
    layoutRevision: ack.revision,
  };
}
