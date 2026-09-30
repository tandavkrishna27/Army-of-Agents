/**
 * sandbox-coding-staging.ts — CLI-002/D4 + D5.
 *
 * The host-side staging orchestrator that sits ABOVE the CLI-001 E2B provider. For
 * a coding run it, IN ORDER:
 *   1. runs the per-adapter-TYPE disposition gate (D3) FIRST — an adapter outside the
 *      v1 sandboxed scope fails closed with an attributable reason BEFORE anything is
 *      staged or executed (never a silent host fallback);
 *   2. assembles the actor-gated `## Context` block (D2) — source + instructions +
 *      the RBAC-gated, fail-closed memory bundle;
 *   3. installs ONLY approved runtime inputs, rejecting unsupported files BEFORE
 *      execution with a `skipped[]`-with-reason gate (mirrors `run-input-bundles`);
 *   4. filters the run env through the U5 `buildSandboxEnvAllowlist` so DB creds, the
 *      secrets master key, the GitHub PAT, and `E2B_API_KEY` + host paths are ABSENT
 *      from the staged env;
 *   5. stages the context block + approved inputs into the sandbox via the
 *      provider-neutral `FileStagingTransport` seam (CLI-001/D1 `writeFiles`);
 *   6. records exact adapter/tool/context versions on a typed run record (D5).
 *
 * CAV-002: the staging seam is provider-neutral — `FileStagingTransport` carries no
 * organizationId/region/template/credential/E2B field; the real `E2bTransport` is
 * structurally assignable to it and injected by the caller.
 */

import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { buildSandboxEnvAllowlist } from "@armyofagents/adapter-utils";
import { gateCodingAdapterDispatch, type AdapterDisposition } from "./sandbox-coding-disposition.js";
import { buildActorGatedMemoryBundle } from "./sandbox-coding-memory-bundle.js";

/** Provider-neutral file-staging seam (CAV-002). The CLI-001 `E2bTransport` is
 * structurally assignable to this — no E2B/tenant field crosses it. */
export interface FileStagingTransport {
  writeFiles(sandboxId: string, files: readonly { path: string; bytes: Uint8Array }[]): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  listDir(sandboxId: string, path: string): Promise<readonly string[]>;
}

/** A declared runtime input (declared snapshot file / approved input). Its bytes are
 * resolved on the HOST before staging (DAT-001 declared manifest; no live in-VM pull). */
export interface DeclaredInput {
  readonly id: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType?: string | null;
  /** Marks a file the founder has NOT approved for this run — always skipped. */
  readonly approved?: boolean;
}

export interface StagedRunRecord {
  readonly adapterType: string;
  readonly adapterDisposition: AdapterDisposition["bucket"];
  readonly adapterProvider: string | null;
  /** The resolved CLI tool version (e.g. "claude 2.1.x") — audit/reproducibility. */
  readonly toolVersion: string | null;
  /** The per-agent context mode (minimal/standard/full). */
  readonly contextMode: string | null;
  /** sha256 of the staged `## Context` block — the context version digest. */
  readonly contextDigest: string;
  readonly memoryItemCount: number;
  readonly memoryActorResolved: boolean;
  readonly stagedFileCount: number;
  readonly skippedInputCount: number;
  readonly stagedAt: string;
}

export interface StageCodingRunArgs {
  readonly db: Db;
  readonly companyId: string;
  readonly agentId: string;
  readonly adapterType: string;
  readonly deploymentMode: string;
  /** The resolved U5 provider for env filtering (e.g. "anthropic"/"openai"). */
  readonly provider: string;
  readonly transport: FileStagingTransport;
  readonly sandboxId: string;
  /** The task/thread source the agent must see. */
  readonly source?: string;
  /** The agent instructions the agent must see. */
  readonly instructions?: string;
  /** Optional scope narrowing for the memory bundle. */
  readonly memoryFilters?: { departmentId?: string; projectId?: string; goalId?: string };
  readonly memoryLimit?: number;
  /** Declared snapshot + approved inputs (bytes resolved on the host). */
  readonly declaredInputs?: readonly DeclaredInput[];
  /** The caller-built env overlay (may carry secrets/host paths — U5 filters them). */
  readonly envOverlay?: Record<string, string>;
  readonly toolVersion?: string | null;
  readonly contextMode?: string | null;
  /** Absolute in-sandbox dir the `## Context` block is written to. */
  readonly contextDir?: string;
}

