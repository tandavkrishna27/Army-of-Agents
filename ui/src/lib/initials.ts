/**
 * Derive 1–2 character initials from a display name.
 *
 * - Two or more words → first letter of first word + first letter of last word
 * - Single word with ≥2 chars → first two letters
 * - Single character → that character
 * - Empty or whitespace-only → empty string
 *
 * Always uppercases the result.
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}
