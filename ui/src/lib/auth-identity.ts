import type { CurrentUserProfile } from "@armyofagents/shared";

export const LOCAL_BOARD_USER_ID = "local-board";

export function isLocalTrustedProfile(profile: Pick<CurrentUserProfile, "id"> | null | undefined): boolean {
  return profile?.id === LOCAL_BOARD_USER_ID;
}

export function profileDisplayName(profile: Pick<CurrentUserProfile, "id" | "displayName" | "email"> | null | undefined): string {
  if (isLocalTrustedProfile(profile)) return "Local development";
  return profile?.displayName?.trim() || profile?.email?.trim() || "Account";
}

export function profileFirstName(profile: Pick<CurrentUserProfile, "id" | "displayName" | "email"> | null | undefined): string {
  if (isLocalTrustedProfile(profile)) return "Local development";
  return profileDisplayName(profile).split(/\s+/)[0] || "there";
}
