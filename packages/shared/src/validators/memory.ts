import { z } from "zod";
import {
  MEMORY_ITEM_CATEGORIES,
  MEMORY_ITEM_SOURCES,
  MEMORY_ITEM_STATUSES,
  MEMORY_ITEM_LAYERS,
  MEMORY_ITEM_VISIBILITY,
  MEMORY_RELATION_KINDS,
  MEMORY_RECALL_BUDGETS,
  MEMORY_SCOPE_FILTERS,
  MEMORY_WRITE_SCOPES,
  MEMORY_RETRIEVAL_TRIGGERS,
  MEMORY_EXTRACTION_INPUT_TYPES,
  MEMORY_EXTRACTION_STATUSES,
  MEMORY_EXTRACTION_BATCH_STATUSES,
} from "../constants.js";

export const createMemoryItemSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  category: z.enum(MEMORY_ITEM_CATEGORIES),
  source: z.enum(MEMORY_ITEM_SOURCES),
  status: z.enum(MEMORY_ITEM_STATUSES).optional(),
  tags: z.array(z.string()).optional().default([]),
  departmentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  createdBy: z.string().min(1).optional(),
  // Extended memory fields.
  layer: z.enum(MEMORY_ITEM_LAYERS).optional().nullable(),
  priority: z.number().int().optional().default(0),
  visibility: z.enum(MEMORY_ITEM_VISIBILITY).optional().default("scoped"),
  expiresAt: z.string().datetime().optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  taskId: z.string().uuid().optional().nullable(),
  sourceArtifactId: z.string().uuid().optional().nullable(),
  sourceContext: z.string().optional().nullable(),
});

export type CreateMemoryItem = z.infer<typeof createMemoryItemSchema>;

export const updateMemoryItemSchema = createMemoryItemSchema
  .omit({ createdBy: true, source: true })
  .partial();

export type UpdateMemoryItem = z.infer<typeof updateMemoryItemSchema>;

export const suggestMemoryUpdateSchema = z.object({
  content: z.string().min(1),
  sourceContext: z.string().min(1),
  agentId: z.string().min(1),
});

export type SuggestMemoryUpdate = z.infer<typeof suggestMemoryUpdateSchema>;

export const suggestMemoryArchiveSchema = z.object({
  sourceContext: z.string().min(1),
  agentId: z.string().min(1),
});

export type SuggestMemoryArchive = z.infer<typeof suggestMemoryArchiveSchema>;

// ── Per-agent memory profile (lives in agent.runtimeConfig.memoryProfile) ──

/**
 * Future-reserved per-agent write capabilities. Default-safe (only personal scope).
 * Resolution logic + UI deferred — see docs Section 13. Schema in place so we don't
 * need a migration when the resolution logic ships.
 */
export const memoryWriteCapabilitiesSchema = z.object({
  canCreateInPersonalScope: z.boolean().default(true),
  canCreateInScopes: z.array(z.enum(MEMORY_WRITE_SCOPES)).default([]),
  canCreateLayers: z.array(z.enum(MEMORY_ITEM_LAYERS)).default([]),
  autoApproveOwnSuggestions: z.boolean().default(false),
  trustThreshold: z.number().min(0).max(100).nullable().default(null),
  dailyQuota: z.number().int().positive().default(10),
});

export type MemoryWriteCapabilities = z.infer<typeof memoryWriteCapabilitiesSchema>;

/**
 * Per-agent memory configuration. Stored under agent.runtimeConfig.memoryProfile.
 * Drives:
 *   - scope filter at retrieval time (search/get see only what profile allows)
 *   - which categories rank higher in auto-injection
 *   - recall budget (how many items pre-fetched per run)
 *   - whether MCP search tool is exposed to the agent
 *   - which pinned items get materialized into the agent's company-knowledge skill
 *
 * pinnedSkillItems resolution at sync time:
 *   if inheritFromDepartment: baseline = department's pinnedToSkill items
 *   else: baseline = []
 *   final = (baseline + additions) - removals
 */
export const memoryProfileSchema = z.object({
  scopeFilter: z.enum(MEMORY_SCOPE_FILTERS).default("department"),
  crossDepartmentScopes: z.array(z.string().uuid()).default([]),
  preferredCategories: z.array(z.enum(MEMORY_ITEM_CATEGORIES)).default([]),
  recallBudget: z.enum(MEMORY_RECALL_BUDGETS).default("mid"),
  exposeSearchTool: z.boolean().default(true),
  pinnedSkillItems: z.object({
    inheritFromDepartment: z.boolean().default(true),
    additions: z.array(z.string().uuid()).default([]),
    removals: z.array(z.string().uuid()).default([]),
  }).default({
    inheritFromDepartment: true,
    additions: [],
    removals: [],
  }),
  // Future-reserved (Phase 0 ships shape, behavior built later in writeCapabilities work)
  writeCapabilities: memoryWriteCapabilitiesSchema.default({
    canCreateInPersonalScope: true,
    canCreateInScopes: [],
    canCreateLayers: [],
    autoApproveOwnSuggestions: false,
    trustThreshold: null,
    dailyQuota: 10,
  }),
});

export type MemoryProfile = z.infer<typeof memoryProfileSchema>;

// ── memory_relations CRUD ──

export const createMemoryRelationSchema = z.object({
  fromItemId: z.string().uuid(),
  toItemId: z.string().uuid(),
  kind: z.enum(MEMORY_RELATION_KINDS),
});

export type CreateMemoryRelation = z.infer<typeof createMemoryRelationSchema>;

// ── memory_retrievals (server-side write only; no client create endpoint) ──

export const memoryRetrievalRowSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  triggeredBy: z.enum(MEMORY_RETRIEVAL_TRIGGERS),
  query: z.string().nullable(),
  itemId: z.string().uuid().nullable(),
  similarityScore: z.number().min(0).max(1).nullable(),
  rank: z.number().int().nullable(),
  shownToAgent: z.boolean(),
  createdAt: z.string().datetime(),
});

export type MemoryRetrievalRow = z.infer<typeof memoryRetrievalRowSchema>;

// ── memory_extractions / memory_extraction_batches ──

export const memoryExtractionProgressSchema = z.object({
  stage: z.string().optional(),
  stagePercent: z.number().min(0).max(100).optional(),
  stagesCompleted: z.array(z.string()).optional(),
  stagesRemaining: z.array(z.string()).optional(),
  estimatedSecondsRemaining: z.number().int().nonnegative().optional(),
});

export type MemoryExtractionProgress = z.infer<typeof memoryExtractionProgressSchema>;

export const createMemoryExtractionSchema = z.object({
  batchId: z.string().uuid().optional().nullable(),
  inputType: z.enum(MEMORY_EXTRACTION_INPUT_TYPES),
  inputAssetId: z.string().uuid().optional().nullable(),
  inputUrl: z.string().url().optional().nullable(),
  extractor: z.string().optional().nullable(),
});

export type CreateMemoryExtraction = z.infer<typeof createMemoryExtractionSchema>;

export const createMemoryExtractionBatchSchema = z.object({
  totalFiles: z.number().int().positive(),
});

export type CreateMemoryExtractionBatch = z.infer<typeof createMemoryExtractionBatchSchema>;
