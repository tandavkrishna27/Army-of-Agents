import type {LayoutOp, UniverseLayoutDocument} from "@armyofagents/shared";

export type RebaseWitnesses = (string | null)[];
const identity = (p: UniverseLayoutDocument["panels"][number]) =>
  [p.key, p.ref.companyId, p.ref.kind, p.ref.id, p.ref.version ?? null, p.openedOrdinal];

/** Capture only properties an operation reads or overwrites. Lifecycle operations
 * remain explicit conflicts: replaying them can change foreground and allocation. */
export function captureWitnesses(doc: UniverseLayoutDocument, operations: LayoutOp[]): RebaseWitnesses {
  const identities = () => doc.panels.map(p => [identity(p), p.minimized]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return operations.map(op => {
    let value: unknown;
    if (op.type === "open" || op.type === "close") return null;
    if (op.type === "viewport") value = [doc.viewport.x, doc.viewport.y, doc.viewport.zoom, doc.maximized, doc.maximized ? identities() : null];
    else if (op.type === "order" || op.type === "presentation")
      value = [doc.order, doc.selected, doc.maximized, identities(), op.type === "presentation" ? [doc.viewport.x, doc.viewport.y, doc.viewport.zoom] : null];
    else {
      const panel = doc.panels.find(p => p.key === op.key);
      if (!panel) return null;
      const id = identity(panel);
      if (op.type === "geometry") {
        if (panel.minimized || doc.maximized === panel.key) return null;
        value = [id, panel.rect.x, panel.rect.y, panel.rect.width, panel.rect.height, ...(op.placement ? [panel.placement ?? "auto"] : []), panel.minimized, doc.maximized === panel.key];
      } else if (op.type === "pin") value = [id, panel.pinned];
      else value = [id, panel.minimized, doc.selected, doc.maximized, doc.order];
    }
    const encoded = JSON.stringify(value);
    return new TextEncoder().encode(encoded).length <= 16384 ? encoded : null;
  });
}

export function canRebaseLayout(operations: LayoutOp[], witnesses: RebaseWitnesses | undefined, remote: UniverseLayoutDocument): boolean {
  if (!witnesses || !operations.length || witnesses.length !== operations.length) return false;
  const current = captureWitnesses(remote, operations);
  return witnesses.every((value, index) => value !== null && value === current[index]);
}
