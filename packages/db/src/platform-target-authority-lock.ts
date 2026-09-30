import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

const PLATFORM_TARGET_AUTHORITY_NAMESPACE = 1095713075; // 0x414f4133 (AOA3)
const DEFAULT_LOCK_TIMEOUT_MS = 750;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertCanonicalTargetId(targetId: string): void {
  if (!CANONICAL_UUID.test(targetId)) {
    throw new Error("Platform target authority requires a canonical UUID");
  }
}

export async function configurePlatformTargetAuthorityLockTimeout(
  tx: Db,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<void> {
  const bounded = Math.max(1, Math.min(30_000, Math.floor(timeoutMs)));
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${bounded}ms`}, true)`);
}

export async function acquirePlatformTargetAuthorityShared(
  tx: Db,
  targetId: string,
): Promise<void> {
  assertCanonicalTargetId(targetId);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock_shared(
      ${PLATFORM_TARGET_AUTHORITY_NAMESPACE},
      hashtext(${targetId})
    )
  `);
}

export async function acquirePlatformTargetAuthorityExclusive(
  tx: Db,
  targetId: string,
): Promise<void> {
  assertCanonicalTargetId(targetId);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${PLATFORM_TARGET_AUTHORITY_NAMESPACE},
      hashtext(${targetId})
    )
  `);
}
