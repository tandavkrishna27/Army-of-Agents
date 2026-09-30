import { z } from "zod";
import { COCKPIT_SECTION_IDS, type CockpitSectionId } from "@armyofagents/shared";

export const COCKPIT_PREFS_VERSION = 3 as const;

const LEGACY_CARD_SECTION: Record<string, CockpitSectionId> = {
  myTasks: "my_work",
  review: "my_work",
  approvals: "my_work",
  inbox: "my_work",
  today: "my_work",
  discussions: "conversations",
  running: "company_overview",
  goalsAtRisk: "company_overview",
  budgetPulse: "company_overview",
  doneToday: "company_overview",
  proactiveFindings: "company_overview",
  teammatesActivity: "company_overview",
  stickyNotes: "context",
  pinned: "context",
  memory: "context",
};

export interface CockpitPrefsV3 {
  version: typeof COCKPIT_PREFS_VERSION;
  sourceVisibility: Record<string, boolean>;
  orderBySection: Partial<Record<CockpitSectionId, string[]>>;
}

const orderBySectionSchema = z.object({
  my_work: z.array(z.string()).optional(),
  conversations: z.array(z.string()).optional(),
  company_overview: z.array(z.string()).optional(),
  context: z.array(z.string()).optional(),
}).strict();

export const cockpitPrefsV3Schema = z.object({
  version: z.literal(COCKPIT_PREFS_VERSION),
  sourceVisibility: z.record(z.boolean()),
  orderBySection: orderBySectionSchema,
}).strict();

export const DEFAULT_COCKPIT_PREFS_V3: CockpitPrefsV3 = {
  version: COCKPIT_PREFS_VERSION,
  sourceVisibility: {},
  orderBySection: {},
};

interface LegacyCockpitPrefs {
  hidden?: unknown;
  order?: unknown;
  enabled?: unknown;
}

export interface ParsedCockpitPrefsV3 {
  prefs: CockpitPrefsV3;
  migrated: boolean;
  valid: boolean;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export function migrateLegacyCockpitPrefs(value: LegacyCockpitPrefs): CockpitPrefsV3 {
  const hidden = uniqueStrings(value.hidden);
  const enabled = uniqueStrings(value.enabled);
  const order = uniqueStrings(value.order);
  const sourceVisibility: Record<string, boolean> = {};

  for (const id of hidden) sourceVisibility[id] = false;
  for (const id of enabled) {
    if (!hidden.includes(id)) sourceVisibility[id] = true;
  }

  const orderBySection: Partial<Record<CockpitSectionId, string[]>> = {};
  for (const section of COCKPIT_SECTION_IDS) {
    const ids = order.filter((id) => LEGACY_CARD_SECTION[id] === section);
    if (ids.length > 0) orderBySection[section] = ids;
  }

  return { version: COCKPIT_PREFS_VERSION, sourceVisibility, orderBySection };
}

export function parseCockpitPrefsV3(value: unknown): ParsedCockpitPrefsV3 {
  const current = cockpitPrefsV3Schema.safeParse(value);
  if (current.success) return { prefs: current.data, migrated: false, valid: true };

  if (value && typeof value === "object" && !("version" in value)) {
    return {
      prefs: migrateLegacyCockpitPrefs(value as LegacyCockpitPrefs),
      migrated: true,
      valid: true,
    };
  }

  return { prefs: DEFAULT_COCKPIT_PREFS_V3, migrated: false, valid: false };
}

export function isCockpitSourceVisible(
  prefs: CockpitPrefsV3,
  sourceId: string,
  defaultVisible: boolean,
  hasRequiredAction: boolean,
): boolean {
  if (hasRequiredAction) return true;
  return prefs.sourceVisibility[sourceId] ?? defaultVisible;
}
