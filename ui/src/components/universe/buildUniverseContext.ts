import {
  universeContextSchema,
  type UniverseContext,
  type UniverseReference,
} from "@armyofagents/shared";

function cloneReference(reference: UniverseReference): UniverseReference {
  return reference.kind === "artifact"
    ? { kind: reference.kind, id: reference.id, ...(reference.versionId ? { versionId: reference.versionId } : {}) }
    : { kind: reference.kind, id: reference.id };
}

function keyOf(reference: UniverseReference): string {
  return `${reference.kind}:${reference.id}:${reference.kind === "artifact" ? reference.versionId ?? "" : ""}`;
}

export function buildUniverseContext(
  input: Omit<UniverseContext, "schemaVersion">,
): UniverseContext {
  const seen = new Set<string>();
  const visible = input.visible.flatMap((reference) => {
    const cloned = cloneReference(reference);
    const key = keyOf(cloned);
    if (seen.has(key)) return [];
    seen.add(key);
    return [cloned];
  });
  return universeContextSchema.parse({
    schemaVersion: 1,
    conversationId: input.conversationId,
    selected: input.selected ? cloneReference(input.selected) : null,
    visible,
    viewport: { ...input.viewport },
  });
}
