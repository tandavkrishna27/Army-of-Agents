import { z } from "zod";
import {
  NOTIFICATION_DIGEST_CADENCES,
  NOTIFICATION_PREFERENCES,
  type NotificationDigestCadence,
  type NotificationPreference,
} from "./constants.js";
import { HUB_SEMANTIC_TYPES, type HubSemanticType } from "./hub.js";

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const timezoneSchema = z.string().min(1).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid IANA timezone" },
);

export interface NotificationPreferenceRule {
  semanticType: HubSemanticType;
  deliveryMode: NotificationPreference;
  toastEnabled: boolean;
}

export interface NotificationPreferences {
  rules: NotificationPreferenceRule[];
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  digest: { enabled: boolean; cadence: NotificationDigestCadence };
  updatedAt: string | null;
}

export const notificationPreferenceRuleSchema = z
  .object({
    semanticType: z.enum(HUB_SEMANTIC_TYPES),
    deliveryMode: z.enum(NOTIFICATION_PREFERENCES),
    toastEnabled: z.boolean(),
  })
  .strict();

function rejectDuplicateRules(
  rules: NotificationPreferenceRule[],
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.semanticType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate rule for ${rule.semanticType}`,
      });
    }
    seen.add(rule.semanticType);
  }
}

export const notificationPreferencesSchema = z
  .object({
    rules: z.array(notificationPreferenceRuleSchema).superRefine(rejectDuplicateRules),
    quietHours: z
      .object({
        enabled: z.boolean(),
        start: clockSchema,
        end: clockSchema,
        timezone: timezoneSchema,
      })
      .strict(),
    digest: z
      .object({
        enabled: z.boolean(),
        cadence: z.enum(NOTIFICATION_DIGEST_CADENCES),
      })
      .strict(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const updateNotificationPreferencesSchema = notificationPreferencesSchema
  .omit({ updatedAt: true })
  .partial()
  .strict();

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
    semanticType,
    deliveryMode: "realtime",
    toastEnabled: true,
  })),
  quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
  digest: { enabled: true, cadence: "daily" },
  updatedAt: null,
};
