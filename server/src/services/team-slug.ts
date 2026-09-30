const MAX_SLUG_LENGTH = 64;

export function generateTeamSlug(name: string): string {
  if (!name || name.trim().length === 0) {
    throw new Error("name cannot be empty");
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  if (slug.length === 0) {
    throw new Error("name produces empty slug");
  }
  return slug;
}

export function ensureUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) {
    n++;
  }
  return `${base}-${n}`;
}
