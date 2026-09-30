import { z } from "zod";
import { AGENT_ADAPTER_TYPES, AGENT_ICON_NAMES } from "./constants.js";

export type TeamRole = "lead" | "member";
export type TeamStatus = "active" | "archived";
export type TeamCoordinationStatus = "draft" | "published" | "archived";

export const TeamRoleSchema = z.enum(["lead", "member"]);
export const TeamStatusSchema = z.enum(["active", "archived"]);

export interface FileInventoryEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface TeamManifestRoutingRule {
  match: string;     // regex pattern
  mention: string;   // "@alice"
}

export interface TeamManifestRouting {
  defaultLead?: string;
  rules: TeamManifestRoutingRule[];
}

export interface TeamManifestAgentInline {
  name: string;
  role: TeamRole;
  skillKeys: string[];
  instructionsTemplate?: string;
}

export interface TeamManifestAgentRef {
  $ref: string;          // "@aoa/agent-name@1.0.0"
  localName: string;
  role: TeamRole;
}

export type TeamManifestAgent = TeamManifestAgentInline | TeamManifestAgentRef;

export interface TeamManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  agents: TeamManifestAgent[];
  routing: TeamManifestRouting;
  skillDeps?: string[];
  pluginDeps?: string[];
  workflowTemplates?: Array<{ $ref: string }>;
  memoryItems?: Array<{ layer: string; title: string; body: string }>;
}

export const TeamManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(64),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver"),
    displayName: z.string().optional(),
    description: z.string().optional(),
    agents: z.array(z.union([
      z.object({
        name: z.string().min(1),
        role: TeamRoleSchema,
        skillKeys: z.array(z.string()),
        instructionsTemplate: z.string().optional(),
      }),
      z.object({
        $ref: z.string().regex(/^@[\w-]+\/[\w-]+@\d+\.\d+\.\d+$/),
        localName: z.string().min(1),
        role: TeamRoleSchema,
      }),
    ])),
    routing: z.object({
      defaultLead: z.string().optional(),
      rules: z.array(z.object({
        match: z.string(),
        mention: z.string(),
      })),
    }),
    skillDeps: z.array(z.string()).optional(),
    pluginDeps: z.array(z.string()).optional(),
    workflowTemplates: z.array(z.object({ $ref: z.string() })).optional(),
    memoryItems: z.array(z.object({
      layer: z.string(),
      title: z.string(),
      body: z.string(),
    })).optional(),
  })
  .superRefine((data, ctx) => {
    // Validate regex compilability for routing rules at the schema layer
    // (D2): both the route-level `validate(TeamManifestSchema)` middleware
    // and the service-level `validateManifest` now catch bad-regex rules
    // at the same point — single source of truth.
    //
    // P2-C: ReDoS hardening. `rule.match` is user-supplied and reaches a
    // `new RegExp(...)` call here. JS regex compilation is cheap, but the
    // rule's PURPOSE is to be evaluated against agent-mention strings — at
    // evaluation time, a pathological pattern like `(a+)+$` can backtrack
    // exponentially. Defensive validation here:
    //   1. Cap pattern length to 256 chars (oversize payloads).
    //   2. Reject the classic CWE-1333 nested-quantifier shape.
    //   3. Keep the existing compilability try/catch.
    // This is a coarse heuristic, not a complete ReDoS analyser. Known
    // bypasses are documented inline at the regex below; for
    // production-grade safety the right move is re2-wasm at evaluation
    // time. (Today rule.match is only embedded as text — see the
    // detailed I2 comment at the heuristic itself.)
    for (let i = 0; i < data.routing.rules.length; i++) {
      const rule = data.routing.rules[i];

      // Cap pattern length to prevent oversized payloads from growing the
      // regex compile cost or DoS via memory pressure.
      if (rule.match.length > 256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", "rules", i, "match"],
          message: `regex pattern exceeds 256 character limit (got ${rule.match.length})`,
        });
        continue;
      }

      // Reject the most common ReDoS shape: nested quantifier directly inside
      // a group whose contents are themselves quantified. Examples that ARE
      // caught:
      //   (a+)+   (a*)+   (a+)*   (a+)?   ([abc]+)+
      //
      // I2 (comprehensive-review fixup): this is a coarse heuristic. KNOWN
      // BYPASSES — the heuristic does NOT catch:
      //   (a+){10,}     — braced quantifier (curly-brace shapes)
      //   (a|aa)+       — alternation overlap
      //   ((a+))+       — double-wrapped group
      //   [a-z]+(?=…)   — lookahead with quantifier
      //
      // Today (this commit's HEAD), `rule.match` is only embedded as text
      // in scaffolder markdown — never compiled to a runtime evaluator —
      // so the bypasses are inert. THE FIRST FEATURE THAT WIRES rule.match
      // INTO A REAL EVALUATOR MUST replace this heuristic with re2-wasm or
      // a proper static-analysis pass; do not trust this check alone.
      if (/\([^)]*[+*][^)]*\)[+*?]/.test(rule.match)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", "rules", i, "match"],
          message: `regex pattern contains a nested quantifier (ReDoS-prone): ${rule.match}`,
        });
        continue;
      }

      // Compilability check (existing behaviour).
      try {
        new RegExp(rule.match);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", "rules", i, "match"],
          message: `invalid regex: ${(err as Error).message}`,
        });
      }
    }
  });

