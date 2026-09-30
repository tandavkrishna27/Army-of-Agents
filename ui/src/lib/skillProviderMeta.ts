import type { MarketplaceProviderRef } from "@armyofagents/shared";

export function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function providerFromSkillMetadata(metadata: unknown): MarketplaceProviderRef | null {
  if (!metadata || typeof metadata !== "object") return null;
  const provider = (metadata as Record<string, unknown>).catalogProvider;
  if (!provider || typeof provider !== "object") return null;

  const record = provider as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const fallbackInitials = record.fallbackInitials;
  const logoUrl = record.logoUrl;
  const homepageUrl = record.homepageUrl;

  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (logoUrl !== undefined && typeof logoUrl !== "string") return null;
  if (homepageUrl !== undefined && typeof homepageUrl !== "string") return null;

  return {
    id,
    name,
    fallbackInitials:
      typeof fallbackInitials === "string" && fallbackInitials.length > 0
        ? fallbackInitials
        : name
            .split(/\s+/)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase(),
    ...(homepageUrl ? { homepageUrl } : {}),
    ...(logoUrl ? { logoUrl } : {}),
  };
}
