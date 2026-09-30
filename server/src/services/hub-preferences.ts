import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { hubPreferences } from "@armyofagents/db";
import {
  HUB_DENSITIES,
  HUB_GROUP_MODES,
  HUB_LANDING_TARGETS,
  HUB_LANES,
  type HubDensity,
  type HubGroupMode,
  type HubLandingTarget,
  type HubLane,
  type HubPreferences,
  type UpdateHubPreferencesInput,
} from "@armyofagents/shared";

export const DEFAULT_HUB_PREFERENCES: HubPreferences = {
  defaultLanding: "home",
  visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
  groupMode: "auto",
  density: "comfortable",
  showAutopilotEntry: true,
  updatedAt: null,
};

type HubPreferenceRow = {
  defaultLanding: string;
  visibleLanes: unknown;
  groupMode: string;
  density: string;
  showAutopilotEntry: boolean;
  updatedAt: Date | string | null;
};

function isHubLane(value: unknown): value is HubLane {
  return typeof value === "string" && (HUB_LANES as readonly string[]).includes(value);
}

function normalizeVisibleLanes(value: unknown): HubLane[] {
  if (!Array.isArray(value)) return [...DEFAULT_HUB_PREFERENCES.visibleLanes];
  const out: HubLane[] = [];
  const seen = new Set<HubLane>();
  for (const item of value) {
    if (!isHubLane(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : [...DEFAULT_HUB_PREFERENCES.visibleLanes];
}

function normalizeLanding(value: unknown, visibleLanes: HubLane[]): HubLandingTarget {
  if (value === "home") return "home";
  if (typeof value === "string" && (HUB_LANDING_TARGETS as readonly string[]).includes(value)) {
    return visibleLanes.includes(value as HubLane) ? (value as HubLandingTarget) : "home";
  }
  return "home";
}

function normalizeGroupMode(value: unknown): HubGroupMode {
  return typeof value === "string" && (HUB_GROUP_MODES as readonly string[]).includes(value)
    ? (value as HubGroupMode)
    : DEFAULT_HUB_PREFERENCES.groupMode;
}

function normalizeDensity(value: unknown): HubDensity {
  return typeof value === "string" && (HUB_DENSITIES as readonly string[]).includes(value)
    ? (value as HubDensity)
    : DEFAULT_HUB_PREFERENCES.density;
}

function serializeUpdatedAt(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toPreferences(row: HubPreferenceRow | null): HubPreferences {
  if (!row) return { ...DEFAULT_HUB_PREFERENCES, visibleLanes: [...DEFAULT_HUB_PREFERENCES.visibleLanes] };
  const visibleLanes = normalizeVisibleLanes(row.visibleLanes);
  return {
    defaultLanding: normalizeLanding(row.defaultLanding, visibleLanes),
    visibleLanes,
    groupMode: normalizeGroupMode(row.groupMode),
    density: normalizeDensity(row.density),
    showAutopilotEntry: row.showAutopilotEntry,
    updatedAt: serializeUpdatedAt(row.updatedAt),
  };
}

export function hubPreferencesService(db: Db) {
  async function readRow(userId: string, companyId: string): Promise<HubPreferenceRow | null> {
    const rows = await db
      .select({
        defaultLanding: hubPreferences.defaultLanding,
        visibleLanes: hubPreferences.visibleLanes,
        groupMode: hubPreferences.groupMode,
        density: hubPreferences.density,
        showAutopilotEntry: hubPreferences.showAutopilotEntry,
        updatedAt: hubPreferences.updatedAt,
      })
      .from(hubPreferences)
      .where(
        and(
          eq(hubPreferences.userId, userId),
          eq(hubPreferences.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  async function writeRow(
    userId: string,
    companyId: string,
    preferences: Omit<HubPreferences, "updatedAt">,
  ): Promise<HubPreferences> {
    const now = new Date();
    const [row] = await db
      .insert(hubPreferences)
      .values({
        userId,
        companyId,
        defaultLanding: preferences.defaultLanding,
        visibleLanes: preferences.visibleLanes,
        groupMode: preferences.groupMode,
        density: preferences.density,
        showAutopilotEntry: preferences.showAutopilotEntry,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [hubPreferences.userId, hubPreferences.companyId],
        set: {
          defaultLanding: preferences.defaultLanding,
          visibleLanes: preferences.visibleLanes,
          groupMode: preferences.groupMode,
          density: preferences.density,
          showAutopilotEntry: preferences.showAutopilotEntry,
          updatedAt: now,
        },
      })
      .returning({
        defaultLanding: hubPreferences.defaultLanding,
        visibleLanes: hubPreferences.visibleLanes,
        groupMode: hubPreferences.groupMode,
        density: hubPreferences.density,
        showAutopilotEntry: hubPreferences.showAutopilotEntry,
        updatedAt: hubPreferences.updatedAt,
      });
    return toPreferences(row ?? null);
  }

  return {
    async get(userId: string, companyId: string): Promise<HubPreferences> {
      return toPreferences(await readRow(userId, companyId));
    },

    async upsert(
      userId: string,
      companyId: string,
      patch: UpdateHubPreferencesInput,
    ): Promise<HubPreferences> {
      const existing = toPreferences(await readRow(userId, companyId));
      const visibleLanes = patch.visibleLanes ?? existing.visibleLanes;
      const defaultLanding = normalizeLanding(
        patch.defaultLanding ?? existing.defaultLanding,
        visibleLanes,
      );

      return writeRow(userId, companyId, {
        defaultLanding,
        visibleLanes,
        groupMode: patch.groupMode ?? existing.groupMode,
        density: patch.density ?? existing.density,
        showAutopilotEntry: patch.showAutopilotEntry ?? existing.showAutopilotEntry,
      });
    },

    async reset(userId: string, companyId: string): Promise<HubPreferences> {
      return writeRow(userId, companyId, {
        defaultLanding: DEFAULT_HUB_PREFERENCES.defaultLanding,
        visibleLanes: [...DEFAULT_HUB_PREFERENCES.visibleLanes],
        groupMode: DEFAULT_HUB_PREFERENCES.groupMode,
        density: DEFAULT_HUB_PREFERENCES.density,
        showAutopilotEntry: DEFAULT_HUB_PREFERENCES.showAutopilotEntry,
      });
    },
  };
}
