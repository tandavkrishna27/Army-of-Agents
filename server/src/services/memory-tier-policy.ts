/**
 * Risk-tiered memory autonomy policy (enterprise memory model, P0).
 * Pure, dependency-free. Consumed by every write path in P5 and by the
 * Settings → Memory dials. See docs/aoa/plans/2026-07-30-memory-enterprise-overview.md.
 */
export type MemoryTier = "derived" | "ephemeral" | "consolidation" | "durable" | "protected";
export type AutonomyLevel = "manual" | "supervised" | "trusted" | "policy";
export type WriteDisposition = "auto" | "propose" | "human";

const VALID_TIERS: readonly string[] = ["derived", "ephemeral", "consolidation", "durable", "protected"];

/** Effective tier for an item: explicit `tier` override wins, else derived from `layer`. */
export function tierForItem(item: { layer: string | null; tier?: string | null }): MemoryTier {
  if (item.tier && VALID_TIERS.includes(item.tier)) return item.tier as MemoryTier;
  switch (item.layer) {
    case "identity":
      return "protected";
    case "working":
      return "ephemeral";
    case "domain":
    case "active_context":
      return "durable";
    default:
      return "durable"; // safe default: gate unknown layers like durable
  }
}

/** How a write of `tier` should be handled at company autonomy `level`. */
export function resolveWriteDisposition(
  tier: MemoryTier,
  level: AutonomyLevel,
  opts: { classPromoted?: boolean } = {},
): WriteDisposition {
  if (tier === "protected") return "human";
  if (tier === "derived" || tier === "ephemeral") return "auto";
  if (tier === "consolidation") {
    return level === "trusted" || level === "policy" ? "auto" : "propose";
  }
  // durable
  switch (level) {
    case "manual":
      return "human";
    case "supervised":
      return "propose";
    case "trusted":
      return opts.classPromoted ? "auto" : "propose";
    case "policy":
      return "auto";
  }
}
