export interface AdapterModelProfile {
  id: string;
  label: string;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsImages?: boolean;
  supportsTools?: boolean;
  notes?: string | null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function normalizeAdapterModelProfiles(input: AdapterModelProfile[]): AdapterModelProfile[] {
  const seen = new Set<string>();
  const normalized: AdapterModelProfile[] = [];

  for (const profile of input) {
    const id = profile.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = profile.label.trim() || id;
    normalized.push({
      id,
      label,
      ...(normalizePositiveInteger(profile.contextWindowTokens) !== undefined
        ? { contextWindowTokens: normalizePositiveInteger(profile.contextWindowTokens) }
        : {}),
      ...(normalizePositiveInteger(profile.maxOutputTokens) !== undefined
        ? { maxOutputTokens: normalizePositiveInteger(profile.maxOutputTokens) }
        : {}),
      ...(profile.supportsImages !== undefined ? { supportsImages: Boolean(profile.supportsImages) } : {}),
      ...(profile.supportsTools !== undefined ? { supportsTools: Boolean(profile.supportsTools) } : {}),
      ...(profile.notes === null || typeof profile.notes === "string" ? { notes: profile.notes } : {}),
    });
  }

  return normalized;
}

export function findAdapterModelProfile(
  input: AdapterModelProfile[],
  id: string | null | undefined,
): AdapterModelProfile | null {
  if (!id) return null;
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  return input.find((profile) => profile.id === normalizedId) ?? null;
}
