import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { universePreferences } from "@armyofagents/db";
import {
  UNIVERSE_PREFERENCE_SECTIONS,
  resolveUniversePreferences,
  universePreferencePatchSchema,
  universePreferenceResetSchema,
  type UniversePreferenceOverrides,
  type UniversePreferencePatchInput,
  type UniversePreferenceResetInput,
  type UniversePreferencesSnapshot,
} from "@armyofagents/shared";
import { insertActivityLog, publishActivityLogged, type PersistedActivity } from "./activity-log.js";

export class UniversePreferencesConflictError extends Error {
  constructor(readonly latest: UniversePreferencesSnapshot) {
    super("Universe preferences changed in another session");
    this.name = "UniversePreferencesConflictError";
  }
}

type PreferenceRow = {
  id: string;
  schemaVersion: number;
  revision: number;
  overrides: UniversePreferenceOverrides;
};

const snapshot = (row?: PreferenceRow): UniversePreferencesSnapshot => {
  const overrides = row?.overrides ?? {};
  return {
    schemaVersion: 1,
    revision: row?.revision ?? 0,
    overrides,
    effective: resolveUniversePreferences(overrides),
    unavailableFields: {},
  };
};

export function universePreferencesService(db: Db) {
  const selectOwner = async (executor: Pick<Db, "select">, companyId: string, userId: string, lock = false) => {
    let query = executor.select({
      id: universePreferences.id,
      schemaVersion: universePreferences.schemaVersion,
      revision: universePreferences.revision,
      overrides: universePreferences.overrides,
    }).from(universePreferences).where(and(
      eq(universePreferences.companyId, companyId),
      eq(universePreferences.userId, userId),
    ));
    if (lock && "for" in query) query = query.for("update") as typeof query;
    const rows = await query;
    return rows[0] as PreferenceRow | undefined;
  };

  async function mutate(
    companyId: string,
    userId: string,
    baseRevision: number,
    update: (current: UniversePreferenceOverrides) => UniversePreferenceOverrides,
    changedKeys: readonly string[],
  ) {
    let activity: PersistedActivity | undefined;
    const result = await db.transaction(async tx => {
      await tx.insert(universePreferences).values({
        companyId,
        userId,
        schemaVersion: 1,
        revision: 0,
        overrides: {},
      }).onConflictDoNothing({ target: [universePreferences.companyId, universePreferences.userId] });
      const row = await selectOwner(tx as unknown as Db, companyId, userId, true);
      if (!row) throw new Error("Universe preference row was not created");
      if (row.schemaVersion !== 1) throw new Error("Universe preferences require a newer app");
      if (row.revision !== baseRevision) throw new UniversePreferencesConflictError(snapshot(row));
      const overrides = update(row.overrides);
      const [saved] = await tx.update(universePreferences).set({
        overrides,
        revision: row.revision + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(universePreferences.id, row.id),
        eq(universePreferences.companyId, companyId),
        eq(universePreferences.userId, userId),
        eq(universePreferences.revision, row.revision),
      )).returning({
        id: universePreferences.id,
        schemaVersion: universePreferences.schemaVersion,
        revision: universePreferences.revision,
        overrides: universePreferences.overrides,
      });
      if (!saved) throw new UniversePreferencesConflictError(snapshot(await selectOwner(tx as unknown as Db, companyId, userId, true)));
      activity = await insertActivityLog(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "universe.preferences.updated",
        entityType: "universe_preferences",
        entityId: row.id,
        details: { changedKeys: [...changedKeys] },
      });
      return snapshot(saved as PreferenceRow);
    });
    if (activity) publishActivityLogged(activity);
    return result;
  }

  return {
    async get(companyId: string, userId: string) {
      const row = await selectOwner(db, companyId, userId);
      if (row && row.schemaVersion !== 1) throw new Error("Universe preferences require a newer app");
      return snapshot(row);
    },
    async patch(companyId: string, userId: string, raw: UniversePreferencePatchInput) {
      const input = universePreferencePatchSchema.parse(raw);
      const patch = input.patch as UniversePreferenceOverrides;
      return mutate(companyId, userId, input.baseRevision, current => ({ ...current, ...patch }), Object.keys(patch));
    },
    async reset(companyId: string, userId: string, raw: UniversePreferenceResetInput) {
      const input = universePreferenceResetSchema.parse(raw);
      const keys = UNIVERSE_PREFERENCE_SECTIONS[input.section];
      return mutate(companyId, userId, input.baseRevision, current => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      }, keys);
    },
  };
}
