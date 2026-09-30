import { z } from "zod";
import {
  COMPANY_BRAIN_EDITABLE_EDGE_KINDS,
  COMPANY_BRAIN_EDGE_EDITABILITY,
  COMPANY_BRAIN_EDGE_KINDS,
  COMPANY_BRAIN_EDGE_SOURCE_CLASSES,
  COMPANY_BRAIN_NODE_TYPES,
} from "../constants.js";

const metadataSchema = z.record(z.string(), z.unknown());

export const companyBrainNodeRefSchema = z.object({
  type: z.enum(COMPANY_BRAIN_NODE_TYPES),
  id: z.string().trim().min(1),
});

export type CompanyBrainNodeRefInput = z.infer<typeof companyBrainNodeRefSchema>;

const companyBrainScopeSchema = z.object({
  departmentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  visibility: z.string().min(1).optional().nullable(),
  isCompanyWide: z.boolean().optional(),
}).strict();

export const companyBrainNodeSchema = companyBrainNodeRefSchema.extend({
  companyId: z.string().uuid(),
  label: z.string().min(1),
  subtitle: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  scope: companyBrainScopeSchema.optional(),
  href: z.string().optional().nullable(),
  metadata: metadataSchema.optional(),
});

export type CompanyBrainNodeInput = z.infer<typeof companyBrainNodeSchema>;

export const companyBrainEdgeSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().uuid(),
  from: companyBrainNodeRefSchema,
  to: companyBrainNodeRefSchema,
  kind: z.enum(COMPANY_BRAIN_EDGE_KINDS),
  sourceClass: z.enum(COMPANY_BRAIN_EDGE_SOURCE_CLASSES),
  editability: z.enum(COMPANY_BRAIN_EDGE_EDITABILITY),
  confidence: z.number().min(0).max(1).optional().nullable(),
  evidence: z.string().max(4000).optional().nullable(),
  createdBy: z.string().min(1).optional().nullable(),
  createdAt: z.string().datetime().optional().nullable(),
  metadata: metadataSchema.optional(),
});

export type CompanyBrainEdgeInput = z.infer<typeof companyBrainEdgeSchema>;

export const companyBrainNeighborsResponseSchema = z.object({
  center: companyBrainNodeSchema,
  nodes: z.array(companyBrainNodeSchema),
  edges: z.array(companyBrainEdgeSchema),
});

export type CompanyBrainNeighborsResponseInput =
  z.infer<typeof companyBrainNeighborsResponseSchema>;

export const companyBrainOverviewResponseSchema = z.object({
  nodes: z.array(companyBrainNodeSchema),
  edges: z.array(companyBrainEdgeSchema),
  limit: z.number().int().min(1).max(250),
  truncated: z.boolean(),
});

export type CompanyBrainOverviewResponseInput =
  z.infer<typeof companyBrainOverviewResponseSchema>;

const edgeKindListSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value.split(",").map((kind) => kind.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.enum(COMPANY_BRAIN_EDGE_KINDS)).optional());

const booleanQueryParamSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((value) => {
    if (value === undefined) return true;
    if (typeof value === "boolean") return value;
    return value === "true";
  });

export const companyBrainNeighborQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(1).default(1),
  kinds: edgeKindListSchema,
});

export type CompanyBrainNeighborQuery = z.infer<typeof companyBrainNeighborQuerySchema>;

export const companyBrainOverviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  includeStructural: booleanQueryParamSchema,
  kinds: edgeKindListSchema,
});

export type CompanyBrainOverviewQuery = z.infer<typeof companyBrainOverviewQuerySchema>;

export const createCompanyBrainSemanticEdgeSchema = z.object({
  from: companyBrainNodeRefSchema,
  to: companyBrainNodeRefSchema,
  kind: z.enum(COMPANY_BRAIN_EDITABLE_EDGE_KINDS),
  confidence: z.number().min(0).max(1).optional().nullable(),
  evidence: z.string().max(4000).optional().nullable(),
  metadata: metadataSchema.optional(),
}).strict();

export type CreateCompanyBrainSemanticEdge =
  z.infer<typeof createCompanyBrainSemanticEdgeSchema>;

export const updateCompanyBrainSemanticEdgeSchema = z.object({
  kind: z.enum(COMPANY_BRAIN_EDITABLE_EDGE_KINDS).optional(),
  confidence: z.number().min(0).max(1).optional().nullable(),
  evidence: z.string().max(4000).optional().nullable(),
  metadata: metadataSchema.optional(),
}).strict();

export type UpdateCompanyBrainSemanticEdge =
  z.infer<typeof updateCompanyBrainSemanticEdgeSchema>;