export interface StageCodingRunResult {
  readonly admitted: boolean;
  readonly disposition: AdapterDisposition;
  /** Present iff `admitted === false` — the attributable fail-closed reason. */
  readonly rejectionReason?: string;
  /** Absolute in-sandbox paths actually staged (empty when not admitted). */
  readonly stagedPaths: string[];
  /** Unsupported/unapproved inputs rejected BEFORE exec, with reasons. */
  readonly skipped: Array<{ id: string; type: string; reason: string }>;
  /** The U5-filtered env that would cross into the sandbox. */
  readonly stagedEnv: Record<string, string>;
  readonly record: StagedRunRecord;
}

const DEFAULT_CONTEXT_DIR = "/home/user/.aoa";
const CONTEXT_FILENAME = "context.md";

/** Supported staged-file extensions (source/text/config only). Everything else is
 * rejected before exec — the coding path stages source + declared context, never
 * opaque binaries. Mirrors `run-input-bundles`' skipped[]-with-reason precedent. */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "markdown", "txt", "text", "json", "jsonc", "yaml", "yml", "toml", "ini", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "php", "c", "h",
  "cc", "cpp", "hpp", "cs", "kt", "swift", "sh", "bash", "sql", "html", "css", "scss",
  "csv", "tsv", "xml", "proto", "gql", "graphql", "lock", "gitignore", "dockerfile",
]);

function extensionOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  if (base.startsWith(".") && !base.slice(1).includes(".")) return base.slice(1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isSupportedInput(input: DeclaredInput): boolean {
  const ct = (input.contentType ?? "").toLowerCase();
  if (ct.startsWith("text/") || ct === "application/json" || ct === "application/yaml") return true;
  if (ct.length > 0 && !ct.startsWith("text/") && !ct.includes("json") && !ct.includes("yaml") && !ct.includes("xml") && !ct.includes("toml")) {
    // A declared non-text content type (image/binary/octet-stream) is unsupported.
    return false;
  }
  return SUPPORTED_EXTENSIONS.has(extensionOf(input.path));
}

/** Compose the `## Context` block (source + instructions + actor-gated memory). */
function composeContextBlock(input: {
  source?: string;
  instructions?: string;
  memoryLines: string[];
}): string {
  const parts: string[] = ["## Context"];
  if (input.source && input.source.trim().length > 0) {
    parts.push(`### Source\n${input.source.trim()}`);
  }
  if (input.instructions && input.instructions.trim().length > 0) {
    parts.push(`### Instructions\n${input.instructions.trim()}`);
  }
  if (input.memoryLines.length > 0) {
    parts.push(`### Memory\n${input.memoryLines.join("\n")}`);
  }
  return parts.join("\n\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Host-workspace env keys that carry a HOST FILESYSTEM PATH (or embed one). They are
 * meaningless inside a sandbox (whose workspace is staged in-sandbox) and would violate
 * "host paths absent" — so the sandbox staging path strips them after the U5 allowlist. */
const HOST_WORKSPACE_PATH_KEYS: ReadonlySet<string> = new Set([
  "AOA_WORKSPACE_CWD",
  "AOA_WORKSPACE_SOURCE",
  "AOA_WORKSPACE_WORKTREE_PATH",
  "AOA_WORKSPACES_JSON",
  "AGENT_HOME",
]);

function stripHostWorkspacePaths(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!HOST_WORKSPACE_PATH_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Stage a coding run. Fail-closed by construction: an out-of-scope adapter returns
 * `admitted:false` with an attributable reason and stages NOTHING; only the v1 set
 * proceeds to stage context + approved inputs and record versions.
 */
export async function stageCodingRun(args: StageCodingRunArgs): Promise<StageCodingRunResult> {
  const gate = gateCodingAdapterDispatch(args.adapterType, args.deploymentMode);
  const stagedAt = new Date().toISOString();

  // U5 env allowlist — computed even on rejection so the record/telemetry can assert
  // secrets never crossed regardless of admission (it never injects, only filters).
  // U5 ADMITS the host-workspace-orchestration keys because its usual caller then pipes
  // the result through shapeAoaWorkspaceEnvForExecution (rewrite CWD / drop WORKTREE_PATH);
  // the sandbox path has no such rewrite step and stages the workspace bytes IN-sandbox,
  // so any host FILESYSTEM PATH here would be both meaningless and a "host paths absent"
  // (acceptance clause c) violation. Strip the path-bearing host-workspace keys.
  const stagedEnv = stripHostWorkspacePaths(
    buildSandboxEnvAllowlist(args.envOverlay ?? {}, { provider: args.provider }),
  );

  // ── Disposition gate FIRST (D3): fail closed BEFORE staging/exec ──────────
  if (!gate.admitted) {
    return {
      admitted: false,
      disposition: gate.disposition,
      rejectionReason: gate.rejectionReason,
      stagedPaths: [],
      skipped: [],
      stagedEnv,
      record: {
        adapterType: args.adapterType,
        adapterDisposition: gate.disposition.bucket,
        adapterProvider: gate.disposition.provider ?? null,
        toolVersion: args.toolVersion ?? null,
        contextMode: args.contextMode ?? null,
        contextDigest: sha256(""),
        memoryItemCount: 0,
        memoryActorResolved: false,
        stagedFileCount: 0,
        skippedInputCount: 0,
        stagedAt,
      },
    };
  }

  // ── Actor-gated memory bundle (D2) ────────────────────────────────────────
  const memory = await buildActorGatedMemoryBundle(args.db, {
    companyId: args.companyId,
    agentId: args.agentId,
    filters: args.memoryFilters,
    limit: args.memoryLimit,
  });

  // ── Compose + digest the `## Context` block ───────────────────────────────
  const contextBlock = composeContextBlock({
    source: args.source,
    instructions: args.instructions,
    memoryLines: memory.lines,
  });
  const contextDir = args.contextDir ?? DEFAULT_CONTEXT_DIR;
  const contextPath = `${contextDir.replace(/\/$/, "")}/${CONTEXT_FILENAME}`;

  // ── Approved-inputs gate: reject unsupported BEFORE exec (D4) ──────────────
  const skipped: Array<{ id: string; type: string; reason: string }> = [];
  const toStage: Array<{ path: string; bytes: Uint8Array }> = [
    { path: contextPath, bytes: new TextEncoder().encode(contextBlock) },
  ];
  for (const input of args.declaredInputs ?? []) {
    if (input.approved === false) {
      skipped.push({ id: input.id, type: "declared_input", reason: "not_approved" });
      continue;
    }
    if (!isSupportedInput(input)) {
      skipped.push({ id: input.id, type: "declared_input", reason: "unsupported_type" });
      continue;
    }
    toStage.push({ path: input.path, bytes: input.bytes });
  }

  // ── Stage into the sandbox (D1 writeFiles) ────────────────────────────────
  await args.transport.writeFiles(args.sandboxId, toStage);

  return {
    admitted: true,
    disposition: gate.disposition,
    stagedPaths: toStage.map((f) => f.path),
    skipped,
    stagedEnv,
    record: {
      adapterType: args.adapterType,
      adapterDisposition: gate.disposition.bucket,
      adapterProvider: gate.disposition.provider ?? null,
      toolVersion: args.toolVersion ?? null,
      contextMode: args.contextMode ?? null,
      contextDigest: sha256(contextBlock),
      memoryItemCount: memory.itemCount,
      memoryActorResolved: memory.actorResolved,
      stagedFileCount: toStage.length,
      skippedInputCount: skipped.length,
      stagedAt,
    },
  };
}
