import {layoutPatchSchema, type LayoutOp, type LayoutPatch} from "@armyofagents/shared";

import type {LayoutEditContext} from "./layout-adapter";
import type {RebaseWitnesses} from "./layout-rebase";

export type LayoutJournal = {
  pending: {operations: LayoutOp[]; baseRevision: number; witnesses?: RebaseWitnesses; context?: LayoutEditContext}[];
  uncertain: LayoutPatch | null;
  uncertainWitnesses?: RebaseWitnesses;
  uncertainContext?: LayoutEditContext;
  conflict: LayoutPatch | null;
  revisionFloor: number;
  resolvedRemoteBase: number;
};
const PREFIX = "aoa:universe:layout:v1:";
const MAX_BYTES = 1024 * 1024;
const MAX_GROUPS = 100;
const MAX_AGE = 24 * 60 * 60 * 1000;
export const journalKey = (scope: string) => PREFIX + scope;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const cloneContext = (c: LayoutEditContext): LayoutEditContext => ({epoch: c.epoch, openings: c.openings.map(o => ({operationIndex: o.operationIndex, key: o.key, generation: o.generation}))});
function validate(value: unknown): LayoutJournal {
  const v = value as LayoutJournal;
  if (!v || !Array.isArray(v.pending) || !Number.isSafeInteger(v.revisionFloor) || v.revisionFloor < 0 ||
      !Number.isSafeInteger(v.resolvedRemoteBase) || v.resolvedRemoteBase < 0 ||
      v.pending.length + Number(!!v.uncertain) + Number(!!v.conflict) > MAX_GROUPS) throw new Error("Invalid or full layout recovery journal");
  const validateWitnesses = (w: RebaseWitnesses | undefined, count: number) => {
    if (w !== undefined && (!Array.isArray(w) || w.length !== count ||
      w.some(value => value !== null && (typeof value !== "string" || bytes(value) > 16384)))) throw new Error("Invalid layout rebase witnesses");
  };
  const validateContext = (context: LayoutEditContext | undefined, ops: LayoutOp[]) => {
    if (context === undefined) return;
    if (!context || typeof context.epoch !== "string" || !context.epoch.length || context.epoch.length > 128 || !Array.isArray(context.openings) || context.openings.length > ops.length) throw new Error("Invalid layout edit context");
    const seen = new Set<number>();
    for (const opening of context.openings) {
      const op = ops[opening.operationIndex];
      if (!Number.isSafeInteger(opening.operationIndex) || seen.has(opening.operationIndex) || op?.type !== "open" || op.key !== opening.key || !Number.isSafeInteger(opening.generation) || opening.generation < 1) throw new Error("Invalid layout opening context");
      seen.add(opening.operationIndex);
    }
  };
  for (const p of v.pending) {
    layoutPatchSchema.parse({schemaVersion: 1, operationId: "x".repeat(256), expectedRevision: p.baseRevision, operations: p.operations});
    validateWitnesses(p.witnesses, p.operations.length);
    validateContext(p.context, p.operations);
  }
  if (v.uncertain !== null) layoutPatchSchema.parse(v.uncertain);
  validateWitnesses(v.uncertainWitnesses, v.uncertain?.operations.length ?? 0);
  validateContext(v.uncertainContext, v.uncertain?.operations ?? []);
  if (v.conflict !== null) layoutPatchSchema.parse(v.conflict);
  return {pending: v.pending.map(p => ({baseRevision: p.baseRevision, operations: structuredClone(p.operations), ...(p.witnesses ? {witnesses: [...p.witnesses]} : {}), ...(p.context ? {context: cloneContext(p.context)} : {})})),
    uncertain: v.uncertain, ...(v.uncertainWitnesses ? {uncertainWitnesses: [...v.uncertainWitnesses]} : {}), ...(v.uncertainContext ? {uncertainContext: cloneContext(v.uncertainContext)} : {}), conflict: v.conflict, revisionFloor: v.revisionFloor, resolvedRemoteBase: v.resolvedRemoteBase};
}
export function readLayoutJournal(storage: Storage, scope: string, now = Date.now()): LayoutJournal | null {
  const raw = storage.getItem(journalKey(scope));
  if (!raw) return null;
  if (bytes(raw) > MAX_BYTES) throw new Error("Layout recovery journal exceeds 1 MiB");
  const envelope = JSON.parse(raw);
  if (envelope.version !== 1 || envelope.scope !== scope || !Number.isFinite(envelope.expiresAt)) throw new Error("Invalid layout recovery journal");
  if (envelope.expiresAt <= now) {storage.removeItem(journalKey(scope)); return null;}
  return validate(envelope.data);
}
export function writeLayoutJournal(storage: Storage, scope: string, value: LayoutJournal, now = Date.now()) {
  const data = validate(value);
  const key = journalKey(scope);
  if (!data.pending.length && !data.uncertain && !data.conflict) {storage.removeItem(key); return;}
  const raw = JSON.stringify({version: 1, scope, expiresAt: now + MAX_AGE, data});
  let total = bytes(raw);
  // A tab-wide byte cap prevents switching conversations from growing storage without bound.
  for (let i = 0; i < storage.length; i++) {
    const other = storage.key(i)!;
    if (other.startsWith(PREFIX) && other !== key) total += bytes(storage.getItem(other) ?? "");
  }
  if (total > MAX_BYTES) throw new Error("Layout recovery journal exceeds 1 MiB");
  storage.setItem(key, raw);
}
export function clearForeignLayoutJournals(storage: Storage, owner: string | null) {
  const remove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (!key.startsWith(PREFIX)) continue;
    try {if (!owner || JSON.parse(key.slice(PREFIX.length))[0] !== owner) remove.push(key);}
    catch {remove.push(key);}
  }
  for (const key of remove) storage.removeItem(key);
}
