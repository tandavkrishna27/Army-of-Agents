import type { Db } from "@armyofagents/db";
import { authUsers, userProfiles, type UserProfileSocialLink } from "@armyofagents/db";
import { eq } from "drizzle-orm";

export type UserProfileInput = {
  displayName?: string | null;
  avatarUrl?: string | null;
  title?: string | null;
  bio?: string | null;
  timezone?: string | null;
  socialLinks?: UserProfileSocialLink[];
};

export type UserProfile = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  title: string | null;
  bio: string | null;
  timezone: string | null;
  socialLinks: UserProfileSocialLink[];
};

function mapRow(row: any): UserProfile {
  return {
    userId: row.userId,
    displayName: row.displayName ?? null,
    avatarUrl: row.avatarUrl ?? null,
    title: row.title ?? null,
    bio: row.bio ?? null,
    timezone: row.timezone ?? null,
    socialLinks: Array.isArray(row.socialLinks) ? row.socialLinks : [],
  };
}

export async function getUserProfile(
  db: Pick<Db, "select">,
  userId: string,
): Promise<UserProfile | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Idempotent upsert of the global per-user profile (Stage C / C1-C3). */
export async function upsertUserProfile(
  db: Db,
  userId: string,
  input: UserProfileInput,
): Promise<UserProfile> {
  return await db.transaction(async (tx) => {
    const values = {
      userId,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      title: input.title ?? null,
      bio: input.bio ?? null,
      timezone: input.timezone ?? null,
      socialLinks: input.socialLinks ?? [],
      updatedAt: new Date(),
    };
    const updates: Partial<typeof userProfiles.$inferInsert> = { updatedAt: values.updatedAt };
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl;
    if (input.title !== undefined) updates.title = input.title;
    if (input.bio !== undefined) updates.bio = input.bio;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.socialLinks !== undefined) updates.socialLinks = input.socialLinks;

    await tx
      .insert(userProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: updates,
      });

    // The richer `user_profiles` row is the onboarding source of truth, while
    // existing app surfaces still read identity fields from Better Auth's user
    // row. Keep the overlapping compatibility fields synchronized until those
    // readers are migrated to the richer profile.
    const authUpdates: Partial<typeof authUsers.$inferInsert> = { updatedAt: values.updatedAt };
    if (input.displayName !== undefined) authUpdates.displayName = input.displayName;
    if (input.avatarUrl !== undefined) authUpdates.avatarUrl = input.avatarUrl;
    if (input.displayName !== undefined || input.avatarUrl !== undefined) {
      await tx.update(authUsers).set(authUpdates).where(eq(authUsers.id, userId));
    }

    const saved = await getUserProfile(tx, userId);
    if (!saved) throw new Error("failed to upsert user profile");
    return saved;
  });
}
