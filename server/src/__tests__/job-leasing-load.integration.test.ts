import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { JobPlacementOwner } from "@armyofagents/shared";
import { runInTenant } from "../db/tenant-context.js";

export const E3_PERF_01_DATASET = Object.freeze({
  seed: 3003,
  candidateRows: 1_000_000,
  certificateRows: 1_000_000,
  warmups: 5,
  claimSamples: 30,
  mutationSamples: 20,
  batchSize: 256,
});

export const E3_PERF_01_INITIAL_THRESHOLDS = Object.freeze({
  shapesTwoThreeP95Ms: 250,
  shapesTwoThreeMaxMs: 1_500,
  saturatedP95Ms: 2_000,
  saturatedMaxMs: 5_000,
  bulkUpsertP95Ms: 500,
  cleanupP95Ms: 750,
  combinedTableIndexBytesMax: 2 * 1024 * 1024 * 1024,
});

export const E3_PERF_01_SHAPES = Object.freeze([
  "hot_worker_fully_certified_then_head_saturated",
  "ten_thousand_workers_by_one_hundred",
  "ninety_percent_stale_version_or_context",
  "cleanup_sparse_then_tail",
] as const);

export const E3_PERF_01_CLAIM_SCENARIOS = Object.freeze([
  "hot_worker_fully_certified_no_work",
  "hot_worker_head_saturated_999744_prefix",
  "ten_thousand_workers_by_one_hundred",
  "ninety_percent_stale_version_or_context",
] as const);

const E3_PERF_01_ORGANIZATION_ID = "e3000000-0000-4000-8000-000000000001";
const E3_PERF_01_COMPANY_ID = "e3010000-0000-4000-8000-000000000001";
const E3_PERF_01_HOT_TARGET_ID = "e3020000-0000-4000-8000-000000000000";
const E3_PERF_01_HOT_WORKER_ID = "e3030000-0000-4000-8000-000000000000";
const E3_PERF_01_TARGET_AUTHORITY_KEY = `organization:${E3_PERF_01_ORGANIZATION_ID}`;
const E3_PERF_01_PROFILE_HASH = "2".repeat(64);
const E3_PERF_01_PROVIDER_HASH = "3".repeat(64);
const E3_PERF_01_INPUT_DIGEST = "4".repeat(64);
const E3_PERF_01_POLICY_DIGEST = "5".repeat(64);
const E3_PERF_01_STATIC_CONTEXT_HASH = "6".repeat(64);
const E3_PERF_01_SEED_NAMESPACE = `e3-perf-01-${E3_PERF_01_DATASET.seed}`;
const E3_PERF_01_EXPECTED_CLAIM_ROWS = Object.freeze({
  hot_worker_fully_certified_no_work: 0,
  hot_worker_head_saturated_999744_prefix: 256,
  ten_thousand_workers_by_one_hundred: 0,
  ninety_percent_stale_version_or_context: 256,
} satisfies Record<(typeof E3_PERF_01_CLAIM_SCENARIOS)[number], number>);

const enabled = process.env.AOA_RUN_E3_PERF_01 === "1";
let db: Sql | null = null;
let seedSql: Sql | null = null;
let tenantSql: Sql | null = null;
let tenantDb: ReturnType<typeof drizzle> | null = null;
const capturedQueries: Array<{ sql: string; parameters: unknown[] }> = [];

type ClaimContext = {
  organizationId: string;
  workerId: string;
  targetId: string;
  targetAuthorityKey: string;
  placementOwner: Exclude<JobPlacementOwner, "legacy">;
  targetClass: string;
  targetScope: string;
  targetGeneration: number;
  targetProfileHash: string;
  targetProviderConstraintHash: string;
  admissibleWorkloadTypes: string[];
  eligibilityVersion: number;
  staticContextHash: string;
  limit: 256;
};

function database(): Sql {
  if (!db) throw new Error("E3-PERF-01 database was not initialized");
  return db;
}

function seedDatabase(): Sql {
  if (!seedSql) throw new Error("E3-PERF-01 seed database was not initialized");
  return seedSql;
}

function tenantDatabase(): ReturnType<typeof drizzle> {
  if (!tenantDb) throw new Error("E3-PERF-01 tenant database was not initialized");
  return tenantDb;
}

function percentile(samples: number[], fraction: number): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? Number.NaN;
}

