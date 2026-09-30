export type UserProfileSocialLink = { type: string; label: string | null; url: string };

export type UserProfile = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  title: string | null;
  bio: string | null;
  timezone: string | null;
  socialLinks: UserProfileSocialLink[];
};

export async function getUserProfile(): Promise<UserProfile | null> {
  const res = await fetch("/api/user-profile", { credentials: "include" });
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status}`);
  return ((await res.json()) as { profile?: UserProfile | null }).profile ?? null;
}

export async function saveUserProfile(input: Partial<UserProfile>): Promise<UserProfile> {
  const res = await fetch("/api/user-profile", {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`profile save failed: ${res.status}`);
  return ((await res.json()) as { profile: UserProfile }).profile;
}
