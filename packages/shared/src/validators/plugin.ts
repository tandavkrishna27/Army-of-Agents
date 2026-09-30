import { z } from "zod";
import {
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_LAUNCHER_ACTIONS,
  PLUGIN_LAUNCHER_BOUNDS,
  PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const jsonSchemaSchema = z.record(z.unknown());

const pluginJobDeclarationSchema = z.object({
  jobKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  schedule: z.string().optional(),
});

const pluginWebhookDeclarationSchema = z.object({
  endpointKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
});

const pluginToolDeclarationSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  parametersSchema: jsonSchemaSchema,
});

const pluginUiSlotDeclarationSchema = z.object({
  type: z.enum(PLUGIN_UI_SLOT_TYPES),
  id: z.string().min(1),
  displayName: z.string().min(1),
  exportName: z.string().min(1),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  routePath: z.string().optional(),
  order: z.number().optional(),
});

const pluginLauncherActionDeclarationSchema = z.object({
  type: z.enum(PLUGIN_LAUNCHER_ACTIONS),
  target: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const pluginLauncherRenderDeclarationSchema = z.object({
  environment: z.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  bounds: z.enum(PLUGIN_LAUNCHER_BOUNDS).optional(),
});

const pluginLauncherDeclarationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  placementZone: z.enum(PLUGIN_LAUNCHER_PLACEMENT_ZONES),
  exportName: z.string().optional(),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  order: z.number().optional(),
  action: pluginLauncherActionDeclarationSchema,
  render: pluginLauncherRenderDeclarationSchema.optional(),
});

const pluginUiDeclarationSchema = z.object({
  slots: z.array(pluginUiSlotDeclarationSchema).optional(),
  launchers: z.array(pluginLauncherDeclarationSchema).optional(),
});

// ---------------------------------------------------------------------------
// Plugin Manifest V1 schema
// ---------------------------------------------------------------------------

export const pluginManifestV1Schema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9._-]+$/),
  apiVersion: z.literal(1),
  version: z.string().min(1),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).min(1),
  minimumHostVersion: z.string().optional(),
  minimumAoaVersion: z.string().optional(),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)),
  entrypoints: z.object({
    worker: z.string().min(1),
    ui: z.string().optional(),
  }),
  instanceConfigSchema: jsonSchemaSchema.optional(),
  jobs: z.array(pluginJobDeclarationSchema).optional(),
  webhooks: z.array(pluginWebhookDeclarationSchema).optional(),
  tools: z.array(pluginToolDeclarationSchema).optional(),
  launchers: z.array(pluginLauncherDeclarationSchema).optional(),
  ui: pluginUiDeclarationSchema.optional(),
});

export type PluginManifestV1Input = z.infer<typeof pluginManifestV1Schema>;
