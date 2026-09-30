import { z } from "zod";

export const universePreferencesSchema = z
  .object({
    theme: z.enum(["inherit", "system", "light", "dark"]),
    density: z.enum(["comfortable", "compact"]),
    motion: z.enum(["subtle", "full", "reduced"]),
    dockPlacement: z.literal("top"),
    dockHiding: z.enum(["always", "auto_hide"]),
    commanderPlacement: z.enum(["automatic", "manual"]),
    conversationPresentation: z.enum(["compact", "expanded"]),
    blobVisibility: z.enum(["shown", "hidden"]),
    chatVisibility: z.enum(["shown", "tucked"]),
    captions: z.enum(["visible", "hidden"]),
    captionSize: z.enum(["standard", "large"]),
    captionPlacement: z.enum(["bottom_center", "below_blob"]),
    restoreWorkspace: z.enum(["previous", "overview"]),
    openPanelPreviews: z.enum(["auto", "always", "hidden"]),
    attentionPreviews: z.enum(["auto", "always", "hidden"]),
    accent: z.enum(["brand_red", "teal", "indigo", "amber"]),
    blobStyle: z.enum(["fluid", "orbital_rings", "minimal_glow"]),
    blobColor: z.enum(["match_accent", "brand_red", "teal", "indigo", "amber"]),
    grid: z.enum(["dots", "lines", "none"]),
    gridIntensity: z.number().finite().min(0).max(0.3),
    snapToGrid: z.boolean(),
    arrangement: z.enum(["assisted", "manual"]),
    voiceConnectionId: z.string().uuid().nullable(),
    voiceId: z.string().max(100).nullable(),
    language: z.string().max(100).nullable(),
    spokenLength: z.enum(["inherit", "brief", "balanced", "detailed"]),
    personalVoiceInstructions: z.string().max(2_000),
    soundEffects: z.boolean(),
    spokenAnnouncements: z.enum(["inherit", "quieter"]),
    browserViewQuality: z.enum(["auto", "reduced_bandwidth", "high"]),
  })
  .strict();

export interface UniversePreferences extends z.infer<typeof universePreferencesSchema> {}
export type UniversePreferenceOverrides = Partial<UniversePreferences>;
export type PreferenceSection = "appearance" | "workspace" | "voice" | "browser";

export interface UniversePreferencesSnapshot {
  schemaVersion: 1;
  revision: number;
  overrides: UniversePreferenceOverrides;
  effective: UniversePreferences;
  unavailableFields: Partial<Record<keyof UniversePreferences, string>>;
}

export const DEFAULT_UNIVERSE_PREFERENCES: UniversePreferences = Object.freeze({
  theme: "inherit",
  density: "comfortable",
  motion: "subtle",
  dockPlacement: "top",
  dockHiding: "always",
  commanderPlacement: "automatic",
  conversationPresentation: "compact",
  blobVisibility: "shown",
  chatVisibility: "shown",
  captions: "visible",
  captionSize: "standard",
  captionPlacement: "bottom_center",
  restoreWorkspace: "previous",
  openPanelPreviews: "auto",
  attentionPreviews: "auto",
  accent: "brand_red",
  blobStyle: "fluid",
  blobColor: "match_accent",
  grid: "dots",
  gridIntensity: 0.15,
  snapToGrid: false,
  arrangement: "assisted",
  voiceConnectionId: null,
  voiceId: null,
  language: null,
  spokenLength: "inherit",
  personalVoiceInstructions: "",
  soundEffects: false,
  spokenAnnouncements: "inherit",
  browserViewQuality: "auto",
});

const universePreferenceOverridesSchema = universePreferencesSchema
  .partial()
  .strict()
  .superRefine((overrides, ctx) => {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Preference override cannot be undefined",
        });
      }
    }
  });
const safeRevisionSchema = z.number().int().safe().nonnegative();

export const universePreferencePatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseRevision: safeRevisionSchema,
    patch: universePreferenceOverridesSchema.superRefine((patch, ctx) => {
      if (Object.keys(patch).length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Patch must contain at least one preference" });
      }
    }),
  })
  .strict();

export const universePreferenceResetSchema = z
  .object({
    baseRevision: safeRevisionSchema,
    section: z.enum(["appearance", "workspace", "voice", "browser"]),
  })
  .strict();

export type UniversePreferencePatchInput = z.infer<typeof universePreferencePatchSchema>;
export type UniversePreferenceResetInput = z.infer<typeof universePreferenceResetSchema>;

export const UNIVERSE_PREFERENCE_SECTIONS: Record<
  PreferenceSection,
  readonly (keyof UniversePreferences)[]
> = {
  appearance: [
    "theme", "density", "motion", "accent", "blobStyle", "blobColor", "grid", "gridIntensity",
  ],
  workspace: [
    "dockPlacement", "dockHiding", "commanderPlacement", "conversationPresentation",
    "blobVisibility", "chatVisibility", "captions", "captionSize", "captionPlacement",
    "restoreWorkspace", "openPanelPreviews", "attentionPreviews", "snapToGrid", "arrangement",
  ],
  voice: [
    "voiceConnectionId", "voiceId", "language", "spokenLength", "personalVoiceInstructions",
    "soundEffects", "spokenAnnouncements",
  ],
  browser: ["browserViewQuality"],
};

export function resolveUniversePreferences(
  overrides: UniversePreferenceOverrides,
): UniversePreferences {
  const validatedOverrides = universePreferenceOverridesSchema.parse(overrides);
  return { ...DEFAULT_UNIVERSE_PREFERENCES, ...validatedOverrides };
}
