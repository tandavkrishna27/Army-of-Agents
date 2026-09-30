import {
  authUsers,
  createDb,
  notificationDigestItems,
} from "../../../packages/db/src/index";
import type { HubSemanticType } from "../../../packages/shared/src/hub";

function e2eDatabaseUrl() {
  const explicit =
    process.env.AOA_E2E_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.AOA_E2E_DB_PORT?.trim() || "54329";
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

export async function ensureLocalBoardUser() {
  const db = createDb(e2eDatabaseUrl());
  try {
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id: "local-board",
        email: "local-board@aoa.local",
        name: "Local Board",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}

export async function seedNotificationDigestItem(input: {
  companyId: string;
  userId?: string;
  hubItemId: string;
  semanticType: HubSemanticType;
}) {
  const db = createDb(e2eDatabaseUrl());
  try {
    await ensureLocalBoardUser();
    await db
      .insert(notificationDigestItems)
      .values({
        companyId: input.companyId,
        userId: input.userId ?? "local-board",
        hubItemId: input.hubItemId,
        semanticType: input.semanticType,
      })
      .onConflictDoNothing();
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}