export interface CreateTeamInput {
  name: string;
  parentProjectId: string;
  description?: string;
  manifest?: Partial<TeamManifest>;
  members?: Array<{ agentId: string; role: TeamRole }>;
}

export interface UpdateTeamInput {
  name?: string;
  // P3-E: nullable so callers can clear an existing description. Matches
  // updateTeamSchema and upsertCoordinationSchema.
  description?: string | null;
  manifest?: TeamManifest;
  status?: TeamStatus;
}

export interface AddTeamMemberInput {
  agentId: string;
  role: TeamRole;
}

export interface CreateTeamCoordinationInput {
  teamId: string;
  name: string;
  markdown: string;
  // C4: nullable so the upsert path can clear an existing description.
  // Mirrors the upsertCoordinationSchema relaxation below.
  description?: string | null;
}

// HTTP route validation schemas. Names use the prefix `teamsMember*` (plural)
// to disambiguate from `addTeamMemberSchema` / `updateTeamMemberRoleSchema`
// which already exist in packages/shared/src/validators/team.ts for the
// user/board permissions domain. Slice 1 / Task 1.10.
export const createTeamSchema = z.object({
  name: z.string().min(1).max(128),
  parentProjectId: z.string().uuid(),
  description: z.string().optional(),
  // P1: optional inline members for atomic create. The server validates
  // dept-membership + lead-uniqueness pre-transaction so partial failures
  // produce clean error messages instead of rollback artifacts.
  members: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        role: TeamRoleSchema,
      }),
    )
    .optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  // P3-E: accept null so the UI can clear an existing description. The DB
  // column is nullable; mirrors `upsertCoordinationSchema.description` shape.
  description: z.string().nullable().optional(),
  status: TeamStatusSchema.optional(),
});

export const addTeamsMemberSchema = z.object({
  agentId: z.string().uuid(),
  role: TeamRoleSchema,
});

export const updateTeamsMemberRoleSchema = z.object({
  role: TeamRoleSchema,
});

export const upsertCoordinationSchema = z.object({
  name: z.string().min(1).max(256),
  markdown: z.string(),
  // C4: accept null so founders can clear an existing description. The DB
  // column is `text` nullable, and `team-coordination.upsert` passes
  // `description` straight through to `set` / `values` — null persists as
  // NULL. Without `.nullable()`, `description: null` 400s at the route
  // validator before the handler runs.
  description: z.string().nullable().optional(),
});
