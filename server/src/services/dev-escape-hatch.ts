import type { Db } from "@armyofagents/db";
import { authUsers } from "@armyofagents/db";
import { ne } from "drizzle-orm";

// The synthetic loopback principal created by the dev escape hatch.
const LOCAL_BOARD_USER_ID = "local-board";

/**
 * A "real user" is any auth user other than the synthetic `local-board`
 * principal. Used to decide whether enabling the dev escape hatch would grant
 * unauthenticated admin access to an instance that already has real accounts.
 */
export async function realUserExists(db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(ne(authUsers.id, LOCAL_BOARD_USER_ID))
    .limit(1);
  return rows.length > 0;
}

export function isEscapeHatchForced(): boolean {
  return /^(1|true|yes)$/i.test(process.env.AOA_DEV_LOCAL_IDENTITY_FORCE?.trim() ?? "");
}

/**
 * RB4/R5 — refuse to activate the dev escape hatch on a populated instance.
 *
 * The hatch (`AOA_DEV_LOCAL_IDENTITY`) grants unauthenticated loopback admin
 * access, so it must never be silently enabled once real Google users exist.
 * `AOA_DEV_LOCAL_IDENTITY_FORCE=1` overrides for development/recovery.
 */
export async function assertEscapeHatchAllowed(db: Db): Promise<void> {
  if (isEscapeHatchForced()) return;
  if (await realUserExists(db)) {
    throw new Error(
      "AOA_DEV_LOCAL_IDENTITY refused: this instance already has real users. " +
        "The escape hatch would grant unauthenticated loopback admin access. " +
        "Set AOA_DEV_LOCAL_IDENTITY_FORCE=1 to override (development/recovery only).",
    );
  }
}