function emitEvidence(value: Record<string, unknown>): void {
  // The dedicated runner consumes closed NDJSON. Never include connection,
  // environment, path, payload, proof, fence, or credential data here.
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function normalizedQuerySha256(statement: string): string {
  return createHash("sha256")
    .update(statement.replace(/\s+/g, " ").trim())
    .digest("hex");
}

const CERTIFICATE_COLUMN_EQUALITIES = Object.freeze([
  ["organization_id", "job_attempts.organization_id"],
  ["company_id", "job_attempts.company_id"],
  ["job_id", "job_attempts.job_id"],
  ["attempt_id", "job_attempts.id"],
  ["workload_type", "jobs.workload_type"],
  ["placement_owner", "job_attempts.placement_owner"],
  ["placement_target_class", "job_attempts.placement_target_class"],
  ["placement_target_scope", "job_attempts.placement_target_scope"],
  ["placement_target_generation", "job_attempts.placement_target_generation"],
  ["placement_profile_hash", "job_attempts.placement_profile_hash"],
  ["placement_provider_constraint_hash", "job_attempts.placement_provider_constraint_hash"],
  ["placement_input_digest", "job_attempts.placement_input_digest"],
  ["placement_policy_digest", "job_attempts.placement_policy_digest"],
] as const);

const CERTIFICATE_PARAMETER_EQUALITIES = Object.freeze([
  ["worker_id", "workerId"],
  ["target_id", "targetId"],
  ["target_authority_key", "targetAuthorityKey"],
  ["eligibility_version", "eligibilityVersion"],
  ["static_context_hash", "staticContextHash"],
] as const);

type ClaimSqlToken = {
  kind: "word" | "parameter" | "symbol" | "literal";
  value: string;
};

type ClaimPredicate =
  | { kind: "equality"; left: string; right: string }
  | { kind: "and" | "or"; children: ClaimPredicate[] };

const RELATION_ALIAS_BOUNDARIES = new Set([
  "where", "join", "inner", "left", "right", "full", "cross", "on", "using",
  "group", "order", "limit", "offset", "for", "union", "intersect", "except",
]);

const SUBQUERY_PREDICATE_BOUNDARIES = new Set([
  "group", "order", "limit", "offset", "for", "union", "intersect", "except", "returning",
]);

function tokenizeClaimSql(statement: string): ClaimSqlToken[] {
  const tokens: ClaimSqlToken[] = [];
  let index = 0;
  while (index < statement.length) {
    const character = statement[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (statement.startsWith("--", index)) {
      const newline = statement.indexOf("\n", index + 2);
      index = newline < 0 ? statement.length : newline + 1;
      continue;
    }
    if (statement.startsWith("/*", index)) {
      const close = statement.indexOf("*/", index + 2);
      if (close < 0) throw new Error("claim query contains an unterminated block comment");
      index = close + 2;
      continue;
    }
    if (character === '"') {
      let value = "";
      index += 1;
      let closed = false;
      while (index < statement.length) {
        if (statement[index] === '"') {
          if (statement[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        value += statement[index];
        index += 1;
      }
      if (!closed) throw new Error("claim query contains an unterminated quoted identifier");
      tokens.push({ kind: "word", value: value.toLowerCase() });
      continue;
    }
    if (character === "'") {
      let value = "'";
      index += 1;
      let closed = false;
      while (index < statement.length) {
        value += statement[index];
        if (statement[index] === "'") {
          if (statement[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("claim query contains an unterminated string literal");
      tokens.push({ kind: "literal", value });
      continue;
    }
    if (character === "$" && /\d/.test(statement[index + 1] ?? "")) {
      let end = index + 2;
      while (/\d/.test(statement[end] ?? "")) end += 1;
      tokens.push({ kind: "parameter", value: statement.slice(index, end) });
      index = end;
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      let end = index + 1;
      while (/[a-z0-9_$]/i.test(statement[end] ?? "")) end += 1;
      tokens.push({ kind: "word", value: statement.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }
    if (/\d/.test(character)) {
      let end = index + 1;
      while (/[\d.]/.test(statement[end] ?? "")) end += 1;
      tokens.push({ kind: "literal", value: statement.slice(index, end) });
      index = end;
      continue;
    }
    const doubleSymbol = statement.slice(index, index + 2);
    if (["::", "<=", ">=", "<>", "!=", "||"].includes(doubleSymbol)) {
      tokens.push({ kind: "symbol", value: doubleSymbol });
      index += 2;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function matchingCloseParen(tokens: ClaimSqlToken[], openIndex: number): number {
  if (tokens[openIndex]?.value !== "(") throw new Error("claim query parser expected an opening parenthesis");
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("claim query contains an unbalanced parenthesis");
}

function identifierPath(
  tokens: ClaimSqlToken[],
  start: number,
  end = tokens.length,
): { parts: string[]; next: number } | null {
  if (tokens[start]?.kind !== "word") return null;
  const parts = [tokens[start]!.value];
  let index = start + 1;
  while (index + 1 < end && tokens[index]?.value === "." && tokens[index + 1]?.kind === "word") {
    parts.push(tokens[index + 1]!.value);
    index += 2;
  }
  return { parts, next: index };
}

function collectRelationAliases(tokens: ClaimSqlToken[]): Map<string, string> {
  const aliases = new Map<string, string>();
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.value === "(") {
      depth += 1;
      continue;
    }
    if (token?.value === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || token?.kind !== "word" || (token.value !== "from" && token.value !== "join")) {
      continue;
    }
    const relationPath = identifierPath(tokens, index + 1);
    if (!relationPath) continue;
    const relation = relationPath.parts.at(-1)!;
    aliases.set(relation, relation);
    let next = relationPath.next;
    if (tokens[next]?.value === "as") next += 1;
    const alias = tokens[next];
    if (alias?.kind === "word" && !RELATION_ALIAS_BOUNDARIES.has(alias.value)) {
      const prior = aliases.get(alias.value);
      if (prior && prior !== relation) throw new Error("claim query reuses relation alias " + alias.value);
      aliases.set(alias.value, relation);
    }
  }
  return aliases;
}

function isWorkerLeaseRejectionSubquery(tokens: ClaimSqlToken[]): boolean {
  return [...collectRelationAliases(tokens).values()].includes("worker_lease_rejections");
}

function canonicalEquality(left: string, right: string): string {
  return [left, right].sort().join(" = ");
}

class ClaimPredicateParser {
  private position = 0;

  constructor(
    private readonly tokens: ClaimSqlToken[],
    private readonly aliases: Map<string, string>,
    private readonly parameters: unknown[],
    private readonly context: ClaimContext,
  ) {}

  parse(): ClaimPredicate {
    if (this.tokens.length === 0) throw new Error("claim certificate anti-join is missing its predicate");
    const predicate = this.parseOr();
    if (this.position !== this.tokens.length) {
      throw new Error(
        "claim certificate predicate has an unexpected token: " + this.tokens[this.position]?.value,
      );
    }
    return predicate;
  }

  private parseOr(): ClaimPredicate {
    const children = [this.parseAnd()];
    while (this.consume("or")) children.push(this.parseAnd());
    return children.length === 1 ? children[0]! : { kind: "or", children };
  }

  private parseAnd(): ClaimPredicate {
    const children = [this.parsePrimary()];
    while (this.consume("and")) children.push(this.parsePrimary());
    return children.length === 1 ? children[0]! : { kind: "and", children };
  }

  private parsePrimary(): ClaimPredicate {
    if (this.consume("(")) {
      const predicate = this.parseOr();
      this.require(")");
      return predicate;
    }
    const left = this.parseOperand();
    this.require("=");
    const right = this.parseOperand();
    return { kind: "equality", left, right };
  }

  private parseOperand(): string {
    const token = this.tokens[this.position];
    if (token?.kind === "parameter") {
      this.position += 1;
      this.consumeCasts();
      const parameterIndex = Number(token.value.slice(1)) - 1;
      if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 0 || parameterIndex >= this.parameters.length) {
        throw new Error("claim certificate predicate references invalid parameter " + token.value);
      }
      const matches = CERTIFICATE_PARAMETER_EQUALITIES.filter(([, contextKey]) =>
        Object.is(this.parameters[parameterIndex], this.context[contextKey]));
      if (matches.length !== 1) {
        throw new Error("claim certificate parameter " + token.value + " does not uniquely bind reviewed context");
      }
      return "context." + matches[0]![1];
    }
    const path = identifierPath(this.tokens, this.position);
    if (!path || path.parts.length < 2) {
      throw new Error(
        "claim certificate predicate expected a qualified identifier at " + (token?.value ?? "end"),
      );
    }
    this.position = path.next;
    this.consumeCasts();
    const qualifier = path.parts.at(-2)!;
    const relation = this.aliases.get(qualifier) ?? qualifier;
    return relation + "." + path.parts.at(-1);
  }

  private consumeCasts(): void {
    while (this.consume("::")) {
      const type = identifierPath(this.tokens, this.position);
      if (!type) throw new Error("claim certificate predicate contains a malformed cast");
      this.position = type.next;
      if (this.consume("[")) this.require("]");
    }
  }

  private consume(value: string): boolean {
    if (this.tokens[this.position]?.value !== value) return false;
    this.position += 1;
    return true;
  }

  private require(value: string): void {
    if (!this.consume(value)) {
      throw new Error(
        "claim certificate predicate expected " + value + " at " +
          (this.tokens[this.position]?.value ?? "end"),
      );
    }
  }
}

function conjunctiveEqualities(predicate: ClaimPredicate): string[] {
  if (predicate.kind === "or") throw new Error("claim certificate predicate must not contain OR");
  if (predicate.kind === "equality") return [canonicalEquality(predicate.left, predicate.right)];
  return predicate.children.flatMap(conjunctiveEqualities);
}

function assertCapturedClaimCertificateOracle(
  query: { sql: string; parameters: unknown[] },
  context: ClaimContext,
): void {
  const tokens = tokenizeClaimSql(query.sql);
  const outerAliases = collectRelationAliases(tokens);
  const certificateSubqueries: ClaimSqlToken[][] = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index]?.value !== "not" || tokens[index + 1]?.value !== "exists" ||
        tokens[index + 2]?.value !== "(") continue;
    const close = matchingCloseParen(tokens, index + 2);
    const subquery = tokens.slice(index + 3, close);
    if (isWorkerLeaseRejectionSubquery(subquery)) certificateSubqueries.push(subquery);
  }
  if (certificateSubqueries.length !== 1) {
    throw new Error(
      "claim query requires exactly one worker_lease_rejections NOT EXISTS anti-join; found " +
        certificateSubqueries.length,
    );
  }
  const subquery = certificateSubqueries[0]!;
  const aliases = new Map([...outerAliases, ...collectRelationAliases(subquery)]);
  const whereIndexes: number[] = [];
  let depth = 0;
  for (let index = 0; index < subquery.length; index += 1) {
    if (subquery[index]?.value === "(") depth += 1;
    else if (subquery[index]?.value === ")") depth -= 1;
    else if (depth === 0 && subquery[index]?.value === "where") whereIndexes.push(index);
  }
  if (whereIndexes.length !== 1) {
    throw new Error(
      "claim certificate anti-join requires exactly one top-level WHERE; found " + whereIndexes.length,
    );
  }
  const predicateStart = whereIndexes[0]! + 1;
  let predicateEnd = subquery.length;
  depth = 0;
  for (let index = predicateStart; index < subquery.length; index += 1) {
    if (subquery[index]?.value === "(") depth += 1;
    else if (subquery[index]?.value === ")") depth -= 1;
    else if (depth === 0 && SUBQUERY_PREDICATE_BOUNDARIES.has(subquery[index]!.value)) {
      predicateEnd = index;
      break;
    }
  }
  const predicate = new ClaimPredicateParser(
    subquery.slice(predicateStart, predicateEnd),
    aliases,
    query.parameters,
    context,
  ).parse();
  const actualEqualities = conjunctiveEqualities(predicate).sort();
  const expectedEqualities = [
    ...CERTIFICATE_COLUMN_EQUALITIES.map(([certificateColumn, currentColumn]) =>
      canonicalEquality("worker_lease_rejections." + certificateColumn, currentColumn)),
    ...CERTIFICATE_PARAMETER_EQUALITIES.map(([certificateColumn, contextKey]) =>
      canonicalEquality("worker_lease_rejections." + certificateColumn, "context." + contextKey)),
  ].sort();
  if (actualEqualities.length !== 18 || JSON.stringify(actualEqualities) !== JSON.stringify(expectedEqualities)) {
    throw new Error(
      "claim certificate predicate must be the exact 18-equality conjunction: " +
        JSON.stringify(actualEqualities),
    );
  }
}

type ReviewedIndexFact = {
  index_name: string;
  valid: boolean;
  ready: boolean;
  columns: string[];
  descending: boolean[];
  predicate: string | null;
};

const REVIEWED_INDEX_CONTRACT = Object.freeze({
  jobs_claim_idx: {
    columns: ["organization_id", "status", "available_at", "priority", "created_at", "id"],
    descending: [false, false, false, true, false, false],
    predicateTerms: [] as string[],
  },
  job_attempts_lease_candidate_idx: {
    columns: ["organization_id", "placement_target_id", "job_id", "id"],
    descending: [false, false, false, false],
    predicateTerms: [
      "status='pending'", "placement_disposition='selected'", "placement_mode='active'",
      "placement_lease_eligible=true",
    ],
  },
  worker_lease_rejections_cleanup_idx: {
    columns: ["organization_id", "updated_at", "worker_id", "attempt_id"],
    descending: [false, false, false, false],
    predicateTerms: [] as string[],
  },
  worker_lease_rejections_pkey: {
    columns: ["organization_id", "worker_id", "attempt_id"],
    descending: [false, false, false],
    predicateTerms: [] as string[],
  },
});

function normalizedPredicateTerms(predicate: string | null): string[] {
  if (!predicate) return [];
  return predicate.toLowerCase().replaceAll('"', "").replace(/::text/g, "")
    .replace(/[()\s]/g, "").split("and").filter(Boolean).sort();
}

function assertReviewedIndexContract(indexes: ReviewedIndexFact[]): void {
  const names = indexes.map((index) => index.index_name).sort();
  const expectedNames = Object.keys(REVIEWED_INDEX_CONTRACT).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error("reviewed index set mismatch");
  for (const [name, contract] of Object.entries(REVIEWED_INDEX_CONTRACT)) {
    const index = indexes.find((candidate) => candidate.index_name === name);
    if (!index || !index.valid || !index.ready) throw new Error(`${name} is missing, invalid, or unready`);
    if (JSON.stringify(index.columns) !== JSON.stringify(contract.columns)) {
      throw new Error(`${name} column order mismatch`);
    }
    if (JSON.stringify(index.descending) !== JSON.stringify(contract.descending)) {
      throw new Error(`${name} direction mismatch`);
    }
    if (JSON.stringify(normalizedPredicateTerms(index.predicate)) !==
        JSON.stringify([...contract.predicateTerms].sort())) {
      throw new Error(`${name} predicate mismatch`);
    }
  }
}

function latestProductionClaimQuery(): { sql: string; parameters: unknown[] } | null {
  return [...capturedQueries].reverse().find((query) =>
    /worker_lease_rejections/i.test(query.sql) && /FOR\s+UPDATE/i.test(query.sql)) ?? null;
}

async function callProductionClaim(input: ClaimContext): Promise<{
  rows: Array<{ job: { id: string }; attempt: { id: string } }>;
  query: { sql: string; parameters: unknown[] };
  querySha256: string;
}> {
  capturedQueries.length = 0;
  const rows = await runInTenant(tenantDatabase() as never, input.organizationId, async (repos) => {
    const operation = repos.jobControl.lockEligibleLeaseCandidates as unknown as (
      context: Omit<ClaimContext, "organizationId">,
    ) => Promise<Array<{ job: { id: string }; attempt: { id: string } }>>;
    return operation({
      workerId: input.workerId,
      targetId: input.targetId,
      targetAuthorityKey: input.targetAuthorityKey,
      placementOwner: input.placementOwner,
      targetClass: input.targetClass,
      targetScope: input.targetScope,
      targetGeneration: input.targetGeneration,
      targetProfileHash: input.targetProfileHash,
      targetProviderConstraintHash: input.targetProviderConstraintHash,
      admissibleWorkloadTypes: input.admissibleWorkloadTypes,
      eligibilityVersion: input.eligibilityVersion,
      staticContextHash: input.staticContextHash,
      limit: 256,
    });
  });
  const query = latestProductionClaimQuery();
  expect.soft(query, "real tenant repository claim query must include the certificate anti-join").not.toBeNull();
  if (!query) throw new Error("production claim query was not captured");
  assertCapturedClaimCertificateOracle(query, input);
  return { rows, query, querySha256: normalizedQuerySha256(query.sql) };
}

async function explainJson(client: Sql, statement: string, parameters: unknown[] = []): Promise<Record<string, unknown>> {
  const rows = await client.unsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    parameters,
  );
  const root = rows[0]?.["QUERY PLAN"];
  if (!Array.isArray(root) || typeof root[0] !== "object" || root[0] === null) {
    throw new Error("E3-PERF-01 returned malformed EXPLAIN JSON");
  }
  return root[0] as Record<string, unknown>;
}

function walkPlan(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  visit(record);
  const plans = record.Plans;
  if (Array.isArray(plans)) for (const child of plans) walkPlan(child, visit);
  if (record.Plan) walkPlan(record.Plan, visit);
}

const REQUIRED_PLAN_INDEXES = [
  "jobs_claim_idx",
  "job_attempts_lease_candidate_idx",
  "worker_lease_rejections_pkey",
] as const;

function assertHotPlan(plan: Record<string, unknown>, shape: string): {
  indexes: string[];
  actualRows: number;
  rowsRemoved: number;
  heapFetches: number;
  sharedBlocks: number;
  localBlocks: number;
  tempBlocks: number;
} {
  const violations: string[] = [];
  const indexes = new Set<string>();
  const summary = { actualRows: 0, rowsRemoved: 0, heapFetches: 0, sharedBlocks: 0, localBlocks: 0, tempBlocks: 0 };
  const numeric = (node: Record<string, unknown>, key: string): number => {
    const value = Number(node[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) violations.push(`invalid_plan_fact:${key}`);
    return value;
  };
  walkPlan(plan, (node) => {
    const nodeType = String(node["Node Type"] ?? "");
    const relation = String(node["Relation Name"] ?? "");
    const index = String(node["Index Name"] ?? "");
    if (index) indexes.add(index);
    const actualRows = numeric(node, "Actual Rows");
    summary.actualRows += actualRows;
    summary.rowsRemoved += numeric(node, "Rows Removed by Filter") + numeric(node, "Rows Removed by Index Recheck");
    summary.heapFetches += numeric(node, "Heap Fetches");
    summary.sharedBlocks += numeric(node, "Shared Hit Blocks") + numeric(node, "Shared Read Blocks") +
      numeric(node, "Shared Dirtied Blocks") + numeric(node, "Shared Written Blocks");
    summary.localBlocks += numeric(node, "Local Hit Blocks") + numeric(node, "Local Read Blocks") +
      numeric(node, "Local Dirtied Blocks") + numeric(node, "Local Written Blocks");
    summary.tempBlocks += numeric(node, "Temp Read Blocks") + numeric(node, "Temp Written Blocks");
    if ((nodeType === "Sort" || nodeType === "Incremental Sort") && (
      node["Sort Method"] !== "top-N heapsort" || actualRows > 256 ||
      numeric(node, "Temp Read Blocks") !== 0 || numeric(node, "Temp Written Blocks") !== 0
    )) violations.push("unbounded_or_spilled_sort");
    if ((nodeType === "Seq Scan" || nodeType === "Parallel Seq Scan") &&
        ["jobs", "job_attempts", "worker_lease_rejections"].includes(relation)) {
      violations.push(`hot_sequential_scan:${relation}`);
    }
  });
  for (const required of REQUIRED_PLAN_INDEXES) {
    if (!indexes.has(required)) violations.push(`missing_required_index:${required}`);
  }
  expect(violations, shape).toEqual([]);
  return { indexes: [...indexes].sort(), ...summary };
}

function assertCleanupPlan(plan: Record<string, unknown>, layout: string, affectedRows = 256): {
  indexes: string[];
  actualRows: number;
  rowsRemoved: number;
  tempBlocks: number;
  rootActualRows: number;
  candidateRows: number;
  affectedRows: number;
} {
  const violations: string[] = [];
  const indexes = new Set<string>();
  const summary = { actualRows: 0, rowsRemoved: 0, tempBlocks: 0 };
  let candidateRows = 0;
  const numeric = (node: Record<string, unknown>, key: string): number => {
    const value = Number(node[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) violations.push(`invalid_plan_fact:${key}`);
    return value;
  };
  walkPlan(plan, (node) => {
    const nodeType = String(node["Node Type"] ?? "");
    const relation = String(node["Relation Name"] ?? "");
    const index = String(node["Index Name"] ?? "");
    if (index) indexes.add(index);
    const actualRows = numeric(node, "Actual Rows");
    if (relation === "worker_lease_rejections" || nodeType === "Limit") {
      candidateRows = Math.max(candidateRows, actualRows);
    }
    const tempBlocks = numeric(node, "Temp Read Blocks") + numeric(node, "Temp Written Blocks");
    summary.actualRows += actualRows;
    summary.rowsRemoved += numeric(node, "Rows Removed by Filter") + numeric(node, "Rows Removed by Index Recheck");
    summary.tempBlocks += tempBlocks;
    if ((nodeType === "Sort" || nodeType === "Incremental Sort") && (
      node["Sort Method"] !== "top-N heapsort" || actualRows > 256 || tempBlocks !== 0
    )) violations.push("unbounded_or_spilled_sort");
    if ((nodeType === "Seq Scan" || nodeType === "Parallel Seq Scan") &&
        ["jobs", "job_attempts", "worker_lease_rejections"].includes(relation)) {
      violations.push(`hot_sequential_scan:${relation}`);
    }
  });
  if (!indexes.has("worker_lease_rejections_cleanup_idx")) {
    violations.push("missing_required_index:worker_lease_rejections_cleanup_idx");
  }
  const root = plan.Plan && typeof plan.Plan === "object" && !Array.isArray(plan.Plan)
    ? plan.Plan as Record<string, unknown>
    : plan;
  if (!Object.hasOwn(root, "Actual Rows")) violations.push("missing_root_actual_rows");
  const rootActualRows = numeric(root, "Actual Rows");
  if (affectedRows !== 256) violations.push(`wrong_affected_rows:${affectedRows}`);
  if (rootActualRows !== 256) violations.push(`wrong_root_actual_rows:${rootActualRows}`);
  if (candidateRows !== 256) violations.push(`wrong_candidate_rows:${candidateRows}`);
  expect(violations, `cleanup:${layout}`).toEqual([]);
  return { indexes: [...indexes].sort(), ...summary, rootActualRows, candidateRows, affectedRows };
}

function deterministicUuidSql(namespace: string, ordinalSql: string): string {
  return `md5('${namespace}:' || (${ordinalSql})::text)::uuid`;
}

const CERTIFICATE_ONLY_GUARDED_TABLES = Object.freeze([
  "workers",
  "execution_targets",
  "jobs",
  "job_attempts",
  "leases",
] as const);

async function installCertificateOnlyMutationGuards(client: Sql): Promise<void> {
  await client.unsafe(`CREATE OR REPLACE FUNCTION e3_perf_01_reject_non_certificate_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'E3_PERF_01_CERTIFICATE_ONLY_VIOLATION:%', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$`);
  for (const table of CERTIFICATE_ONLY_GUARDED_TABLES) {
    await client.unsafe(`DROP TRIGGER IF EXISTS e3_perf_01_certificate_only_guard ON ${table}`);
    await client.unsafe(`CREATE TRIGGER e3_perf_01_certificate_only_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION e3_perf_01_reject_non_certificate_mutation()`);
  }
}

async function dropCertificateOnlyMutationGuards(client: Sql): Promise<void> {
  for (const table of CERTIFICATE_ONLY_GUARDED_TABLES) {
    await client.unsafe(`DROP TRIGGER IF EXISTS e3_perf_01_certificate_only_guard ON ${table}`);
  }
  await client.unsafe("DROP FUNCTION IF EXISTS e3_perf_01_reject_non_certificate_mutation() CASCADE");
}

async function assertCertificateOnlyMutationGuardsRejectTenantWrites(client: Sql): Promise<void> {
  for (const table of CERTIFICATE_ONLY_GUARDED_TABLES) {
    await expect(client.begin(async (tx) => {
      const query = tx as unknown as Sql;
      await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
      const statement = table === "workers"
        ? "UPDATE workers SET last_seen_at = last_seen_at WHERE false"
        : `DELETE FROM ${table} WHERE false`;
      await query.unsafe(statement);
    }), `${table} guard must reject an aoa_app mutation inside its transaction`).rejects.toThrow(
      `E3_PERF_01_CERTIFICATE_ONLY_VIOLATION:${table}`,
    );
  }
}

async function seedE3Perf01Corpus(client: Sql): Promise<void> {
  const jobIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-job`, "ordinal");
  const attemptIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-attempt`, "ordinal");
  const targetIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-target`, "ordinal");
  const workerIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-worker`, "ordinal");
  await client.begin(async (tx) => {
    const query = tx as unknown as Sql;
    await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
    await query`DELETE FROM jobs WHERE source_kind = 'e3_perf_01'`;
    await query`DELETE FROM workers WHERE label LIKE 'E3-PERF-01 worker %'`;
    await query`DELETE FROM execution_targets WHERE slug LIKE 'e3-perf-01-target-%'`;
    await query`INSERT INTO organizations (id, name, slug, status)
      VALUES (${E3_PERF_01_ORGANIZATION_ID}, 'E3-PERF-01 Organization', 'e3-perf-01', 'active')
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`;
    await query`INSERT INTO companies (id, organization_id, name, issue_prefix, status)
      VALUES (${E3_PERF_01_COMPANY_ID}, ${E3_PERF_01_ORGANIZATION_ID}, 'E3-PERF-01 Company', 'E3P', 'active')
      ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, status = EXCLUDED.status`;
    await query`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key,
       device_generation, last_seen_at)
      VALUES (${E3_PERF_01_HOT_TARGET_ID}, ${E3_PERF_01_ORGANIZATION_ID},
        'e3-perf-01-target-0', 'dedicated_worker', 'dedicated_tenant', 'active', 'organization',
        ${E3_PERF_01_TARGET_AUTHORITY_KEY}, 1, clock_timestamp())`;
    await query.unsafe(`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key,
       device_generation, last_seen_at)
      SELECT ${targetIdSql}, '${E3_PERF_01_ORGANIZATION_ID}'::uuid,
        'e3-perf-01-target-' || ordinal, 'dedicated_worker', 'dedicated_tenant', 'active',
        'organization', '${E3_PERF_01_TARGET_AUTHORITY_KEY}', 1, clock_timestamp()
      FROM generate_series(1, 10000) AS seed(ordinal)`);
    await query`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, enrolled_at, last_seen_at, label, status)
      VALUES (${E3_PERF_01_HOT_WORKER_ID}, 'organization', ${E3_PERF_01_ORGANIZATION_ID},
        ${E3_PERF_01_HOT_TARGET_ID}, ${E3_PERF_01_TARGET_AUTHORITY_KEY}, 'e3-perf-01-key-0',
        ${"7".repeat(64)}, 1, ${E3_PERF_01_PROFILE_HASH}, clock_timestamp(), clock_timestamp(),
        'E3-PERF-01 worker 0', 'active')`;
    await query.unsafe(`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, enrolled_at, last_seen_at, label, status)
      SELECT ${workerIdSql}, 'organization', '${E3_PERF_01_ORGANIZATION_ID}'::uuid,
        ${targetIdSql}, '${E3_PERF_01_TARGET_AUTHORITY_KEY}', 'e3-perf-01-key-' || ordinal,
        md5('e3-perf-01-thumb:' || ordinal) || md5('e3-perf-01-thumb:' || ordinal || ':2'), 1,
        '${E3_PERF_01_PROFILE_HASH}', clock_timestamp(), clock_timestamp(),
        'E3-PERF-01 worker ' || ordinal, 'active'
      FROM generate_series(1, 10000) AS seed(ordinal)`);
    await query.unsafe(`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, idempotency_key, command_digest,
       source_kind, source_identity, priority, available_at, status, created_at, updated_at)
      SELECT ${jobIdSql}, '${E3_PERF_01_ORGANIZATION_ID}'::uuid,
        '${E3_PERF_01_COMPANY_ID}'::uuid, 'batch', 'e3-perf-01-' || ordinal,
        md5('e3-perf-01-command:' || ordinal) || md5('e3-perf-01-command:' || ordinal || ':2'),
        'e3_perf_01', ordinal::text, 0,
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond', 'queued',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond'
      FROM generate_series(1, 1000000) AS seed(ordinal)`);
    await query.unsafe(`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at, created_at, updated_at)
      SELECT ${attemptIdSql}, '${E3_PERF_01_ORGANIZATION_ID}'::uuid,
        '${E3_PERF_01_COMPANY_ID}'::uuid, ${jobIdSql}, 1, 'pending', 'selected',
        'organization_dedicated', '${E3_PERF_01_HOT_TARGET_ID}'::uuid,
        'organization_dedicated', 'organization', 1, '${E3_PERF_01_PROFILE_HASH}',
        '${E3_PERF_01_PROVIDER_HASH}', 'primary', 'target_selected', 'active', true,
        '${E3_PERF_01_INPUT_DIGEST}', '${E3_PERF_01_POLICY_DIGEST}',
        TIMESTAMPTZ '2026-08-01 00:00:00+00',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond'
      FROM generate_series(1, 1000000) AS seed(ordinal)`);
    await query.unsafe(`INSERT INTO worker_lease_rejections
      (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
       target_authority_key, eligibility_version, static_context_hash, workload_type,
       placement_owner, placement_target_class, placement_target_scope,
       placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
       placement_input_digest, placement_policy_digest, reason_code, created_at, updated_at)
      SELECT '${E3_PERF_01_ORGANIZATION_ID}'::uuid, '${E3_PERF_01_COMPANY_ID}'::uuid,
        ${jobIdSql}, ${attemptIdSql}, '${E3_PERF_01_HOT_WORKER_ID}'::uuid,
        '${E3_PERF_01_HOT_TARGET_ID}'::uuid, '${E3_PERF_01_TARGET_AUTHORITY_KEY}', 1,
        '${E3_PERF_01_STATIC_CONTEXT_HASH}', 'batch', 'organization_dedicated',
        'organization_dedicated', 'organization', 1, '${E3_PERF_01_PROFILE_HASH}',
        '${E3_PERF_01_PROVIDER_HASH}', '${E3_PERF_01_INPUT_DIGEST}',
        '${E3_PERF_01_POLICY_DIGEST}', 'static_requirements_mismatch',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + ordinal * INTERVAL '1 microsecond'
      FROM generate_series(1, 1000000) AS seed(ordinal)`);
    await query.unsafe("ANALYZE jobs, job_attempts, workers, execution_targets, worker_lease_rejections");
  });
}

async function prepareE3Perf01ClaimScenario(
  client: Sql,
  scenario: (typeof E3_PERF_01_CLAIM_SCENARIOS)[number],
): Promise<void> {
  const jobIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-job`, "j.source_identity::integer");
  const attemptIdSql = deterministicUuidSql(`${E3_PERF_01_SEED_NAMESPACE}-attempt`, "j.source_identity::integer");
  const targetIdSql = deterministicUuidSql(
    `${E3_PERF_01_SEED_NAMESPACE}-target`,
    "(((j.source_identity::integer - 1) / 100) + 1)",
  );
  await client.begin(async (tx) => {
    const query = tx as unknown as Sql;
    await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
    await query`DELETE FROM worker_lease_rejections`;
    await query`UPDATE jobs SET status = 'queued'
      WHERE source_kind = 'e3_perf_01'`;

    if (scenario === "ten_thousand_workers_by_one_hundred") {
      await query.unsafe(`UPDATE job_attempts AS ja SET
        status = 'pending', placement_target_id = ${targetIdSql}, updated_at = clock_timestamp()
        FROM jobs AS j
        WHERE j.organization_id = ja.organization_id AND j.company_id = ja.company_id
          AND j.id = ja.job_id AND j.source_kind = 'e3_perf_01'`);
      await query.unsafe(`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
         placement_input_digest, placement_policy_digest, reason_code, created_at, updated_at)
        SELECT j.organization_id, j.company_id, ${jobIdSql}, ${attemptIdSql}, w.id,
          ${targetIdSql}, '${E3_PERF_01_TARGET_AUTHORITY_KEY}', 1,
          '${E3_PERF_01_STATIC_CONTEXT_HASH}', 'batch', 'organization_dedicated',
          'organization_dedicated', 'organization', 1, '${E3_PERF_01_PROFILE_HASH}',
          '${E3_PERF_01_PROVIDER_HASH}', '${E3_PERF_01_INPUT_DIGEST}',
          '${E3_PERF_01_POLICY_DIGEST}', 'static_requirements_mismatch',
          TIMESTAMPTZ '2026-08-01 00:00:00+00' + j.source_identity::integer * INTERVAL '1 microsecond',
          TIMESTAMPTZ '2026-08-01 00:00:00+00' + j.source_identity::integer * INTERVAL '1 microsecond'
        FROM jobs AS j
        JOIN workers AS w ON w.organization_id = j.organization_id
          AND w.execution_target_id = ${targetIdSql}
        WHERE j.source_kind = 'e3_perf_01'`);
      return;
    }

    await query`UPDATE job_attempts AS ja SET status = 'pending',
      placement_target_id = ${E3_PERF_01_HOT_TARGET_ID}, updated_at = clock_timestamp()
      FROM jobs AS j
      WHERE j.organization_id = ja.organization_id AND j.company_id = ja.company_id
        AND j.id = ja.job_id AND j.source_kind = 'e3_perf_01'`;
    await query.unsafe(`INSERT INTO worker_lease_rejections
      (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
       target_authority_key, eligibility_version, static_context_hash, workload_type,
       placement_owner, placement_target_class, placement_target_scope,
       placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
       placement_input_digest, placement_policy_digest, reason_code, created_at, updated_at)
      SELECT j.organization_id, j.company_id, ${jobIdSql}, ${attemptIdSql},
        '${E3_PERF_01_HOT_WORKER_ID}'::uuid, '${E3_PERF_01_HOT_TARGET_ID}'::uuid,
        '${E3_PERF_01_TARGET_AUTHORITY_KEY}',
        CASE WHEN '${scenario}' = 'ninety_percent_stale_version_or_context'
          AND j.source_identity::integer <= 450000 THEN 2 ELSE 1 END,
        CASE WHEN '${scenario}' = 'ninety_percent_stale_version_or_context'
          AND j.source_identity::integer BETWEEN 450001 AND 900000 THEN '${"8".repeat(64)}'
          ELSE '${E3_PERF_01_STATIC_CONTEXT_HASH}' END,
        'batch', 'organization_dedicated', 'organization_dedicated', 'organization', 1,
        '${E3_PERF_01_PROFILE_HASH}', '${E3_PERF_01_PROVIDER_HASH}',
        '${E3_PERF_01_INPUT_DIGEST}', '${E3_PERF_01_POLICY_DIGEST}',
        'static_requirements_mismatch',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + j.source_identity::integer * INTERVAL '1 microsecond',
        TIMESTAMPTZ '2026-08-01 00:00:00+00' + j.source_identity::integer * INTERVAL '1 microsecond'
      FROM jobs AS j WHERE j.source_kind = 'e3_perf_01'`);
    if (scenario === "hot_worker_head_saturated_999744_prefix") {
      await query`DELETE FROM worker_lease_rejections AS rejection
        USING jobs AS j
        WHERE j.organization_id = rejection.organization_id
          AND j.company_id = rejection.company_id AND j.id = rejection.job_id
          AND j.source_kind = 'e3_perf_01' AND j.source_identity::integer > 999744`;
    }
  });
  await seedDatabase().unsafe("ANALYZE jobs, job_attempts, worker_lease_rejections");
}

async function directClaimFixture(
  client: Sql,
  scenario: (typeof E3_PERF_01_CLAIM_SCENARIOS)[number],
): Promise<ClaimContext> {
  const workerLabel = scenario === "ten_thousand_workers_by_one_hundred"
    ? "E3-PERF-01 worker 1"
    : "E3-PERF-01 worker 0";
  const [fixture] = await client<{
    worker_id: string;
    target_id: string;
    target_authority_key: string;
    target_generation: number;
  }[]>`
    SELECT w.id AS worker_id, t.id AS target_id, w.target_authority_key,
      t.device_generation AS target_generation
    FROM workers AS w
    JOIN execution_targets AS t ON t.id = w.execution_target_id
      AND t.target_authority_key = w.target_authority_key
    WHERE w.organization_id = ${E3_PERF_01_ORGANIZATION_ID} AND w.label = ${workerLabel}`;
  expect.soft(fixture, `seeded worker for ${scenario}`).toBeDefined();
  if (!fixture) throw new Error(`E3-PERF-01 fixture missing for ${scenario}`);
  return {
    organizationId: E3_PERF_01_ORGANIZATION_ID,
    workerId: fixture.worker_id,
    targetId: fixture.target_id,
    targetAuthorityKey: fixture.target_authority_key,
    placementOwner: "organization_dedicated",
    targetClass: "organization_dedicated",
    targetScope: "organization",
    targetGeneration: fixture.target_generation,
    targetProfileHash: E3_PERF_01_PROFILE_HASH,
    targetProviderConstraintHash: E3_PERF_01_PROVIDER_HASH,
    admissibleWorkloadTypes: ["batch"],
    eligibilityVersion: 1,
    staticContextHash: E3_PERF_01_STATIC_CONTEXT_HASH,
    limit: 256,
  };
}

async function assertCanonicalClaimShape(
  client: Sql,
  scenario: (typeof E3_PERF_01_CLAIM_SCENARIOS)[number],
): Promise<string[]> {
  const [counts] = await client<{
    candidates: number;
    certificates: number;
    current_certificates: number;
    stale_certificates: number;
    minimum_eligibility_version: number | null;
  }[]>`
    SELECT
      count(*)::int AS candidates,
      count(rejection.attempt_id)::int AS certificates,
      count(rejection.attempt_id) FILTER (WHERE rejection.eligibility_version = 1
        AND rejection.static_context_hash = ${E3_PERF_01_STATIC_CONTEXT_HASH})::int AS current_certificates,
      count(rejection.attempt_id) FILTER (WHERE rejection.eligibility_version <> 1
        OR rejection.static_context_hash <> ${E3_PERF_01_STATIC_CONTEXT_HASH})::int AS stale_certificates,
      min(rejection.eligibility_version)::int AS minimum_eligibility_version
    FROM job_attempts AS attempt
    JOIN jobs AS job ON job.organization_id = attempt.organization_id
      AND job.company_id = attempt.company_id AND job.id = attempt.job_id
    LEFT JOIN worker_lease_rejections AS rejection
      ON rejection.organization_id = attempt.organization_id
      AND rejection.company_id = attempt.company_id AND rejection.job_id = attempt.job_id
      AND rejection.attempt_id = attempt.id
    WHERE job.source_kind = 'e3_perf_01'`;
  expect.soft(counts?.candidates, scenario).toBe(1_000_000);
  expect.soft(counts?.minimum_eligibility_version, `${scenario}:positive-version`).toBeGreaterThan(0);

  if (scenario === "hot_worker_fully_certified_no_work") {
    expect.soft(counts).toMatchObject({ certificates: 1_000_000, current_certificates: 1_000_000, stale_certificates: 0 });
  } else if (scenario === "hot_worker_head_saturated_999744_prefix") {
    expect.soft(counts).toMatchObject({ certificates: 999_744, current_certificates: 999_744, stale_certificates: 0 });
  } else if (scenario === "ten_thousand_workers_by_one_hundred") {
    const [distribution] = await client<{ workers: number; total_rows: number; min_rows: number; max_rows: number }[]>`
      SELECT count(*)::int AS workers, sum(rows_per_worker)::int AS total_rows,
        min(rows_per_worker)::int AS min_rows, max(rows_per_worker)::int AS max_rows
      FROM (
        SELECT worker.id, count(*)::int AS rows_per_worker
        FROM workers AS worker
        JOIN job_attempts AS attempt ON attempt.organization_id = worker.organization_id
          AND attempt.placement_target_id = worker.execution_target_id
        JOIN jobs AS job ON job.organization_id = attempt.organization_id
          AND job.company_id = attempt.company_id AND job.id = attempt.job_id
        WHERE job.source_kind = 'e3_perf_01' AND worker.label LIKE 'E3-PERF-01 worker %'
          AND worker.label <> 'E3-PERF-01 worker 0'
        GROUP BY worker.id
      ) AS worker_rows`;
    expect.soft(distribution).toEqual({ workers: 10_000, total_rows: 1_000_000, min_rows: 100, max_rows: 100 });
    expect.soft(counts).toMatchObject({ certificates: 1_000_000, current_certificates: 1_000_000, stale_certificates: 0 });
  } else {
    expect.soft(counts?.certificates).toBe(1_000_000);
    expect.soft(counts?.stale_certificates).toBeGreaterThanOrEqual(900_000);
    expect.soft(counts?.current_certificates).toBeLessThanOrEqual(100_000);
  }

  const expectedOrdinals = scenario === "hot_worker_head_saturated_999744_prefix"
    ? Array.from({ length: 256 }, (_, index) => 999_745 + index)
    : scenario === "ninety_percent_stale_version_or_context"
      ? Array.from({ length: 256 }, (_, index) => index + 1)
      : [];
  const expectedRows = expectedOrdinals.length === 0 ? [] : await client<{ ordinal: number; attempt_id: string }[]>`
    SELECT job.source_identity::int AS ordinal, attempt.id AS attempt_id
    FROM jobs AS job
    JOIN job_attempts AS attempt ON attempt.organization_id = job.organization_id
      AND attempt.company_id = job.company_id AND attempt.job_id = job.id
    WHERE job.source_kind = 'e3_perf_01'
      AND job.source_identity::int = ANY(${expectedOrdinals}::int[])
    ORDER BY job.available_at ASC, job.priority DESC, job.created_at ASC, job.id ASC`;
  expect.soft(expectedRows.map((row) => row.ordinal), `${scenario}:canonical-order`).toEqual(expectedOrdinals);
  return expectedRows.map((row) => row.attempt_id);
}

async function prepareAndAssertCleanupLayout(client: Sql, layout: "sparse" | "tail"): Promise<void> {
  await prepareE3Perf01ClaimScenario(client, "hot_worker_fully_certified_no_work");
  await client.begin(async (tx) => {
    const query = tx as unknown as Sql;
    await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
    await query`UPDATE jobs SET status = CASE WHEN source_identity::integer % 4 = 0
        THEN 'succeeded' ELSE 'queued' END
      WHERE source_kind = 'e3_perf_01'`;
    await query`UPDATE job_attempts AS attempt SET status = CASE WHEN job.status = 'succeeded'
        THEN 'succeeded' ELSE 'pending' END
      FROM jobs AS job
      WHERE job.organization_id = attempt.organization_id
        AND job.company_id = attempt.company_id AND job.id = attempt.job_id
        AND job.source_kind = 'e3_perf_01'`;
    await query`UPDATE worker_lease_rejections AS rejection SET
        updated_at = TIMESTAMPTZ '2026-08-01 00:00:00+00'
          + job.source_identity::integer * INTERVAL '1 microsecond'
      FROM jobs AS job
      WHERE job.organization_id = rejection.organization_id
        AND job.company_id = rejection.company_id AND job.id = rejection.job_id
        AND job.source_kind = 'e3_perf_01'`;
    if (layout === "tail") {
      await query`UPDATE worker_lease_rejections AS rejection SET
          updated_at = TIMESTAMPTZ '2026-09-01 00:00:00+00'
            + job.source_identity::integer * INTERVAL '1 microsecond'
        FROM jobs AS job
        WHERE job.organization_id = rejection.organization_id
          AND job.company_id = rejection.company_id AND job.id = rejection.job_id
          AND job.source_kind = 'e3_perf_01' AND job.status = 'succeeded'`;
    }
  });
  await seedDatabase().unsafe("ANALYZE jobs, worker_lease_rejections");

  const [attestation] = await client<{
    eligible_rows: number;
    first_eligible_position: number;
    last_eligible_position: number;
    max_eligible_gap: number | null;
  }[]>`
    WITH ordered AS (
      SELECT job.status,
        row_number() OVER (ORDER BY rejection.organization_id, rejection.updated_at,
          rejection.worker_id, rejection.attempt_id)::int AS position
      FROM worker_lease_rejections AS rejection
      JOIN jobs AS job ON job.organization_id = rejection.organization_id
        AND job.company_id = rejection.company_id AND job.id = rejection.job_id
      WHERE job.source_kind = 'e3_perf_01'
    ), eligible AS (
      SELECT position, position - lag(position) OVER (ORDER BY position) AS gap
      FROM ordered WHERE status = 'succeeded'
    )
    SELECT count(*)::int AS eligible_rows, min(position)::int AS first_eligible_position,
      max(position)::int AS last_eligible_position, max(gap)::int AS max_eligible_gap
    FROM eligible`;
  if (layout === "sparse") {
    expect.soft(attestation).toEqual({
      eligible_rows: 250_000,
      first_eligible_position: 4,
      last_eligible_position: 1_000_000,
      max_eligible_gap: 4,
    });
  } else {
    expect.soft(attestation).toEqual({
      eligible_rows: 250_000,
      first_eligible_position: 750_001,
      last_eligible_position: 1_000_000,
      max_eligible_gap: 1,
    });
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const url = process.env.AOA_E3_PERF_DATABASE_URL;
  if (!url) throw new Error("AOA_E3_PERF_DATABASE_URL is required for E3-PERF-01");
  // A single setup/attestation connection keeps the tenant GUC deterministic;
  // production repository calls still use the separate runInTenant connection.
  db = postgres(url, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: null });
  tenantSql = postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    max_lifetime: null,
    debug: (_connection, statement, parameters) => {
      capturedQueries.push({ sql: statement, parameters: [...parameters] });
    },
  });
  seedSql = postgres(url, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: null });
  tenantDb = drizzle(tenantSql);
  // The pinned setup credential seeds the disposable corpus, while every
  // measured/direct tenant query runs under the hardened serving role.
  await db.unsafe('SET ROLE "aoa_app"');
  await tenantSql.unsafe('SET ROLE "aoa_app"');
  const [role] = await db<{ current_user: string; superuser: boolean; bypassrls: boolean }[]>`
    SELECT current_user, rol.rolsuper AS superuser, rol.rolbypassrls AS bypassrls
    FROM pg_roles rol WHERE rol.rolname = current_user`;
  expect(role).toEqual({ current_user: "aoa_app", superuser: false, bypassrls: false });
  const [seedRole] = await seedSql<{
    current_user: string;
    organizations_insert: boolean;
    companies_insert: boolean;
    targets_insert: boolean;
  }[]>`
    SELECT current_user,
      has_table_privilege(current_user, 'organizations', 'INSERT') AS organizations_insert,
      has_table_privilege(current_user, 'companies', 'INSERT') AS companies_insert,
      has_table_privilege(current_user, 'execution_targets', 'INSERT') AS targets_insert`;
  expect(seedRole?.current_user).not.toBe("aoa_app");
  expect(seedRole).toMatchObject({
    organizations_insert: true,
    companies_insert: true,
    targets_insert: true,
  });
  await db`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, false)`;
  await seedSql`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, false)`;
  await seedE3Perf01Corpus(seedSql);
  const [posture] = await db<{
    candidates: number;
    certificates: number;
    certificate_table: string | null;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM job_attempts WHERE status = 'pending') AS candidates,
      CASE WHEN to_regclass('public.worker_lease_rejections') IS NULL THEN 0
        ELSE (SELECT count(*)::int FROM worker_lease_rejections) END AS certificates,
      to_regclass('public.worker_lease_rejections')::text AS certificate_table
  `;
  expect(posture).toEqual({
    candidates: E3_PERF_01_DATASET.candidateRows,
    certificates: E3_PERF_01_DATASET.certificateRows,
    certificate_table: "worker_lease_rejections",
  });
}, 30 * 60_000);

afterAll(async () => {
  await tenantSql?.end();
  await db?.end();
  await seedSql?.end();
}, 60_000);

describe("E3-PERF-01 immutable load contract", () => {
  it("pins the immutable INITIAL corpus, samples, thresholds, and four named shapes", () => {
    expect(E3_PERF_01_DATASET).toEqual({
      seed: 3003,
      candidateRows: 1_000_000,
      certificateRows: 1_000_000,
      warmups: 5,
      claimSamples: 30,
      mutationSamples: 20,
      batchSize: 256,
    });
    expect(E3_PERF_01_SHAPES).toEqual([
      "hot_worker_fully_certified_then_head_saturated",
      "ten_thousand_workers_by_one_hundred",
      "ninety_percent_stale_version_or_context",
      "cleanup_sparse_then_tail",
    ]);
    expect(E3_PERF_01_CLAIM_SCENARIOS).toEqual([
      "hot_worker_fully_certified_no_work",
      "hot_worker_head_saturated_999744_prefix",
      "ten_thousand_workers_by_one_hundred",
      "ninety_percent_stale_version_or_context",
    ]);
    expect(E3_PERF_01_INITIAL_THRESHOLDS).toEqual({
      shapesTwoThreeP95Ms: 250,
      shapesTwoThreeMaxMs: 1_500,
      saturatedP95Ms: 2_000,
      saturatedMaxMs: 5_000,
      bulkUpsertP95Ms: 500,
      cleanupP95Ms: 750,
      combinedTableIndexBytesMax: 2 * 1024 * 1024 * 1024,
    });
  });

  it("fails closed on hot sequential scans, spilled/unbounded sorts, and missing reviewed indexes", () => {
    const valid = {
      Plan: {
        "Node Type": "Limit",
        "Actual Rows": 256,
        Plans: [{
          "Node Type": "Index Scan",
          "Relation Name": "jobs",
          "Index Name": "jobs_claim_idx",
          "Actual Rows": 256,
          Plans: [{
            "Node Type": "Index Scan",
            "Relation Name": "job_attempts",
            "Index Name": "job_attempts_lease_candidate_idx",
            "Actual Rows": 256,
            Plans: [{
              "Node Type": "Index Only Scan",
              "Relation Name": "worker_lease_rejections",
              "Index Name": "worker_lease_rejections_pkey",
              "Actual Rows": 256,
              "Heap Fetches": 0,
            }],
          }],
        }],
      },
    };
    expect(() => assertHotPlan(valid, "valid")).not.toThrow();
    expect(() => assertHotPlan({ Plan: {
      "Node Type": "Seq Scan", "Relation Name": "jobs", "Actual Rows": 1,
    } }, "seq")).toThrow();
    const invalidHotSort = (nodeType: "Sort" | "Incremental Sort") => ({ Plan: {
      "Node Type": "Limit", "Actual Rows": 256, Plans: [{
        "Node Type": nodeType, "Sort Method": "external merge", "Actual Rows": 257,
        "Temp Read Blocks": 1, "Temp Written Blocks": 1, Plans: [{
          "Node Type": "Index Scan", "Relation Name": "jobs", "Index Name": "jobs_claim_idx",
          "Actual Rows": 256, Plans: [{
            "Node Type": "Index Scan", "Relation Name": "job_attempts",
            "Index Name": "job_attempts_lease_candidate_idx", "Actual Rows": 256, Plans: [{
              "Node Type": "Index Only Scan", "Relation Name": "worker_lease_rejections",
              "Index Name": "worker_lease_rejections_pkey", "Actual Rows": 256,
              "Heap Fetches": 0,
            }],
          }],
        }],
      }],
    } });
    for (const nodeType of ["Sort", "Incremental Sort"] as const) {
      expect(
        () => assertHotPlan(invalidHotSort(nodeType), `hot-${nodeType}`),
        `${nodeType} must be classified even when every reviewed index and cardinality fact is present`,
      ).toThrow(/unbounded_or_spilled_sort/);
    }
    expect(() => assertCleanupPlan({ Plan: {
      "Node Type": "Index Scan", "Relation Name": "worker_lease_rejections",
      "Index Name": "worker_lease_rejections_cleanup_idx", "Actual Rows": 256,
    } }, "valid")).not.toThrow();
    for (const nodeType of ["Sort", "Incremental Sort"] as const) {
      expect(() => assertCleanupPlan({ Plan: {
        "Node Type": nodeType, "Sort Method": "external merge", "Actual Rows": 256,
        "Temp Read Blocks": 1, "Temp Written Blocks": 1, Plans: [{
          "Node Type": "Index Scan", "Relation Name": "worker_lease_rejections",
          "Index Name": "worker_lease_rejections_cleanup_idx", "Actual Rows": 256,
        }],
      } }, `cleanup-${nodeType}`)).toThrow(/unbounded_or_spilled_sort/);
    }
    expect(() => assertCleanupPlan({ Plan: {
      "Node Type": "Seq Scan", "Relation Name": "worker_lease_rejections", "Actual Rows": 0,
    } }, "seq")).toThrow();
    for (const relation of ["jobs", "job_attempts"]) {
      expect(() => assertCleanupPlan({ Plan: {
        "Node Type": "Seq Scan", "Relation Name": relation, "Actual Rows": 256,
        Plans: [{
          "Node Type": "Index Scan", "Relation Name": "worker_lease_rejections",
          "Index Name": "worker_lease_rejections_cleanup_idx", "Actual Rows": 256,
        }],
      } }, `cleanup-seq:${relation}`)).toThrow();
    }
    expect(() => assertCleanupPlan({ Plan: {
      "Node Type": "Index Scan", "Relation Name": "worker_lease_rejections",
      "Index Name": "worker_lease_rejections_cleanup_idx",
    } }, "missing-cardinality")).toThrow();
  });

  it("attests every equality in the actual production certificate anti-join", () => {
    const context: ClaimContext = {
      organizationId: E3_PERF_01_ORGANIZATION_ID,
      workerId: E3_PERF_01_HOT_WORKER_ID,
      targetId: E3_PERF_01_HOT_TARGET_ID,
      targetAuthorityKey: E3_PERF_01_TARGET_AUTHORITY_KEY,
      placementOwner: "organization_dedicated",
      targetClass: "organization_dedicated",
      targetScope: "organization",
      targetGeneration: 1,
      targetProfileHash: E3_PERF_01_PROFILE_HASH,
      targetProviderConstraintHash: E3_PERF_01_PROVIDER_HASH,
      admissibleWorkloadTypes: ["batch"],
      eligibilityVersion: 1,
      staticContextHash: E3_PERF_01_STATIC_CONTEXT_HASH,
      limit: 256,
    };
    const columnClauses = CERTIFICATE_COLUMN_EQUALITIES.map(([certificate, current]) =>
      `worker_lease_rejections.${certificate} = ${current}`);
    const parameterClauses = CERTIFICATE_PARAMETER_EQUALITIES.map(([certificate], index) =>
      `worker_lease_rejections.${certificate} = $${index + 1}`);
    const clauses = [...columnClauses, ...parameterClauses];
    const canonicalQuery = {
      sql: `SELECT job_attempts.id FROM job_attempts JOIN jobs ON true WHERE NOT EXISTS
        (SELECT 1 FROM worker_lease_rejections WHERE ${clauses.join(" AND ")}) FOR UPDATE`,
      parameters: [
        context.workerId, context.targetId, context.targetAuthorityKey,
        context.eligibilityVersion, context.staticContextHash,
      ],
    };
    expect(() => assertCapturedClaimCertificateOracle(canonicalQuery, context)).not.toThrow();
    const productionColumnClauses = CERTIFICATE_COLUMN_EQUALITIES.map(([certificate, current]) => {
      const [relation, column] = current.split(".");
      const alias = relation === "job_attempts" ? "attempt" : "job";
      return `"rejection"."${certificate}" = "${alias}"."${column}"`;
    });
    const productionParameterClauses = CERTIFICATE_PARAMETER_EQUALITIES.map(([certificate], index) =>
      `"rejection"."${certificate}" = $${index + 1}`);
    const productionShapedQuery = {
      ...canonicalQuery,
      sql: `SELECT "attempt"."id" FROM "job_attempts" AS "attempt"
        JOIN "jobs" AS "job" ON "job"."id" = "attempt"."job_id"
        WHERE NOT EXISTS (SELECT 1 FROM "worker_lease_rejections" AS "rejection" WHERE (
          ${[...productionColumnClauses, ...productionParameterClauses].join(") AND (")}
        )) FOR UPDATE`,
    };
    expect(() => assertCapturedClaimCertificateOracle(productionShapedQuery, context)).not.toThrow();

    const globalDecoyQuery = {
      ...canonicalQuery,
      sql: `SELECT job_attempts.id FROM job_attempts JOIN jobs ON true
        WHERE ${clauses[0]} AND NOT EXISTS
          (SELECT 1 FROM worker_lease_rejections WHERE ${clauses.slice(1).join(" AND ")}) FOR UPDATE`,
    };
    expect(() => assertCapturedClaimCertificateOracle(globalDecoyQuery, context)).toThrow();

    const disjunctiveQuery = {
      ...canonicalQuery,
      sql: canonicalQuery.sql.replace(
        clauses.join(" AND "),
        `${clauses.slice(0, -2).join(" AND ")} AND (${clauses.at(-2)} OR ${clauses.at(-1)})`,
      ),
    };
    expect(() => assertCapturedClaimCertificateOracle(disjunctiveQuery, context)).toThrow();

    const duplicateEqualityQuery = {
      ...canonicalQuery,
      sql: canonicalQuery.sql.replace(
        clauses.join(" AND "),
        `${clauses.join(" AND ")} AND ${clauses[0]}`,
      ),
    };
    expect(() => assertCapturedClaimCertificateOracle(duplicateEqualityQuery, context)).toThrow();

    const duplicateAntiJoinQuery = {
      ...canonicalQuery,
      sql: canonicalQuery.sql.replace(
        "FOR UPDATE",
        `AND NOT EXISTS (SELECT 1 FROM worker_lease_rejections WHERE ${clauses.join(" AND ")}) FOR UPDATE`,
      ),
    };
    expect(() => assertCapturedClaimCertificateOracle(duplicateAntiJoinQuery, context)).toThrow();

    const reassociatedEqualityQuery = {
      ...canonicalQuery,
      sql: canonicalQuery.sql.replace(
        "worker_lease_rejections.organization_id = job_attempts.organization_id",
        "worker_lease_rejections.organization_id = jobs.organization_id",
      ),
    };
    expect(() => assertCapturedClaimCertificateOracle(reassociatedEqualityQuery, context)).toThrow();
    for (const clause of clauses) {
      const withoutClause = canonicalQuery.sql.includes(`${clause} AND `)
        ? canonicalQuery.sql.replace(`${clause} AND `, "")
        : canonicalQuery.sql.replace(` AND ${clause}`, "");
      expect(
        () => assertCapturedClaimCertificateOracle({
          ...canonicalQuery,
          sql: withoutClause,
        }, context),
        `removing ${clause} must invalidate the captured production query`,
      ).toThrow();
    }
    for (let index = 0; index < parameterClauses.length; index += 1) {
      const wrong = [...canonicalQuery.parameters];
      wrong[index] = `near-match-${index}`;
      expect(() => assertCapturedClaimCertificateOracle({ ...canonicalQuery, parameters: wrong }, context)).toThrow();
    }
  });

  it("pins exact reviewed index columns, directions, partial predicates, and primary key", () => {
    const valid = Object.entries(REVIEWED_INDEX_CONTRACT).map(([index_name, contract]) => ({
      index_name,
      valid: true,
      ready: true,
      columns: [...contract.columns],
      descending: [...contract.descending],
      predicate: contract.predicateTerms.length === 0 ? null : contract.predicateTerms.join(" AND "),
    }));
    expect(() => assertReviewedIndexContract(valid)).not.toThrow();
    for (const name of Object.keys(REVIEWED_INDEX_CONTRACT)) {
      expect(() => assertReviewedIndexContract(valid.filter((index) => index.index_name !== name))).toThrow();
    }
    expect(() => assertReviewedIndexContract(valid.map((index) => index.index_name === "jobs_claim_idx"
      ? { ...index, columns: [...index.columns].reverse() }
      : index))).toThrow();
    expect(() => assertReviewedIndexContract(valid.map((index) => index.index_name === "jobs_claim_idx"
      ? { ...index, descending: index.descending.map(() => false) }
      : index))).toThrow();
    expect(() => assertReviewedIndexContract(valid.map((index) => index.index_name === "job_attempts_lease_candidate_idx"
      ? { ...index, predicate: `${index.predicate} AND placement_lease_eligible=false` }
      : index))).toThrow();
  });
});

describe.skipIf(!enabled)("E3-PERF-01 production-capacity static-certificate lane", () => {
  it.each(E3_PERF_01_CLAIM_SCENARIOS)("records the real bounded claim plan and samples for %s", async (scenario) => {
    const client = database();
    await prepareE3Perf01ClaimScenario(client, scenario);
    const claimContext = await directClaimFixture(seedDatabase(), scenario);
    const expectedIds = await assertCanonicalClaimShape(client, scenario);
    expect.soft(expectedIds).toHaveLength(E3_PERF_01_EXPECTED_CLAIM_ROWS[scenario]);

    const first = await callProductionClaim(claimContext);
    expect.soft(first.rows.map((row) => row.attempt.id), scenario).toEqual(expectedIds);
    const plan = await client.begin(async (tx) => {
      const query = tx as unknown as Sql;
      await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
      return explainJson(query, first.query.sql, first.query.parameters);
    });
    const planSummary = assertHotPlan(plan, scenario);
    for (let index = 0; index < E3_PERF_01_DATASET.warmups; index += 1) {
      const warmup = await callProductionClaim(claimContext);
      expect.soft(warmup.querySha256).toBe(first.querySha256);
      expect.soft(warmup.rows.map((row) => row.attempt.id)).toEqual(expectedIds);
    }
    const samples: number[] = [];
    for (let index = 0; index < E3_PERF_01_DATASET.claimSamples; index += 1) {
      const start = performance.now();
      const sample = await callProductionClaim(claimContext);
      samples.push(performance.now() - start);
      expect.soft(sample.querySha256).toBe(first.querySha256);
      expect.soft(sample.rows.map((row) => row.attempt.id)).toEqual(expectedIds);
      expect(sample.rows.length).toBeLessThanOrEqual(256);
    }
    emitEvidence({
      kind: "claim_scenario",
      scenario,
      querySha256: first.querySha256,
      actualAttemptIds: expectedIds,
      samples,
      p95Ms: percentile(samples, 0.95),
      maxMs: Math.max(...samples),
      plan,
      planSummary,
    });
  }, 30 * 60_000);

  it("attests the complete current certificate tuple against the seeded candidates before the production claim", async () => {
    const client = database();
    const scenario = "hot_worker_head_saturated_999744_prefix" as const;
    await prepareE3Perf01ClaimScenario(client, scenario);
    const context = await directClaimFixture(seedDatabase(), scenario);
    const [tuple] = await client<{ exact_current_rows: number; unmatched_rows: number }[]>`
      SELECT
        count(*) FILTER (WHERE rejection.organization_id = attempt.organization_id
          AND rejection.company_id = attempt.company_id AND rejection.job_id = attempt.job_id
          AND rejection.attempt_id = attempt.id AND rejection.worker_id = ${context.workerId}
          AND rejection.target_id = attempt.placement_target_id
          AND rejection.target_authority_key = ${context.targetAuthorityKey}
          AND rejection.workload_type = job.workload_type
          AND rejection.placement_owner = attempt.placement_owner
          AND rejection.placement_target_class = attempt.placement_target_class
          AND rejection.placement_target_scope = attempt.placement_target_scope
          AND rejection.placement_target_generation = attempt.placement_target_generation
          AND rejection.placement_profile_hash = attempt.placement_profile_hash
          AND rejection.placement_provider_constraint_hash = attempt.placement_provider_constraint_hash
          AND rejection.placement_input_digest = attempt.placement_input_digest
          AND rejection.placement_policy_digest = attempt.placement_policy_digest
          AND rejection.eligibility_version = ${context.eligibilityVersion}
          AND rejection.static_context_hash = ${context.staticContextHash})::int AS exact_current_rows,
        count(*) FILTER (WHERE rejection.attempt_id IS NULL)::int AS unmatched_rows
      FROM jobs AS job
      JOIN job_attempts AS attempt ON attempt.organization_id = job.organization_id
        AND attempt.company_id = job.company_id AND attempt.job_id = job.id
      LEFT JOIN worker_lease_rejections AS rejection
        ON rejection.organization_id = attempt.organization_id
        AND rejection.company_id = attempt.company_id AND rejection.job_id = attempt.job_id
        AND rejection.attempt_id = attempt.id AND rejection.worker_id = ${context.workerId}
      WHERE job.source_kind = 'e3_perf_01'`;
    expect.soft(tuple).toEqual({ exact_current_rows: 999_744, unmatched_rows: 256 });
    const expectedIds = await assertCanonicalClaimShape(client, scenario);
    const result = await callProductionClaim(context);
    expect.soft(result.rows.map((candidate) => candidate.attempt.id)).toEqual(expectedIds);
  }, 30 * 60_000);

  it("records 20 exact 256-row bulk-certificate upserts without changing authority rows", async () => {
    const client = database();
    const authorityClient = seedDatabase();
    await prepareE3Perf01ClaimScenario(client, "hot_worker_head_saturated_999744_prefix");
    const certificates = await client<Array<Record<string, unknown>>>`
      SELECT organization_id AS "organizationId", company_id AS "companyId", job_id AS "jobId",
        attempt_id AS "attemptId", worker_id AS "workerId", target_id AS "targetId",
        target_authority_key AS "targetAuthorityKey", eligibility_version AS "eligibilityVersion",
        static_context_hash AS "staticContextHash", workload_type AS "workloadType",
        placement_owner AS "placementOwner", placement_target_class AS "placementTargetClass",
        placement_target_scope AS "placementTargetScope",
        placement_target_generation AS "placementTargetGeneration",
        placement_profile_hash AS "placementProfileHash",
        placement_provider_constraint_hash AS "placementProviderConstraintHash",
        placement_input_digest AS "placementInputDigest",
        placement_policy_digest AS "placementPolicyDigest", reason_code AS "reasonCode"
      FROM worker_lease_rejections
      ORDER BY updated_at, worker_id, attempt_id LIMIT ${E3_PERF_01_DATASET.batchSize}`;
    expect.soft(certificates).toHaveLength(E3_PERF_01_DATASET.batchSize);
    const [authorityBefore] = await authorityClient<{ digest: string }[]>`
      SELECT md5(jsonb_build_object(
        'targets', (SELECT jsonb_agg(jsonb_build_array(id, status, device_generation,
          registered_profile_hash, provider_constraint_profile) ORDER BY id) FROM execution_targets),
        'workers', (SELECT jsonb_agg(jsonb_build_array(id, status, device_generation,
          profile_hash, revoked_at) ORDER BY id) FROM workers)
      )::text) AS digest`;
    const samples: number[] = [];
    const queryFingerprints = new Set<string>();
    // These statement triggers live outside the transaction deliberately: an
    // unauthorized job/attempt/lease/worker/target (including liveness) write
    // fails before the test's rollback can erase evidence of the violation.
    await installCertificateOnlyMutationGuards(authorityClient);
    try {
      for (let index = 0; index < E3_PERF_01_DATASET.mutationSamples; index += 1) {
        const start = performance.now();
        capturedQueries.length = 0;
        let affected = 0;
        const rollback = new Error("E3_PERF_01_ROLLBACK_BULK_UPSERT");
        await expect(runInTenant(tenantDatabase() as never, E3_PERF_01_ORGANIZATION_ID, async (repos) => {
          const operation = (repos.jobControl as unknown as {
            upsertLeaseRejectionCertificates(input: { certificates: unknown[] }): Promise<number>;
          }).upsertLeaseRejectionCertificates;
          expect.soft(typeof operation).toBe("function");
          if (typeof operation !== "function") throw new Error("production certificate upsert is missing");
          affected = await operation({ certificates });
          throw rollback;
        })).rejects.toBe(rollback);
        samples.push(performance.now() - start);
        expect(affected).toBe(E3_PERF_01_DATASET.batchSize);
        const query = [...capturedQueries].reverse().find((entry) => /worker_lease_rejections/i.test(entry.sql));
        expect.soft(query).toBeDefined();
        if (query) queryFingerprints.add(normalizedQuerySha256(query.sql));
      }
    } finally {
      await dropCertificateOnlyMutationGuards(authorityClient);
    }
    const [authorityAfter] = await authorityClient<{ digest: string }[]>`
      SELECT md5(jsonb_build_object(
        'targets', (SELECT jsonb_agg(jsonb_build_array(id, status, device_generation,
          registered_profile_hash, provider_constraint_profile) ORDER BY id) FROM execution_targets),
        'workers', (SELECT jsonb_agg(jsonb_build_array(id, status, device_generation,
          profile_hash, revoked_at) ORDER BY id) FROM workers)
      )::text) AS digest`;
    expect.soft(authorityAfter?.digest).toBe(authorityBefore?.digest);
    expect.soft([...queryFingerprints]).toHaveLength(1);
    emitEvidence({
      kind: "bulk_upsert",
      querySha256: [...queryFingerprints][0],
      affectedPerSample: Array(E3_PERF_01_DATASET.mutationSamples).fill(256),
      samples,
      p95Ms: percentile(samples, 0.95),
    });
  }, 10 * 60_000);

  it.each(["sparse", "tail"] as const)("records 20 bounded 256-row %s cleanup samples", async (layout) => {
    const client = database();
    const authorityClient = seedDatabase();
    await prepareAndAssertCleanupLayout(client, layout);
    const [before] = await client<{ total_rows: number; eligible_rows: number; retained_rows: number }[]>`
      SELECT count(*)::int AS total_rows,
        count(*) FILTER (WHERE job.status = 'succeeded')::int AS eligible_rows,
        count(*) FILTER (WHERE job.status <> 'succeeded')::int AS retained_rows
      FROM worker_lease_rejections AS rejection
      JOIN jobs AS job ON job.organization_id = rejection.organization_id
        AND job.company_id = rejection.company_id AND job.id = rejection.job_id
      WHERE job.source_kind = 'e3_perf_01'`;
    expect.soft(before).toEqual({ total_rows: 1_000_000, eligible_rows: 250_000, retained_rows: 750_000 });
    const samples: number[] = [];
    const queryFingerprints = new Set<string>();
    let measuredQuery: { sql: string; parameters: unknown[] } | undefined;
    try {
      await installCertificateOnlyMutationGuards(authorityClient);
      await assertCertificateOnlyMutationGuardsRejectTenantWrites(client);
      for (let index = 0; index < E3_PERF_01_DATASET.mutationSamples; index += 1) {
        const start = performance.now();
        capturedQueries.length = 0;
        let affected = 0;
        const rollback = new Error(`E3_PERF_01_ROLLBACK_CLEANUP_${layout}`);
        await expect(runInTenant(tenantDatabase() as never, E3_PERF_01_ORGANIZATION_ID, async (repos) => {
          const operation = (repos.jobControl as unknown as {
            cleanupLeaseRejectionCertificates(input: { limit: number }): Promise<number>;
          }).cleanupLeaseRejectionCertificates;
          expect.soft(typeof operation).toBe("function");
          if (typeof operation !== "function") throw new Error("production certificate cleanup is missing");
          affected = await operation({ limit: E3_PERF_01_DATASET.batchSize });
          throw rollback;
        })).rejects.toBe(rollback);
        samples.push(performance.now() - start);
        expect(affected).toBe(E3_PERF_01_DATASET.batchSize);
        const query = [...capturedQueries].reverse().find((entry) =>
          /worker_lease_rejections/i.test(entry.sql) && /FOR\s+UPDATE|SKIP\s+LOCKED/i.test(entry.sql));
        expect.soft(query).toBeDefined();
        if (query) {
          measuredQuery ??= query;
          queryFingerprints.add(normalizedQuerySha256(query.sql));
        }
      }
    } finally {
      await dropCertificateOnlyMutationGuards(authorityClient);
    }
    expect.soft([...queryFingerprints]).toHaveLength(1);
    expect.soft(measuredQuery).toBeDefined();
    let cleanupPlan: Record<string, unknown> | undefined;
    if (measuredQuery) {
      const rollback = new Error(`E3_PERF_01_ROLLBACK_CLEANUP_EXPLAIN_${layout}`);
      await expect(client.begin(async (tx) => {
        const query = tx as unknown as Sql;
        await query`SELECT set_config('aoa.organization_id', ${E3_PERF_01_ORGANIZATION_ID}, true)`;
        cleanupPlan = await explainJson(query, measuredQuery!.sql, measuredQuery!.parameters);
        throw rollback;
      })).rejects.toBe(rollback);
    }
    const planSummary = cleanupPlan ? assertCleanupPlan(cleanupPlan, layout, 256) : undefined;
    const [after] = await client<{ total_rows: number; eligible_rows: number; retained_rows: number }[]>`
      SELECT count(*)::int AS total_rows,
        count(*) FILTER (WHERE job.status = 'succeeded')::int AS eligible_rows,
        count(*) FILTER (WHERE job.status <> 'succeeded')::int AS retained_rows
      FROM worker_lease_rejections AS rejection
      JOIN jobs AS job ON job.organization_id = rejection.organization_id
        AND job.company_id = rejection.company_id AND job.id = rejection.job_id
      WHERE job.source_kind = 'e3_perf_01'`;
    expect.soft(after).toEqual(before);
    emitEvidence({
      kind: "cleanup",
      layout,
      querySha256: [...queryFingerprints][0],
      affectedPerSample: Array(E3_PERF_01_DATASET.mutationSamples).fill(256),
      samples,
      p95Ms: percentile(samples, 0.95),
      plan: cleanupPlan,
      planSummary,
    });
  }, 10 * 60_000);

  it("keeps exact corpus size and combined table plus index bytes inside the blocking bound", async () => {
    const client = database();
    await prepareE3Perf01ClaimScenario(client, "hot_worker_fully_certified_no_work");
    const [sizes] = await client<{
      candidate_rows: number;
      certificate_rows: number;
      joined_job_rows: number;
      relation_bytes: number;
      table_bytes: number;
      index_bytes: number;
      total_bytes: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM job_attempts WHERE status = 'pending') AS candidate_rows,
        (SELECT count(*)::int FROM worker_lease_rejections) AS certificate_rows,
        (SELECT count(*)::int FROM jobs j WHERE EXISTS (
          SELECT 1 FROM job_attempts ja WHERE ja.organization_id = j.organization_id
            AND ja.company_id = j.company_id AND ja.job_id = j.id AND ja.status = 'pending')) AS joined_job_rows,
        pg_relation_size('worker_lease_rejections')::bigint::float8 AS relation_bytes,
        pg_table_size('worker_lease_rejections')::bigint::float8 AS table_bytes,
        pg_indexes_size('worker_lease_rejections')::bigint::float8 AS index_bytes,
        pg_total_relation_size('worker_lease_rejections')::bigint::float8 AS total_bytes`;
    expect(sizes?.candidate_rows).toBe(E3_PERF_01_DATASET.candidateRows);
    expect(sizes?.certificate_rows).toBe(E3_PERF_01_DATASET.certificateRows);
    expect(Number(sizes?.joined_job_rows ?? 0)).toBeGreaterThan(0);
    expect(Number(sizes?.total_bytes ?? 0)).toBe(Number(sizes?.table_bytes ?? 0) + Number(sizes?.index_bytes ?? 0));
    expect(Number(sizes?.total_bytes ?? 0))
      .toBeLessThanOrEqual(E3_PERF_01_INITIAL_THRESHOLDS.combinedTableIndexBytesMax);

    const indexes = await client<(ReviewedIndexFact & { definition: string })[]>`
      SELECT index_rel.relname AS index_name, idx.indisvalid AS valid, idx.indisready AS ready,
        pg_get_indexdef(idx.indexrelid) AS definition,
        pg_get_expr(idx.indpred, idx.indrelid) AS predicate,
        ARRAY(
          SELECT att.attname
          FROM unnest(idx.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute AS att ON att.attrelid = idx.indrelid AND att.attnum = key.attnum
          ORDER BY key.position
        )::text[] AS columns,
        ARRAY(
          SELECT (idx.indoption[key.position::int - 1] & 1) = 1
          FROM unnest(idx.indkey) WITH ORDINALITY AS key(attnum, position)
          ORDER BY key.position
        )::boolean[] AS descending
      FROM pg_index idx
      JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
      WHERE index_rel.relname IN ('jobs_claim_idx', 'job_attempts_lease_candidate_idx',
        'worker_lease_rejections_pkey', 'worker_lease_rejections_cleanup_idx')
      ORDER BY index_rel.relname`;
    expect(() => assertReviewedIndexContract(indexes)).not.toThrow();
    emitEvidence({ kind: "storage", ...sizes, indexes });
  });
});
