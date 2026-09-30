/**
 * Avatar color + initial helpers for the AoA design system §11 Avatars.
 *
 * `avatarColorFor(seed)` returns a stable CSS variable reference from the data
 * palette so the same seed always renders with the same color (e.g. agent slug,
 * department slug, user id). The mapping is a deterministic hash modulo the
 * palette length — order of palette entries here is part of the contract.
 *
 * `initialsFor(displayName)` derives up to two upper-case characters from a
 * human-friendly name per spec §11: "Research Lead" → "RL", "Commander" → "CO",
 * "Quality Assurance Runner" → "QR" (first + last word). Falls back to "?"
 * when given an empty or whitespace-only string.
 */

/**
 * Six-color data palette (matches `--data-*` CSS vars in `ui/src/index.css`).
 * Order is part of the contract — changing it will reshuffle existing avatars.
 */
const PALETTE = [
  "var(--data-teal)",
  "var(--data-indigo)",
  "var(--data-green)",
  "var(--data-amber)",
  "var(--data-magenta)",
  "var(--data-slate)",
] as const;

export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initialsFor(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
