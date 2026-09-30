import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills, agents as agentsTable } from "@armyofagents/db";
import {
  normalizeAgentUrlKey,
  SKILL_CUSTOMIZED_ERROR_CODE,
  SKILL_NAME_TAKEN_ERROR_CODE,
} from "@armyofagents/shared";
import type {
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillCompatibility,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillImportResult,
  CompanySkillRefusedImport,
  CompanySkillListItem,
  CompanySkillProjectScanConflict,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillProjectScanSkipped,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillUsageAgent,
} from "@armyofagents/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolveAoaInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { agentService } from "./agents.js";
import { executePinnedRequest, validateAndResolveFetchUrl } from "./outbound-url-guard.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";
import {
  isInsideManagedMarketplaceSkillsRoot,
  overlapsManagedMarketplaceSkillsRoot,
} from "./marketplace-install/managed-skills-root.js";

// ---------------------------------------------------------------------------
// RuntimeSkillEntry — replaces PaperclipSkillEntry from Paperclip
// ---------------------------------------------------------------------------

export interface RuntimeSkillEntry {
  key: string;
  name: string;
  markdown: string;
  trustLevel: string;
  description?: string;
  triggerPhrases?: string[];
  /** Ancillary files (non-SKILL.md) from local_path skills, injected alongside markdown. */
  files?: Array<{ path: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type CompanySkillRow = typeof companySkills.$inferSelect;

interface ImportedSkill {
  slug: string;
  key?: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
}

interface SkillSourceMeta {
  sourceKind: "github" | "skills_sh" | "paperclip_bundled" | "url" | "local" | "catalog" | "unknown";
  owner?: string | null;
  repo?: string | null;
  skillPath?: string | null;
  ref?: string | null;
  pinnedCommit?: string | null;
}

export interface ParsedSkillImportSource {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  originalSkillsShUrl: string | null;
  warnings: string[];
}

/**
 * T2.9 — what an overwrite of an already-installed skill row does when that row
 * carries founder edits (`company_skills.customized === true`).
 *
 * There is deliberately NO default. Every caller of {@link companySkillService}'s
 * upsert primitive has to state which one it is, so a new install path cannot
 * inherit "overwrite" by forgetting to think about it.
 */
export type CustomizedSkillWritePolicy =
  /**
   * The bytes on the other side are UPSTREAM's. Skip the row, leave the founder's
   * markdown exactly as it is, and report the skip back to the caller.
   */
  | "preserve_founder_edits"
  /**
   * The caller IS the authoring surface the founder is currently driving (they
   * are creating/replacing this skill right now), so there are no third-party
   * edits to protect. Overwrites unconditionally.
   */
  | "caller_is_authoritative";

export interface UpsertImportedSkillsResult {
  /** Rows actually written. Under `preserve_founder_edits` this excludes refusals. */
  skills: CompanySkill[];
  /** Rows skipped because they carry founder edits. Always `[]` under `caller_is_authoritative`. */
  refused: CompanySkillRefusedImport[];
}

export type LocalSkillInventoryMode = "full" | "skill_only" | "project_root";

export interface ProjectSkillScanTarget {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
}

export interface DiscoveredSkillDir {
  skillDir: string;
  inventoryMode: "full" | "project_root";
}

// ---------------------------------------------------------------------------
// PROJECT_SCAN_DIRECTORY_ROOTS — directories searched during project scan
// ---------------------------------------------------------------------------

const PROJECT_SCAN_DIRECTORY_ROOTS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".agent/skills",
  ".augment/skills",
  ".claude/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".cursor/skills",
  ".factory/skills",
  ".goose/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".aoa/skills",
  ".pi/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sanitizeMarkdown(text: string): string {
  // Replace known Unicode characters with ASCII equivalents
  let result = text
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/↔/g, "<->")
    .replace(/⇒/g, "=>")
    .replace(/⇐/g, "<=")
    .replace(/—/g, "--")
    .replace(/–/g, "-")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/…/g, "...")
    .replace(/⚠/g, "[!]")
    .replace(/✅/g, "[x]")
    .replace(/❌/g, "[ ]")
    .replace(/•/g, "-")
    .replace(/·/g, "-");
  // Strip any remaining non-ASCII characters that would fail WIN1252 encoding
  // Keep basic Latin, Latin-1 Supplement (0x00-0xFF), and common whitespace
  result = result.replace(/[^\x00-\xFF]/g, "");
  return result;
}

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePortablePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePackageFileMap(
  files: Array<Record<string, unknown>>,
): CompanySkillFileInventoryEntry[] {
  return files.map((f) => ({
    path: normalizePortablePath(String(f.path ?? "")),
    kind: classifyInventoryKind(String(f.path ?? "")),
  }));
}

function normalizeSkillSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const result = normalizeAgentUrlKey(raw) ?? (raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || null);
  return result;
}

export function normalizeSkillKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

function hashSkillValue(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function uniqueSkillSlug(base: string, used: Set<string>): string {
  const slug = normalizeSkillSlug(base) ?? base;
  if (!used.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

function uniqueImportedSkillKey(companyId: string, slug: string, used: Set<string>): string {
  const base = `company/${companyId}/${slug}`;
  const key = normalizeSkillKey(base) ?? base;
  if (!used.has(key)) return key;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${key}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${key}-${Date.now()}`;
}

function buildSkillRuntimeName(slug: string, name: string): string {
  return name || slug;
}

function resolveManagedSkillsRoot(companyId: string): string {
  return path.resolve(resolveAoaInstanceRoot(), "skills", companyId);
}

function normalizeSkillDirectory(skill: CompanySkill): string | null {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) {
    return null;
  }
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

function readCanonicalSkillKey(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const key = metadata.canonicalKey ?? metadata.canonical_key;
  return typeof key === "string" ? key : null;
}

function deriveCanonicalSkillKey(
  companyId: string,
  input: Pick<ImportedSkill, "slug" | "sourceType" | "sourceLocator" | "metadata">,
): string {
  const slug = normalizeSkillSlug(input.slug) ?? "skill";
  const metadata = isPlainRecord(input.metadata) ? input.metadata : null;

  const owner = normalizeSkillSlug(asString(metadata?.owner)) ?? null;
  const repo = normalizeSkillSlug(asString(metadata?.repo)) ?? null;
  if ((input.sourceType === "github" || input.sourceType === "skills_sh") && owner !== null && repo !== null) {
    return `${owner}/${repo}/${slug}`;
  }

  if (input.sourceType === "url") {
    const locator = asString(input.sourceLocator);
    if (locator) {
      try {
        const url = new URL(locator);
        const host = normalizeSkillSlug(url.host) ?? "url";
        return `url/${host}/${hashSkillValue(locator)}/${slug}`;
      } catch {
        return `url/unknown/${hashSkillValue(locator)}/${slug}`;
      }
    }
  }

  return `company/${companyId}/${slug}`;
}

function classifyInventoryKind(
  filePath: string,
): CompanySkillFileInventoryEntry["kind"] {
  const normalized = normalizePortablePath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);

  if (basename === "skill.md") return "skill";

  // Directory prefix checks take precedence over extension checks
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";

  if (normalized.endsWith(".md")) return "markdown";

  const ext = path.extname(normalized).toLowerCase();
  const scriptExts = [".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".py", ".rb", ".js", ".ts", ".mjs", ".cjs"];
  if (scriptExts.includes(ext)) return "script";

  const assetExts = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf"];
  if (assetExts.includes(ext)) return "asset";

  if (normalized.endsWith(".txt") || normalized.endsWith(".json") || normalized.endsWith(".yaml") || normalized.endsWith(".yml") || normalized.endsWith(".toml")) {
    return "reference";
  }

  return "other";
}

function deriveTrustLevel(
  fileInventory: CompanySkillFileInventoryEntry[],
): CompanySkillTrustLevel {
  const hasScripts = fileInventory.some((f) => f.kind === "script");
  const hasAssets = fileInventory.some((f) => f.kind === "asset");
  if (hasScripts) return "scripts_executables";
  if (hasAssets) return "assets";
  return "markdown_only";
}

// ---------------------------------------------------------------------------
// YAML frontmatter parsing
// ---------------------------------------------------------------------------

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) index += 1;
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0 &&
        !remainder.startsWith("\"") &&
        !remainder.startsWith("{") &&
        !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }
      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }
  return { value: record, nextIndex: index };
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function parseFrontmatterMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers (for GitHub / URL imports)
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string | null> {
  // SSRF guard runs OUTSIDE the try/catch so that private-IP / disallowed-
  // protocol / DNS-rebind violations propagate to the caller as a thrown
  // error instead of being silently masked by the existing null-on-failure
  // contract. Hiding "private IP blocked" behind a null return is a footgun.
  const target = await validateAndResolveFetchUrl(url);
  try {
    const response = await executePinnedRequest(
      target,
      // GitHub API requires a User-Agent header (returns 403 without one).
      // Node's https.request — unlike the built-in fetch() — does NOT add one
      // automatically, so we must set it explicitly on every outbound call.
      { headers: { "User-Agent": "ArmyOfAgents/1.0" } },
      AbortSignal.timeout(30_000),
      // Raise the body cap from the default 1 MiB to 10 MiB so that large
      // GitHub recursive-tree responses (repos with thousands of files) are
      // not silently truncated and returned as null.
      { maxBodyBytes: 10 * 1024 * 1024 },
    );
    if (response.status >= 400) return null;
    return response.body;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  const body = await fetchText(url);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Test-only handle to the module-private fetch helpers. Do not import from production code. */
export const __test__ = { fetchJson, fetchText };

// ---------------------------------------------------------------------------
// GitHub resolution helpers
// ---------------------------------------------------------------------------

async function resolveGitHubDefaultBranch(owner: string, repo: string): Promise<string> {
  const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`);
  if (isPlainRecord(data) && typeof data.default_branch === "string") {
    return data.default_branch;
  }
  return "main";
}

async function resolveGitHubCommitSha(
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`);
  if (isPlainRecord(data) && typeof data.sha === "string") {
    return data.sha;
  }
  return null;
}

function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
    explicitRef = true;
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    filePath = parts.slice(4).join("/");
    basePath = filePath ? path.posix.dirname(filePath) : "";
    explicitRef = true;
  }
  return { owner, repo, ref, basePath, filePath, explicitRef };
}

async function resolveGitHubPinnedRef(parsed: ReturnType<typeof parseGitHubSourceUrl>) {
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return {
      pinnedRef: parsed.ref,
      trackingRef: parsed.explicitRef ? parsed.ref : null,
    };
  }
  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef);
  return { pinnedRef, trackingRef };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

// ---------------------------------------------------------------------------
// Command token extraction
// ---------------------------------------------------------------------------

function extractCommandTokens(raw: string) {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

// ---------------------------------------------------------------------------
// Source input parsing
// ---------------------------------------------------------------------------

export function parseSkillImportSourceInput(rawInput: string): ParsedSkillImportSource {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw unprocessable("Skill source is required.");
  }

  const warnings: string[] = [];
  let source = trimmed;
  let requestedSkillSlug: string | null = null;

  // Handle "npx skills add <source> --skill <slug>" commands
  if (/^npx\s+skills\s+add\s+/i.test(trimmed)) {
    const tokens = extractCommandTokens(trimmed);
    const addIndex = tokens.findIndex(
      (token, index) =>
        token === "add"
        && index > 0
        && tokens[index - 1]?.toLowerCase() === "skills",
    );
    if (addIndex >= 0) {
      source = tokens[addIndex + 1] ?? "";
      for (let index = addIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--skill") {
          requestedSkillSlug = normalizeSkillSlug(tokens[index + 1] ?? null);
          index += 1;
          continue;
        }
        if (token.startsWith("--skill=")) {
          requestedSkillSlug = normalizeSkillSlug(token.slice("--skill=".length));
        }
      }
    }
  }

  const normalizedSource = source.trim();
  if (!normalizedSource) {
    throw unprocessable("Skill source is required.");
  }

  // Key-style imports (org/repo/skill) originate from the skills.sh registry
  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    const [owner, repo, skillSlugRaw] = normalizedSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      originalSkillsShUrl: `https://skills.sh/${owner}/${repo}/${skillSlugRaw}`,
      warnings,
    };
  }

  // GitHub shorthand: owner/repo
  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    return {
      resolvedSource: `https://github.com/${normalizedSource}`,
      requestedSkillSlug,
      originalSkillsShUrl: null,
      warnings,
    };
  }

  // Detect skills.sh URLs and resolve to GitHub
  const skillsShMatch = normalizedSource.match(/^https?:\/\/(?:www\.)?skills\.sh\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:[?#].*)?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: skillSlugRaw ? normalizeSkillSlug(skillSlugRaw) : requestedSkillSlug,
      originalSkillsShUrl: normalizedSource,
      warnings,
    };
  }

  return {
    resolvedSource: normalizedSource,
    requestedSkillSlug,
    originalSkillsShUrl: null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// GitHub skill directory normalization
// ---------------------------------------------------------------------------

export function normalizeGitHubSkillDirectory(
  value: string | null | undefined,
  fallback: string,
) {
  const normalized = normalizePortablePath(value ?? "");
  if (!normalized) return normalizePortablePath(fallback);
  const base = path.posix.basename(normalized).toLowerCase();
  if (base === "skill.md" || base === ".") {
    const parent = normalizePortablePath(path.posix.dirname(normalized));
    return parent === "." ? "" : parent;
  }
  return normalized;
}

function matchesRequestedSkill(relativeSkillPath: string, requestedSkillSlug: string | null) {
  if (!requestedSkillSlug) return true;
  const skillDir = path.posix.dirname(relativeSkillPath);
  return normalizeSkillSlug(path.posix.basename(skillDir)) === requestedSkillSlug;
}

function deriveImportedSkillSlug(frontmatter: Record<string, unknown>, fallback: string): string {
  return (normalizeSkillSlug(asString(frontmatter.slug))
    ?? normalizeSkillSlug(asString(frontmatter.name))
    ?? normalizeAgentUrlKey(fallback)
    ?? "skill") as string;
}

// ---------------------------------------------------------------------------
// Inline skill parsing from SKILL.md content
// ---------------------------------------------------------------------------

function readInlineSkillImports(
  skillMd: string,
  slug: string,
  name: string,
): ImportedSkill[] {
  const { frontmatter, body } = parseFrontmatterMarkdown(skillMd);
  const fmName = asString(frontmatter.name) ?? name;
  const fmDescription = asString(frontmatter.description) ?? null;

  return [
    {
      slug,
      name: fmName,
      description: fmDescription,
      markdown: skillMd,
      sourceType: "catalog",
      sourceLocator: null,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: Object.keys(frontmatter).length > 0 ? frontmatter : null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

async function walkLocalFiles(dir: string, base?: string): Promise<string[]> {
  const files: string[] = [];
  const baseDir = base ?? dir;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__pycache__") {
          continue;
        }
        const subFiles = await walkLocalFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath);
        files.push(normalizePortablePath(relativePath));
      }
    }
  } catch {
    // Directory not readable
  }
  return files;
}

async function statPath(p: string): Promise<"file" | "directory" | null> {
  try {
    const st = await fs.stat(p);
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates a file path key from an importPackageFiles file map.
 * Returns the normalized portable path (forward slashes, no leading slash).
 * Throws Error if the path would escape the given skillDir (path traversal).
 * Exported for unit testing.
 */
export function validatePackageFileKey(skillDir: string, relPath: string): string {
  const normalized = normalizePortablePath(relPath) || "SKILL.md";
  const resolved = path.resolve(skillDir, normalized);
  const relative = path.relative(path.resolve(skillDir), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid file path "${relPath}": path traversal not allowed`);
  }
  return normalized;
}

async function readAncillarySkillFiles(
  dir: string,
): Promise<Array<{ path: string; content: string }>> {
  const relativePaths = await walkLocalFiles(dir);
  const result: Array<{ path: string; content: string }> = [];
  for (const relPath of relativePaths) {
    if (relPath === "SKILL.md") continue;
    try {
      const content = await fs.readFile(path.join(dir, relPath), "utf8");
      result.push({ path: relPath, content });
    } catch {
      // Skip unreadable files (binary, permission denied, etc.)
    }
  }
  return result;
}

async function collectLocalSkillInventory(
  dir: string,
  mode: LocalSkillInventoryMode = "full",
): Promise<CompanySkillFileInventoryEntry[]> {
  if (mode === "skill_only") {
    const skillPath = path.join(dir, "SKILL.md");
    const exists = await statPath(skillPath);
    if (exists === "file") return [{ path: "SKILL.md", kind: "skill" }];
    return [];
  }

  const files = await walkLocalFiles(dir);

  if (mode === "project_root") {
    // Only include SKILL.md and files inside assets/, references/, scripts/
    return files
      .filter((f) => {
        const normalized = normalizePortablePath(f).toLowerCase();
        return (
          normalized === "skill.md"
          || normalized.startsWith("assets/")
          || normalized.startsWith("references/")
          || normalized.startsWith("scripts/")
        );
      })
      .map((f) => ({ path: f, kind: classifyInventoryKind(f) }));
  }

  return files.map((f) => ({
    path: f,
    kind: classifyInventoryKind(f),
  }));
}

export async function readLocalSkillImportFromDirectory(
  companyId: string,
  dir: string,
  options?: {
    inventoryMode?: LocalSkillInventoryMode;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ImportedSkill | null> {
  const resolvedDir = path.resolve(dir);
  const skillMdPath = path.join(resolvedDir, "SKILL.md");
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const { frontmatter } = parseFrontmatterMarkdown(content);
    const dirName = path.basename(resolvedDir);
    const slug = normalizeSkillSlug(asString(frontmatter.slug) ?? asString(frontmatter.name) ?? dirName) ?? dirName;
    const name = asString(frontmatter.name) ?? dirName;
    const description = asString(frontmatter.description) ?? null;

    const fileInventory = await collectLocalSkillInventory(resolvedDir, options?.inventoryMode ?? "full");
    const trustLevel = deriveTrustLevel(fileInventory);
    // Merge frontmatter.metadata (if an object) into root so nested YAML metadata keys are top-level
    const fmMeta = typeof frontmatter.metadata === "object" && frontmatter.metadata !== null && !Array.isArray(frontmatter.metadata)
      ? frontmatter.metadata as Record<string, unknown>
      : {};
    const metadata: Record<string, unknown> = {
      ...(Object.keys(frontmatter).length > 0 ? frontmatter : {}),
      ...fmMeta,
      sourceKind: "local_path",
      ...(options?.metadata ?? {}),
    };

    return {
      key: deriveCanonicalSkillKey(companyId, {
        slug,
        sourceType: "local_path",
        sourceLocator: resolvedDir,
        metadata,
      }),
      slug,
      name,
      description,
      markdown: content,
      sourceType: "local_path",
      sourceLocator: resolvedDir,
      sourceRef: null,
      trustLevel,
      compatibility: "compatible",
      fileInventory,
      metadata,
    };
  } catch {
    return null;
  }
}

async function readLocalSkillImports(companyId: string, localPath: string): Promise<ImportedSkill[]> {
  const pathType = await statPath(localPath);
  if (!pathType) return [];

  if (pathType === "file") {
    // Single SKILL.md file
    const dir = path.dirname(localPath);
    const skill = await readLocalSkillImportFromDirectory(companyId, dir);
    return skill ? [skill] : [];
  }

  // Directory — check if it directly contains SKILL.md
  const directSkill = await readLocalSkillImportFromDirectory(companyId, localPath);
  if (directSkill) return [directSkill];

  // Otherwise scan subdirectories for SKILL.md files
  const results: ImportedSkill[] = [];
  try {
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(localPath, entry.name);
        const skill = await readLocalSkillImportFromDirectory(companyId, subDir);
        if (skill) results.push(skill);
      }
    }
  } catch {
    // Not readable
  }
  return results;
}

// ---------------------------------------------------------------------------
// URL skill imports
// ---------------------------------------------------------------------------

async function readUrlSkillImports(
  companyId: string,
  sourceUrl: string,
  requestedSkillSlug: string | null = null,
): Promise<{ skills: ImportedSkill[]; warnings: string[] }> {
  const url = sourceUrl.trim();
  const warnings: string[] = [];

  if (url.includes("github.com/")) {
    const parsed = parseGitHubSourceUrl(url);
    const { pinnedRef, trackingRef } = await resolveGitHubPinnedRef(parsed);
    const ref = pinnedRef ?? trackingRef ?? "main";
    const tree = await fetchJson(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => {
      throw unprocessable(`Failed to read GitHub tree for ${url}`);
    }) as { tree?: Array<{ path: string; type: string }> } | null;
    const allPaths = (tree?.tree ?? [])
      .filter((entry: { path: string; type: string }) => entry.type === "blob")
      .map((entry: { path: string; type: string }) => entry.path)
      .filter((entry: string | null): entry is string => typeof entry === "string");
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const scopedPaths = basePrefix
      ? allPaths.filter((entry) => entry.startsWith(basePrefix))
      : allPaths;
    const relativePaths = scopedPaths.map((entry) => basePrefix ? entry.slice(basePrefix.length) : entry);
    const skillPaths = relativePaths.filter(
      (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
    );
    if (skillPaths.length === 0) {
      throw unprocessable(
        "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    const skills: ImportedSkill[] = [];
    for (const relativeSkillPath of skillPaths) {
      const repoSkillPath = basePrefix ? `${basePrefix}${relativeSkillPath}` : relativeSkillPath;
      const markdown = await fetchText(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoSkillPath)) ?? "";
      const parsedMarkdown = parseFrontmatterMarkdown(markdown);
      const skillDir = path.posix.dirname(relativeSkillPath);
      const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, path.posix.basename(skillDir));
      const skillKey = readCanonicalSkillKey(
        isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
      );
      if (requestedSkillSlug && !matchesRequestedSkill(relativeSkillPath, requestedSkillSlug) && slug !== requestedSkillSlug) {
        continue;
      }
      const metadata: Record<string, unknown> = {
        ...(skillKey ? { skillKey } : {}),
        sourceKind: "github",
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        trackingRef,
        repoSkillDir: normalizeGitHubSkillDirectory(
          basePrefix ? `${basePrefix}${skillDir}` : skillDir,
          slug ?? "skill",
        ),
      };
      const inventory = relativePaths
        .filter((entry) => entry === relativeSkillPath || entry.startsWith(`${skillDir}/`))
        .map((entry) => ({
          path: entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
          kind: classifyInventoryKind(entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1)),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      skills.push({
        key: deriveCanonicalSkillKey(companyId, {
          slug: slug ?? "skill",
          sourceType: "github",
          sourceLocator: sourceUrl,
          metadata,
        }),
        slug: slug ?? "skill",
        name: asString(parsedMarkdown.frontmatter.name) ?? slug ?? "skill",
        description: asString(parsedMarkdown.frontmatter.description) ?? null,
        markdown,
        sourceType: "github",
        sourceLocator: sourceUrl,
        sourceRef: ref,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      });
    }
    if (skills.length === 0) {
      throw unprocessable(
        requestedSkillSlug
          ? `Skill ${requestedSkillSlug} was not found in the provided GitHub source.`
          : "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    return { skills, warnings };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const markdown = await fetchText(url) ?? "";
    const parsedMarkdown = parseFrontmatterMarkdown(markdown);
    const urlObj = new URL(url);
    const fileName = path.posix.basename(urlObj.pathname);
    const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, fileName.replace(/\.md$/i, ""));
    const skillKey = readCanonicalSkillKey(
      isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
    );
    const metadata: Record<string, unknown> = {
      ...(skillKey ? { skillKey } : {}),
      sourceKind: "url",
    };
    const inventory: CompanySkillFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill" }];
    return {
      skills: [{
        key: deriveCanonicalSkillKey(companyId, {
          slug: slug ?? "skill",
          sourceType: "url",
          sourceLocator: url,
          metadata,
        }),
        slug: slug ?? "skill",
        name: asString(parsedMarkdown.frontmatter.name) ?? slug ?? "skill",
        description: asString(parsedMarkdown.frontmatter.description) ?? null,
        markdown,
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      }],
      warnings,
    };
  }

  throw unprocessable("Unsupported skill source. Use a local path or URL.");
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toCompanySkill(row: CompanySkillRow): CompanySkill {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    markdown: row.markdown,
    sourceType: row.sourceType as CompanySkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as CompanySkillTrustLevel,
    compatibility: row.compatibility as CompanySkillCompatibility,
    fileInventory: normalizePackageFileMap(
      Array.isArray(row.fileInventory) ? (row.fileInventory as Array<Record<string, unknown>>) : [],
    ),
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeFileInventory(
  inv: CompanySkillFileInventoryEntry[],
): Array<Record<string, unknown>> {
  return inv.map((entry) => ({ path: entry.path, kind: entry.kind }));
}

/**
 * T2.9 — refusal for an install/reinstall that would have overwritten founder
 * edits. Carries the same `SKILL_CUSTOMIZED` code as the catalog path
 * (`routes/marketplace-company.ts:383-387`).
 *
 * NOTE the wire shapes are not identical by construction: `HttpError` nests
 * whatever it is given under `details`, whereas the catalog route hand-builds a
 * top-level `code`. The install-update route therefore emits BOTH — it answers
 * directly instead of rethrowing — so one client check works on either surface.
 * Any future route that just rethrows this error will produce the nested form
 * only.
 */
function skillCustomizedConflict(skill: Pick<CompanySkill, "id" | "name">) {
  return conflict(
    `"${skill.name}" has local edits. Installing this update would discard them — ` +
    "delete the skill and re-import it if you want the upstream version.",
    { code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: skill.id },
  );
}

function skillNameTakenConflict(slug: string, key: string) {
  return conflict(
    `A skill named "${slug}" already exists. Choose a different name or slug.`,
    { code: SKILL_NAME_TAKEN_ERROR_CODE, slug, key },
  );
}

function isCompanySkillKeyCollision(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    if (record.code === "23505") {
      const constraint = record.constraint_name ?? record.constraint;
      return constraint === undefined || constraint === "company_skills_company_key_idx";
    }
    current = record.cause;
  }
  return false;
}

function refusedCustomizedEntry(
  skill: Pick<CompanySkill, "id" | "key" | "slug" | "name">,
): CompanySkillRefusedImport {
  return { skillId: skill.id, key: skill.key, slug: skill.slug, name: skill.name, reason: "customized" };
}

function getSkillMeta(skill: CompanySkill): SkillSourceMeta {
  const meta = skill.metadata;

  if (meta && asString(meta.sourceKind)) {
    return {
      sourceKind: asString(meta.sourceKind) as SkillSourceMeta["sourceKind"],
      owner: asString(meta.owner),
      repo: asString(meta.repo),
      skillPath: asString(meta.skillPath),
      ref: asString(meta.ref),
      pinnedCommit: asString(meta.pinnedCommit),
    };
  }

  if (skill.sourceType === "github" && skill.sourceLocator) {
    try {
      const parsed = parseGitHubSourceUrl(skill.sourceLocator);
      return {
        sourceKind: "github",
        owner: parsed.owner,
        repo: parsed.repo,
        skillPath: parsed.basePath || null,
        ref: parsed.ref,
        pinnedCommit: null,
      };
    } catch {
      // Invalid GitHub URL
    }
  }

  if (skill.sourceType === "url") return { sourceKind: "url" };
  if (skill.sourceType === "local_path") return { sourceKind: "local" };
  if (skill.sourceType === "catalog") return { sourceKind: "catalog" };

  return { sourceKind: "unknown" };
}

// ---------------------------------------------------------------------------
// Skill reference resolution (for update/install workflows)
// ---------------------------------------------------------------------------

async function resolveSkillReference(
  skill: CompanySkill,
): Promise<{
  latestRef: string | null;
  latestContent: string | null;
  latestInventory: CompanySkillFileInventoryEntry[];
} | null> {
  const meta = getSkillMeta(skill);

  if (meta.sourceKind === "github" || skill.sourceType === "github") {
    const owner = meta.owner ?? null;
    const repo = meta.repo ?? null;
    if (!owner || !repo) return null;

    const trackingRef = meta.ref ?? "main";
    const latestCommit = await resolveGitHubCommitSha(owner!, repo!, trackingRef);
    if (!latestCommit) return null;
    const skillPath = meta.skillPath ?? "";
    const skillMdPath = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
    const rawUrl = resolveRawGitHubUrl(owner!, repo!, latestCommit, skillMdPath);
    const latestContent = await fetchText(rawUrl);
    if (!latestContent) return null;

    return {
      latestRef: latestCommit,
      latestContent,
      latestInventory: [{ path: "SKILL.md", kind: "skill" as const }],
    };
  }

  if (skill.sourceType === "url" && skill.sourceLocator) {
    const content = await fetchText(skill.sourceLocator);
    if (!content) return null;
    return {
      latestRef: hashSkillValue(content),
      latestContent: content,
      latestInventory: [{ path: "SKILL.md", kind: "skill" }],
    };
  }

  if (skill.sourceType === "local_path" && skill.sourceLocator) {
    try {
      const content = await fs.readFile(path.join(skill.sourceLocator, "SKILL.md"), "utf8");
      const inventory = await collectLocalSkillInventory(skill.sourceLocator);
      return {
        latestRef: hashSkillValue(content),
        latestContent: content,
        latestInventory: inventory,
      };
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Project workspace skill discovery
// ---------------------------------------------------------------------------

export async function discoverProjectWorkspaceSkillDirectories(
  target: Pick<ProjectSkillScanTarget, "workspaceCwd">,
): Promise<DiscoveredSkillDir[]> {
  const { workspaceCwd } = target;
  const results: DiscoveredSkillDir[] = [];
  const seen = new Set<string>();

  function addResult(dir: string, inventoryMode: "full" | "project_root") {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    results.push({ skillDir: resolved, inventoryMode });
  }

  // Check workspace root itself
  const rootSkillMd = path.join(workspaceCwd, "SKILL.md");
  if ((await statPath(rootSkillMd)) === "file") {
    addResult(workspaceCwd, "project_root");
  }

  for (const root of PROJECT_SCAN_DIRECTORY_ROOTS) {
    const rootPath = path.join(workspaceCwd, root);
    const rootType = await statPath(rootPath);
    if (rootType !== "directory") continue;

    // Check if this directory itself is a skill
    const skillMdPath = path.join(rootPath, "SKILL.md");
    if ((await statPath(skillMdPath)) === "file") {
      addResult(rootPath, "full");
      continue;
    }

    // Scan subdirectories
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subSkillMd = path.join(rootPath, entry.name, "SKILL.md");
          if ((await statPath(subSkillMd)) === "file") {
            addResult(path.join(rootPath, entry.name), "full");
          }
        }
      }
    } catch {
      // Not readable
    }
  }

  return results.sort((a, b) => a.skillDir.localeCompare(b.skillDir));
}

// ---------------------------------------------------------------------------
// Skill reference resolution (Paperclip-style: ref → CompanySkill)
// ---------------------------------------------------------------------------

/**
 * Resolves a string reference (id / canonical key / slug) to a CompanySkill
 * from an in-memory list. Returns { skill, ambiguous } so callers can
 * distinguish "not found" from "multiple skills share this slug".
 * Mirrors Paperclip's resolveSkillReference exactly.
 */
export function resolveSkillReferenceByIdentifier(
  skills: CompanySkill[],
  reference: string,
): { skill: CompanySkill | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) return { skill: null, ambiguous: false };

  // Exact id match
  const byId = skills.find((s) => s.id === trimmed);
  if (byId) return { skill: byId, ambiguous: false };

  // Exact key match — catalog skills store their raw catalog ID as the key
  // (e.g. "skill:github-skills/obra/superpowers/brainstorming"), which may
  // contain colons that normalizeSkillKey strips. Always try the exact key
  // before attempting normalization so catalog skill refs round-trip correctly.
  const byKeyExact = skills.find((s) => s.key === trimmed);
  if (byKeyExact) return { skill: byKeyExact, ambiguous: false };

  // Normalized key match (normalizes each path segment independently)
  const normalizedKey = normalizeSkillKey(trimmed);
  if (normalizedKey) {
    const byKey = skills.find((s) => s.key === normalizedKey);
    if (byKey) return { skill: byKey, ambiguous: false };
  }

  // Slug match — detect ambiguity when multiple skills share the same slug
  const normalizedSlug = normalizeSkillSlug(trimmed);
  if (!normalizedSlug) return { skill: null, ambiguous: false };

  const bySlug = skills.filter((s) => s.slug === normalizedSlug);
  if (bySlug.length === 1) return { skill: bySlug[0]!, ambiguous: false };
  if (bySlug.length > 1) return { skill: null, ambiguous: true };

  return { skill: null, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Missing local skill reconciliation
// ---------------------------------------------------------------------------

export async function findMissingLocalSkillIds(
  skills: Array<{ id: string; sourceType: string; sourceLocator: string | null }>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const skill of skills) {
    if (skill.sourceType !== "local_path" || !skill.sourceLocator) continue;
    const dirStat = await statPath(skill.sourceLocator);
    const skillMdStat = await statPath(path.join(skill.sourceLocator, "SKILL.md"));
    if (dirStat !== "directory" || skillMdStat !== "file") {
      missing.push(skill.id);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

// Deduplicates concurrent inventory-refresh calls per company
const skillInventoryRefreshPromises = new Map<string, Promise<void>>();

/**
 * Serializes concurrent importPackageFiles calls per companyId+slug to prevent
 * interleaved disk writes and DB upsert races.
 */
const skillPackageImportQueue = new Map<string, Promise<unknown>>();

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const projects = projectService(db);
  const secrets = secretService(db);

  // -----------------------------------------------------------------------
  // Inventory health: prune stale local_path skills, then cache promise
  // -----------------------------------------------------------------------

  async function pruneMissingLocalPathSkills(companyId: string) {
    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const skills = rows.map((row) => toCompanySkill(row));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));
    if (missingIds.size === 0) return;

    for (const skill of skills) {
      if (!missingIds.has(skill.id)) continue;
      // Remove from any agent that references this skill key
      const agentRows = await agents.list(companyId);
      for (const agent of agentRows as any[]) {
        const skillKeys: string[] = Array.isArray(agent.skillKeys) ? agent.skillKeys : [];
        if (skillKeys.includes(skill.key)) {
          await agents.update(agent.id, { skillKeys: skillKeys.filter((k: string) => k !== skill.key) } as any);
        }
      }
      await db.delete(companySkills).where(eq(companySkills.id, skill.id));
    }
  }

  async function ensureSkillInventoryCurrent(companyId: string) {
    const existing = skillInventoryRefreshPromises.get(companyId);
    if (existing) {
      await existing;
      return;
    }
    const refreshPromise = pruneMissingLocalPathSkills(companyId);
    skillInventoryRefreshPromises.set(companyId, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (skillInventoryRefreshPromises.get(companyId) === refreshPromise) {
        skillInventoryRefreshPromises.delete(companyId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Core DB queries
  // -----------------------------------------------------------------------

  /**
   * Raw rows, not `CompanySkill`. `toCompanySkill` deliberately does not carry
   * `customized` (it is provenance bookkeeping, not part of the public skill
   * shape), so the T2.9 guard reads the flag from the row instead of widening
   * the shared type.
   */
  async function listFullRows(companyId: string): Promise<CompanySkillRow[]> {
    await ensureSkillInventoryCurrent(companyId);
    return db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name));
  }

  async function listFull(companyId: string): Promise<CompanySkill[]> {
    return (await listFullRows(companyId)).map(toCompanySkill);
  }

  async function listFullWithCustomization(
    companyId: string,
  ): Promise<Array<CompanySkill & { customized: boolean }>> {
    return (await listFullRows(companyId)).map((row) => ({
      ...toCompanySkill(row),
      customized: row.customized === true,
    }));
  }

  /** See {@link listFullRows} — raw row, used where `customized` matters. */
  async function getRowById(id: string): Promise<CompanySkillRow | null> {
    return db
      .select()
      .from(companySkills)
      .where(eq(companySkills.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getById(id: string): Promise<CompanySkill | null> {
    const row = await getRowById(id);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(companyId: string, key: string): Promise<CompanySkill | null> {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  // -----------------------------------------------------------------------
  // List items (with agent count)
  // -----------------------------------------------------------------------

  async function list(companyId: string): Promise<CompanySkillListItem[]> {
    const rows = await listFull(companyId);
    const agentRows = await agents.list(companyId);
    return rows.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent: any) => {
        const skillKeys: string[] = Array.isArray(agent.skillKeys) ? agent.skillKeys : [];
        return skillKeys.includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    });
  }

  // -----------------------------------------------------------------------
  // Detail + usage
  // -----------------------------------------------------------------------

  async function usage(companyId: string, key: string): Promise<CompanySkillUsageAgent[]> {
    const agentRows = await agents.list(companyId);
    const desiredAgents = agentRows.filter((agent: any) => {
      const skillKeys: string[] = Array.isArray(agent.skillKeys) ? agent.skillKeys : [];
      return skillKeys.includes(key);
    });

    return Promise.all(
      desiredAgents.map(async (agent: any) => {
        const adapterType = agent.adapterType ?? "process";
        const adapter = findActiveServerAdapter(adapterType);
        let actualState: string | null = null;

        if (!adapter?.listSkills) {
          actualState = "unsupported";
        } else {
          try {
            const runtimeConfig = await secrets.resolveAdapterConfigForRuntime(
              agent.companyId,
              adapterType,
              (agent.adapterConfig ?? {}) as Record<string, unknown>,
              {
                consumerType: "agent",
                consumerId: agent.id,
                actorType: "system",
                actorId: "company-skills",
              },
            );
            const snapshot = await adapter.listSkills({
              agentId: agent.id,
              companyId: agent.companyId,
              adapterType,
              config: runtimeConfig,
            });
            actualState = snapshot.entries.find((entry) => entry.key === key)?.state
              ?? (snapshot.supported ? "missing" : "unsupported");
          } catch (err) {
            logger.warn(
              { err, agentId: agent.id, adapterType },
              "adapter.listSkills failed in company-skills usage dispatcher",
            );
            actualState = "unknown";
          }
        }

        return {
          id: agent.id,
          name: agent.name,
          urlKey: normalizeAgentUrlKey(agent.name) ?? agent.id,
          adapterType,
          desired: true,
          actualState,
        };
      }),
    );
  }

  async function detail(companyId: string, id: string): Promise<CompanySkillDetail | null> {
    const skill = await getById(id);
    if (!skill || skill.companyId !== companyId) return null;
    const usedByAgents = await usage(companyId, skill.key);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  // -----------------------------------------------------------------------
  // File read / write
  // -----------------------------------------------------------------------

  async function readFile(
    companyId: string,
    skillId: string,
    relativePath: string,
  ): Promise<CompanySkillFileDetail | null> {
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;
    const normalizedPath = normalizePortablePath(relativePath) || "SKILL.md";

    // For local_path source, try reading from filesystem
    if (skill.sourceType === "local_path" && skill.sourceLocator) {
      // SECURITY: reject path traversal — normalizedPath is joined to the skill
      // directory on disk, and normalizePortablePath does NOT strip "../", so an
      // unvalidated path escapes the skill dir (arbitrary file read).
      let safeRelativePath: string;
      try {
        safeRelativePath = validatePackageFileKey(skill.sourceLocator, normalizedPath);
      } catch {
        return null;
      }
      const filePath = path.join(skill.sourceLocator, safeRelativePath);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const ext = path.extname(normalizedPath).toLowerCase();
        return {
          skillId: skill.id,
          path: normalizedPath,
          kind: classifyInventoryKind(normalizedPath),
          content,
          language:
            ext === ".md"
              ? "markdown"
              : ext === ".ts"
                ? "typescript"
                : ext === ".js"
                  ? "javascript"
                  : ext.slice(1) || null,
          markdown: ext === ".md",
          editable: true,
        };
      } catch {
        // Fall through to DB content
      }
    }

    // For SKILL.md, return DB markdown content
    if (normalizedPath === "SKILL.md") {
      return {
        skillId: skill.id,
        path: "SKILL.md",
        kind: "skill",
        content: skill.markdown,
        language: "markdown",
        markdown: true,
        editable: skill.sourceType === "local_path" || skill.sourceType === "catalog",
      };
    }

    return null;
  }

  async function updateFile(
    companyId: string,
    skillId: string,
    filePath: string,
    content: string,
  ): Promise<CompanySkillFileDetail> {
    const skillRow = await getRowById(skillId);
    if (!skillRow || skillRow.companyId !== companyId) {
      throw notFound("Skill not found");
    }
    const skill = toCompanySkill(skillRow);

    const normalizedPath = normalizePortablePath(filePath) || "SKILL.md";
    const markdownChanged =
      normalizedPath === "SKILL.md" && content !== skill.markdown;
    const shouldWriteLocalFile = normalizedPath !== "SKILL.md" || markdownChanged;
    // SECURITY: reject path traversal — normalizedPath is joined to the skill
    // directory on disk, and normalizePortablePath does NOT strip "../", so an
    // unvalidated path escapes the skill dir (arbitrary file write).
    try {
      validatePackageFileKey(skill.sourceLocator ?? ".", normalizedPath);
    } catch {
      throw unprocessable(`Invalid file path "${filePath}": path traversal not allowed`);
    }
    const { editable } = deriveSkillSourceInfo(skill);
    if (!editable) {
      throw unprocessable("GitHub-managed skills can only be edited via install-update");
    }

    // T2.8c(b) writable-sink jail: refuse to write a `local_path` skill file
    // whose RESOLVED TARGET lands inside the managed marketplace-skills tree —
    // the catalog installer is that tree's only writer. Checking the resolved
    // `sourceLocator + normalizedPath` (not just `sourceLocator`) also catches a
    // row rooted at an ANCESTOR of the managed tree (e.g. `.aoa`) whose forward
    // path reaches in. This is the authoritative guard (the `importFromSource`
    // check only stops NEW inside-rows); it also neutralizes rows minted by
    // `scanProjectWorkspaces` and any that predate the import guard. Per Codex #302.
    if (
      skill.sourceType === "local_path"
      && skill.sourceLocator
    ) {
      const resolvedTarget = path.resolve(skill.sourceLocator, normalizedPath);
      if (isInsideManagedMarketplaceSkillsRoot(resolvedTarget)) {
        throw unprocessable(
          "This skill's file target resolves inside the managed marketplace-skills directory and " +
            "cannot be edited here; the catalog installer owns that tree.",
        );
      }
    }

    // Update on filesystem if local_path
    if (skill.sourceType === "local_path" && skill.sourceLocator && shouldWriteLocalFile) {
      const dirStat = await statPath(skill.sourceLocator);
      if (dirStat !== "directory") {
        // Source directory no longer exists — convert to catalog so it stays editable
        await db
          .update(companySkills)
          .set({ sourceType: "catalog", sourceLocator: null, updatedAt: new Date() })
          .where(eq(companySkills.id, skillId));
        // Continue to write to DB below; skip filesystem write
      } else {
        const fullPath = path.join(skill.sourceLocator, normalizedPath);
        try {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        } catch {
          // Filesystem write failed — DB write proceeds regardless (for SKILL.md it
          // updates the markdown column; for other paths it sets customized=true).
        }
      }
    }

    // A byte-identical SKILL.md save is a true no-op. Rewriting its stale
    // snapshot could undo an upstream update that committed after our read.
    if (normalizedPath === "SKILL.md") {
      if (markdownChanged) {
        const { frontmatter } = parseFrontmatterMarkdown(content);
        const newName = asString(frontmatter.name) ?? skill.name;
        const newDescription = asString(frontmatter.description) ?? skill.description;
        await db
          .update(companySkills)
          .set({
            markdown: content,
            name: newName,
            description: newDescription,
            customized: true,
            updatedAt: new Date(),
          })
          .where(eq(companySkills.id, skillId));
      }
    } else {
      // For non-SKILL.md paths (filesystem-only edit), mark customized in a standalone write.
      // The DB markdown column wasn't changed, so there is no two-step atomicity risk.
      await db
        .update(companySkills)
        .set({ customized: true })
        .where(eq(companySkills.id, skillId));
    }

    const ext = path.extname(normalizedPath).toLowerCase();
    return {
      skillId: skill.id,
      path: normalizedPath,
      kind: classifyInventoryKind(normalizedPath),
      content,
      language:
        ext === ".md"
          ? "markdown"
          : ext === ".ts"
            ? "typescript"
            : ext === ".js"
              ? "javascript"
              : ext.slice(1) || null,
      markdown: ext === ".md",
      editable: true,
    };
  }

  // -----------------------------------------------------------------------
  // Create / delete
  // -----------------------------------------------------------------------

  async function createLocalSkill(
    companyId: string,
    input: CompanySkillCreateRequest,
  ): Promise<CompanySkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(companyId);
    const skillDir = path.resolve(managedRoot, slug);

    const markdown = input.markdown?.trim().length
      ? input.markdown
      : [
        "---",
        `name: ${input.name}`,
        ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
        "---",
        "",
        `# ${input.name}`,
        "",
        input.description?.trim() ? input.description.trim() : "Describe what this skill does.",
        "",
      ].join("\n");

    const safeMarkdown = sanitizeMarkdown(markdown);
    const parsed = parseFrontmatterMarkdown(markdown);
    const key = `company/${companyId}/${slug}`;

    // A skill's normalized slug is its user-facing identity and route lookup
    // key, even when an imported/catalog skill has a different canonical key.
    // Refuse that collision before staging any filesystem bytes. Concurrent
    // createLocalSkill calls still race through the unique company+key insert
    // below, whose loser is mapped to the same 409.
    const existingSlug = (await listFullRows(companyId)).find(
      (candidate) => normalizeSkillSlug(candidate.slug) === slug,
    );
    if (existingSlug) {
      throw skillNameTakenConflict(slug, existingSlug.key);
    }

    // Stage bytes away from the final path, then atomically claim the final
    // directory BEFORE exposing a DB row whose inventory reconciliation would
    // otherwise see a missing sourceLocator and prune it. A failed insert
    // removes only the directory this request just claimed.
    await fs.mkdir(managedRoot, { recursive: true });
    const stagingDir = await fs.mkdtemp(path.join(managedRoot, `.${slug}-create-`));
    try {
      // Preserve the founder-authored file bytes exactly. The DB column keeps
      // the existing sanitized representation used by imported skills, but
      // the managed source file must not discard Unicode content.
      await fs.writeFile(path.join(stagingDir, "SKILL.md"), markdown, "utf8");

      try {
        await fs.rename(stagingDir, skillDir);
      } catch (error) {
        const record = error && typeof error === "object"
          ? error as Record<string, unknown>
          : null;
        if (
          record?.code === "EEXIST"
          || record?.code === "ENOTEMPTY"
          || record?.code === "EPERM"
        ) {
          throw skillNameTakenConflict(slug, key);
        }
        throw error;
      }

      let inserted: CompanySkillRow | undefined;
      try {
        [inserted] = await db
          .insert(companySkills)
          .values({
            companyId,
            key,
            slug,
            name: asString(parsed.frontmatter.name) ?? input.name,
            description:
              asString(parsed.frontmatter.description) ?? input.description?.trim() ?? null,
            markdown: safeMarkdown,
            sourceType: "local_path",
            sourceLocator: skillDir,
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: serializeFileInventory([{ path: "SKILL.md", kind: "skill" }]),
            metadata: { sourceKind: "managed_local" },
            customized: false,
          })
          .returning();
      } catch (error) {
        await fs.rm(skillDir, { recursive: true, force: true });
        if (isCompanySkillKeyCollision(error)) {
          throw skillNameTakenConflict(slug, key);
        }
        throw error;
      }

      if (!inserted) {
        await fs.rm(skillDir, { recursive: true, force: true });
        throw new Error("Failed to create company skill");
      }

      return toCompanySkill(inserted);
    } finally {
      // If publication lost the filesystem race, remove only this request's
      // private staging directory. Insert failures clean up the final directory
      // in their own branch because this request already claimed it.
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * Creates or replaces a local_path skill from a file map (e.g. from the Internal Agent via MCP).
   * The map must include "SKILL.md". All other entries are written as ancillary files.
   *
   * Guarantees:
   * - Path traversal: every key is validated to stay within the skill directory.
   * - Slug collision: resolves the final slug against existing skills before touching disk,
   *   so the disk path and DB slug are always consistent.
   * - Orphaned files: the skill directory is fully cleared before writing the new file map,
   *   so stale files from a previous import are never injected into agents.
   * - Race condition: concurrent imports to the same companyId+slug are serialized via a
   *   module-level queue so disk writes and DB upserts never interleave.
   * - Markdown overwrite: always overwrites — the caller is the authoritative source.
   *   `metadata.lastPackageImportAt` records the timestamp so callers can distinguish
   *   package-imported skills from manually edited ones.
   */
  async function importPackageFiles(
    companyId: string,
    fileMap: Record<string, string>,
  ): Promise<CompanySkill> {
    const skillMd = fileMap["SKILL.md"] ?? fileMap["skill.md"] ?? "";
    if (!skillMd.trim()) {
      throw unprocessable('File map must include a non-empty "SKILL.md" entry');
    }

    const { frontmatter } = parseFrontmatterMarkdown(skillMd);
    const rawName = asString(frontmatter.name) ?? "Untitled Skill";
    const rawSlug = asString(frontmatter.slug) ?? rawName;
    const slug = normalizeSkillSlug(rawSlug) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(companyId);

    // Serialize concurrent imports to the same slug (race condition fix)
    const lockKey = `${companyId}/${slug}`;
    const prev = skillPackageImportQueue.get(lockKey) ?? Promise.resolve();

    const doWork = async (): Promise<CompanySkill> => {
      // 1. Resolve final slug inside the lock so listFull sees committed DB state
      //    (slug collision fix)
      const allExisting = await listFull(companyId);
      const existingByKey = allExisting.find((s) => s.key === `company/${companyId}/${slug}`);

      let finalSlug: string;
      if (existingByKey) {
        // Re-import: preserve the existing DB slug (it may differ from the raw slug
        // if it was deduplicated on first import)
        finalSlug = existingByKey.slug;
      } else {
        // New skill: find a slug that isn't already taken by a different skill
        const usedSlugs = new Set(allExisting.map((s) => s.slug));
        finalSlug = uniqueSkillSlug(slug, usedSlugs);
      }

      const finalKey = `company/${companyId}/${finalSlug}`;
      const skillDir = path.resolve(managedRoot, finalSlug);

      // 2. Validate all file paths (path traversal fix — belt-and-suspenders after schema)
      for (const relPath of Object.keys(fileMap)) {
        try {
          validatePackageFileKey(skillDir, relPath);
        } catch {
          throw unprocessable(`Invalid file path "${relPath}": path traversal not allowed`);
        }
      }

      // 3. Clear existing directory then recreate clean (orphaned files fix)
      await fs.rm(skillDir, { recursive: true, force: true });
      await fs.mkdir(skillDir, { recursive: true });

      // 4. Write all files from the map
      for (const [relPath, content] of Object.entries(fileMap)) {
        const normalized = normalizePortablePath(relPath) || "SKILL.md";
        const fullPath = path.join(skillDir, normalized);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
      }

      // 5. Collect inventory and derive trust level from the written files
      const inventory = await collectLocalSkillInventory(skillDir, "full");
      const trustLevel = deriveTrustLevel(inventory);
      const description = asString(frontmatter.description) ?? null;

      // 6. Upsert — always overwrites markdown (caller is authoritative source)
      //    lastPackageImportAt lets callers detect package-imported vs manually edited
      //
      //    T2.9 policy note: this MUST stay `caller_is_authoritative`. Step 3
      //    above already `rm -rf`'d and rewrote the skill directory, so refusing
      //    the DB write here would leave the founder's markdown in the row and
      //    the caller's files on disk — a torn state strictly worse than the
      //    overwrite. Making this path founder-safe requires reordering the disk
      //    write, not flipping this flag; filed as T2.9c.
      const imported = (await upsertImportedSkills(companyId, [{
        key: finalKey,
        slug: finalSlug,
        name: rawName,
        description,
        markdown: skillMd,
        sourceType: "local_path",
        sourceLocator: skillDir,
        sourceRef: null,
        trustLevel,
        compatibility: "compatible",
        fileInventory: inventory,
        metadata: {
          sourceKind: "managed_local",
          lastPackageImportAt: new Date().toISOString(),
        },
      }], "caller_is_authoritative")).skills;

      return imported[0]!;
    };

    // Chain behind any in-progress import for this slug; store a void promise
    // so the next caller can chain behind this one without holding a result reference
    const work = prev.then(doWork, doWork);
    skillPackageImportQueue.set(lockKey, work.then(() => {}, () => {}));
    return work;
  }

  async function deleteSkill(
    companyId: string,
    skillId: string,
  ): Promise<CompanySkill | null> {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const skill = toCompanySkill(row);

    // Remove from agent skillKeys
    const agentRows = await agents.list(companyId);
    for (const agent of agentRows as any[]) {
      const skillKeys: string[] = Array.isArray(agent.skillKeys) ? agent.skillKeys : [];
      if (skillKeys.includes(skill.key)) {
        const filtered = skillKeys.filter((k: string) => k !== skill.key);
        await agents.update(agent.id, { skillKeys: filtered } as any);
      }
    }

    await db.delete(companySkills).where(eq(companySkills.id, skillId));
    // AoA owns only direct child directories it created under the per-company
    // managed root. Remove those with the row so a founder can later recreate
    // the same slug. Never delete arbitrary imported local_path directories.
    const managedRoot = path.resolve(resolveManagedSkillsRoot(companyId));
    const resolvedLocator = skill.sourceLocator
      ? path.resolve(skill.sourceLocator)
      : null;
    const managedLocalDirectory =
      skill.sourceType === "local_path"
      && skill.metadata?.sourceKind === "managed_local"
      && resolvedLocator
      && path.dirname(resolvedLocator) === managedRoot
        ? resolvedLocator
        : null;
    if (managedLocalDirectory) {
      try {
        await fs.rm(managedLocalDirectory, { recursive: true, force: true });
      } catch (error) {
        logger.warn(
          { companyId, skillId, sourceLocator: managedLocalDirectory, error },
          "Deleted managed local skill row but could not remove its directory",
        );
      }
    }
    return skill;
  }

  // -----------------------------------------------------------------------
  // Import from source
  // -----------------------------------------------------------------------

  /**
   * Install (or re-install) skills from a github / url / skills.sh / local source.
   *
   * T2.9 — re-importing over a row the founder has edited does NOT overwrite it:
   * the row is skipped, listed in `refusedCustomized`, and called out in
   * `warnings`. Nothing on disk is touched either way; this path only reads its
   * source. Un-edited rows still update normally.
   */
  async function importFromSource(companyId: string, source: string): Promise<CompanySkillImportResult> {
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(companyId, parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(companyId, parsed.resolvedSource, parsed.requestedSkillSlug)
        .then((result) => ({
          skills: result.skills,
          warnings: [...parsed.warnings, ...result.warnings],
        }));
    const filteredSkills = parsed.requestedSkillSlug
      ? skills.filter((skill) => skill.slug === parsed.requestedSkillSlug)
      : skills;
    if (filteredSkills.length === 0) {
      throw unprocessable(
        parsed.requestedSkillSlug
          ? `Skill ${parsed.requestedSkillSlug} was not found in the provided source.`
          : "No skills were found in the provided source.",
      );
    }
    // Override sourceType/sourceLocator for skills imported via skills.sh
    if (parsed.originalSkillsShUrl) {
      for (const skill of filteredSkills) {
        skill.sourceType = "skills_sh";
        skill.sourceLocator = parsed.originalSkillsShUrl;
        if (skill.metadata) {
          (skill.metadata as Record<string, unknown>).sourceKind = "skills_sh";
        }
        skill.key = deriveCanonicalSkillKey(companyId, skill);
      }
    }

    // T2.8c(b): a local import must never mint a `local_path` row that names a
    // directory inside the managed marketplace-skills tree. Such a row is
    // editable (its `sourceType` is `local_path`), so `PATCH /skills/:id/files`
    // would then write into a catalog-owned bundle — but the materializer is the
    // only writer that tree is meant to have. Reject loudly rather than importing
    // a catalog-managed location as an editable local skill.
    for (const skill of filteredSkills) {
      if (
        skill.sourceType === "local_path" &&
        skill.sourceLocator &&
        overlapsManagedMarketplaceSkillsRoot(skill.sourceLocator)
      ) {
        throw unprocessable(
          `Cannot import a skill whose directory overlaps the managed marketplace-skills tree ` +
            `("${skill.sourceLocator}"). That tree is owned by the catalog installer.`,
        );
      }
    }

    const { skills: imported, refused } = await upsertImportedSkills(
      companyId,
      filteredSkills,
      "preserve_founder_edits",
    );
    const refusalWarnings = refused.map(
      (entry) =>
        `Skipped "${entry.name}" — it has local edits that this install would have discarded. ` +
        "Delete the skill and re-import it if you want the upstream version.",
    );
    return { imported, warnings: [...warnings, ...refusalWarnings], refusedCustomized: refused };
  }

  // -----------------------------------------------------------------------
  // Scan project workspaces
  // -----------------------------------------------------------------------

  async function scanProjectWorkspaces(
    companyId: string,
    input: CompanySkillProjectScanRequest,
  ): Promise<CompanySkillProjectScanResult> {
    const result: CompanySkillProjectScanResult = {
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    };

    // Collect scan targets
    const targets: ProjectSkillScanTarget[] = [];
    const allProjects = await projects.list(companyId);

    for (const project of allProjects) {
      if (input.projectIds && input.projectIds.length > 0 && !input.projectIds.includes(project.id)) {
        continue;
      }

      const workspaces = (project as any).workspaces ?? [];
      for (const ws of workspaces) {
        if (input.workspaceIds && input.workspaceIds.length > 0 && !input.workspaceIds.includes(ws.id)) {
          continue;
        }
        if (!ws.cwd) {
          result.skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: ws.id,
            workspaceName: ws.name,
            path: null,
            reason: "No workspace directory configured",
          });
          continue;
        }
        targets.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: ws.id,
          workspaceName: ws.name ?? ws.id,
          workspaceCwd: ws.cwd,
        });
      }
    }

    const projectIds = new Set(targets.map((t) => t.projectId));
    result.scannedProjects = projectIds.size;
    result.scannedWorkspaces = targets.length;

    const existingRows = await listFullRows(companyId);
    const existingSkills = existingRows.map(toCompanySkill);
    // T2.9 — `customized` is not on `CompanySkill`; carry it alongside so the
    // re-sync below can refuse a row the founder has edited.
    const customizedById = new Map(existingRows.map((row) => [row.id, row.customized === true]));
    const usedSlugs = new Set(existingSkills.map((s) => s.slug));
    const usedKeys = new Set(existingSkills.map((s) => s.key));

    for (const target of targets) {
      const skillDirs = await discoverProjectWorkspaceSkillDirectories({ workspaceCwd: target.workspaceCwd });

      for (const { skillDir, inventoryMode } of skillDirs) {
        const imported = await readLocalSkillImportFromDirectory(companyId, skillDir, {
          inventoryMode,
          metadata: {
            sourceKind: "project_scan",
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
          },
        });
        if (!imported) continue;

        // T2.8c(b): a workspace cwd can be a catalog bundle version directory,
        // so a discovered SKILL.md there would mint an editable `local_path` row
        // inside the managed tree. Skip it — the catalog installer owns that
        // tree. (Complements the authoritative updateFile sink guard; Codex #302.)
        if (isInsideManagedMarketplaceSkillsRoot(skillDir)) {
          result.skipped.push({
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: skillDir,
            reason: "Inside the managed marketplace-skills directory (catalog-owned).",
          });
          continue;
        }

        result.discovered++;

        // Check for conflicts with existing skills
        const existingByLocator = existingSkills.find(
          (s) => s.sourceType === "local_path" && s.sourceLocator === skillDir,
        );

        if (existingByLocator) {
          // T2.9 — a bulk re-sync must not silently revert a row the founder has
          // edited. This is the same gate `installUpdate` and `importFromSource`
          // apply, reported through the `conflicts[]` channel this result object
          // already has rather than as an exception: one edited skill must not
          // abort the sweep for every other project.
          const conflictForCustomized = (): CompanySkillProjectScanConflict => ({
            slug: existingByLocator.slug,
            key: existingByLocator.key,
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: skillDir,
            existingSkillId: existingByLocator.id,
            existingSkillKey: existingByLocator.key,
            existingSourceLocator: existingByLocator.sourceLocator,
            reason:
              `Skill "${existingByLocator.name}" has local edits — left untouched. `
              + "Delete the skill and re-scan if you want the version on disk.",
          });

          if (customizedById.get(existingByLocator.id)) {
            result.conflicts.push(conflictForCustomized());
            continue;
          }

          // Update existing
          const [updated] = await db
            .update(companySkills)
            .set({
              name: imported.name,
              description: imported.description,
              markdown: imported.markdown,
              trustLevel: imported.trustLevel,
              fileInventory: serializeFileInventory(imported.fileInventory),
              metadata: imported.metadata,
              updatedAt: new Date(),
            })
            // Optimistic lock: a founder edit committed between the read above and
            // this write makes RETURNING empty, and we refuse instead of clobbering.
            .where(and(eq(companySkills.id, existingByLocator.id), eq(companySkills.customized, false)))
            .returning();
          if (updated) {
            result.updated.push(toCompanySkill(updated));
          } else {
            // Empty RETURNING: concurrent founder edit (or, rarely, a concurrent
            // delete). Refuse either way — same approximation as the other paths.
            result.conflicts.push(conflictForCustomized());
          }
          continue;
        }

        // Check slug conflict
        const existingBySlug = existingSkills.find((s) => s.slug === imported.slug);
        if (existingBySlug) {
          result.conflicts.push({
            slug: imported.slug,
            key: existingBySlug.key,
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: skillDir,
            existingSkillId: existingBySlug.id,
            existingSkillKey: existingBySlug.key,
            existingSourceLocator: existingBySlug.sourceLocator,
            reason: `Skill slug "${imported.slug}" already exists`,
          });
          continue;
        }

        // Insert new
        const slug = uniqueSkillSlug(imported.slug, usedSlugs);
        const key = uniqueImportedSkillKey(companyId, slug, usedKeys);

        const [inserted] = await db
          .insert(companySkills)
          .values({
            companyId,
            key,
            slug,
            name: imported.name,
            description: imported.description,
            markdown: imported.markdown,
            sourceType: "local_path",
            sourceLocator: skillDir,
            sourceRef: null,
            trustLevel: imported.trustLevel,
            compatibility: "compatible",
            fileInventory: serializeFileInventory(imported.fileInventory),
            metadata: imported.metadata,
          })
          .returning();

        if (inserted) {
          const skill = toCompanySkill(inserted);
          result.imported.push(skill);
          existingSkills.push(skill);
          usedSlugs.add(slug);
          usedKeys.add(key);
        }
      }
    }

    // Prune stale local_path skills whose directories no longer exist
    const missingIds = await findMissingLocalSkillIds(
      existingSkills
        .filter((s) => s.sourceType === "local_path" && s.sourceLocator)
        .map((s) => ({ id: s.id, sourceType: s.sourceType, sourceLocator: s.sourceLocator })),
    );
    for (const id of missingIds) {
      const stale = existingSkills.find((s) => s.id === id);
      await deleteSkill(companyId, id);
      if (stale) {
        result.warnings.push(
          `Removed stale local skill "${stale.name}" — directory no longer exists: ${stale.sourceLocator}`,
        );
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Update status
  // -----------------------------------------------------------------------

  async function updateStatus(
    companyId: string,
    skillId: string,
  ): Promise<CompanySkillUpdateStatus | null> {
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    // Only GitHub and URL sources support update checking
    if (skill.sourceType !== "github" && skill.sourceType !== "url" && skill.sourceType !== "local_path") {
      return {
        supported: false,
        reason: "Update checking is only supported for GitHub, URL, and local path sources",
        trackingRef: null,
        currentRef: skill.sourceRef,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const resolved = await resolveSkillReference(skill);
    if (!resolved) {
      return {
        supported: true,
        reason: "Could not resolve latest version from source",
        trackingRef: null,
        currentRef: skill.sourceRef,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const currentHash = hashSkillValue(skill.markdown);
    const latestHash = resolved.latestContent ? hashSkillValue(resolved.latestContent) : null;
    const hasUpdate = latestHash !== null && currentHash !== latestHash;

    return {
      supported: true,
      reason: null,
      trackingRef: resolved.latestRef,
      currentRef: skill.sourceRef,
      latestRef: resolved.latestRef,
      hasUpdate,
    };
  }

  // -----------------------------------------------------------------------
  // Install update
  // -----------------------------------------------------------------------

  /**
   * Reinstall an already-installed github / url / local_path skill from its source.
   *
   * T2.9 — this is the non-catalog twin of `applySkillUpdate`
   * (`marketplace-install/skill-auto-updater.ts`) and honours
   * `company_skills.customized` the same way: a row the founder has edited is
   * never silently replaced by upstream bytes. Refusal throws
   * {@link skillCustomizedConflict} (HTTP 409); nothing on disk is touched,
   * because this path only ever reads its source.
   *
   * The check is deliberately duplicated as (a) a pre-read and (b) a
   * `customized = false` predicate on the UPDATE. (b) is the one that matters:
   * a founder edit committed between (a) and the write makes RETURNING empty
   * and we refuse rather than overwrite. Same known approximation as the
   * catalog path — an empty RETURNING could also mean the row was hard-deleted
   * in that window, which we report as "customized" rather than paying for a
   * second SELECT to tell the two apart.
   */
  async function installUpdate(
    companyId: string,
    skillId: string,
  ): Promise<CompanySkill | null> {
    const row = await getRowById(skillId);
    if (!row || row.companyId !== companyId) return null;
    const skill = toCompanySkill(row);

    if (row.customized) throw skillCustomizedConflict(skill);

    const resolved = await resolveSkillReference(skill);
    if (!resolved || !resolved.latestContent) {
      throw unprocessable("Could not resolve latest content from source");
    }

    const { frontmatter } = parseFrontmatterMarkdown(resolved.latestContent);
    const newName = asString(frontmatter.name) ?? skill.name;
    const newDescription = asString(frontmatter.description) ?? skill.description;
    const newTrustLevel = deriveTrustLevel(resolved.latestInventory);

    const [updated] = await db
      .update(companySkills)
      .set({
        name: newName,
        description: newDescription,
        markdown: resolved.latestContent,
        sourceRef: resolved.latestRef,
        trustLevel: newTrustLevel,
        fileInventory: serializeFileInventory(resolved.latestInventory),
        metadata: {
          ...(skill.metadata ?? {}),
          ...((Object.keys(frontmatter).length > 0) ? frontmatter : {}),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(companySkills.id, skillId), eq(companySkills.customized, false)))
      .returning();

    if (!updated) throw skillCustomizedConflict(skill);

    return toCompanySkill(updated);
  }

  // -----------------------------------------------------------------------
  // Skill key resolution (validate refs before saving to agents)
  // -----------------------------------------------------------------------

  async function resolveSkillKeys(
    companyId: string,
    refs: string[],
  ): Promise<string[]> {
    const all = await listFull(companyId);
    const missing = new Set<string>();
    const ambiguous = new Set<string>();
    const resolved = new Set<string>();

    for (const ref of refs) {
      const trimmed = ref.trim();
      if (!trimmed) continue;
      const match = resolveSkillReferenceByIdentifier(all, trimmed);
      if (match.skill) {
        resolved.add(match.skill.key);
        continue;
      }
      if (match.ambiguous) {
        ambiguous.add(trimmed);
        continue;
      }
      missing.add(trimmed);
    }

    if (ambiguous.size > 0 || missing.size > 0) {
      const problems: string[] = [];
      if (ambiguous.size > 0) {
        problems.push(`ambiguous references: ${Array.from(ambiguous).sort().join(", ")}`);
      }
      if (missing.size > 0) {
        problems.push(`unknown references: ${Array.from(missing).sort().join(", ")}`);
      }
      throw unprocessable(`Invalid company skill selection (${problems.join("; ")}).`);
    }

    return Array.from(resolved);
  }

  // -----------------------------------------------------------------------
  // Runtime skill entries (for adapter injection)
  // -----------------------------------------------------------------------

  /**
   * Returns skill entries for adapter injection. Currently only injects SKILL.md
   * content (the `markdown` field). Multi-file skill injection (references/,
   * scripts/, assets/) is deferred to a future extension; ancillary files are recorded in
   * fileInventory but their contents are not stored in DB.
   */
  async function listRuntimeSkillEntries(
    companyId: string,
    agentId: string,
  ): Promise<RuntimeSkillEntry[]> {
    // Get the agent to find its skillKeys
    const agent = await agents.getById(agentId);
    if (!agent || agent.companyId !== companyId) return [];
    const skillKeys: string[] = Array.isArray((agent as any).skillKeys)
      ? (agent as any).skillKeys
      : [];
    if (skillKeys.length === 0) return [];

    // Get all skills for the company
    const allSkills = await listFull(companyId);

    // Filter to only the skills the agent wants and enrich with ancillary files
    const matched = allSkills.filter((skill) => skillKeys.includes(skill.key));
    const entries: RuntimeSkillEntry[] = [];
    for (const skill of matched) {
      const entry: RuntimeSkillEntry = {
        key: skill.key,
        name: skill.name,
        markdown: skill.markdown,
        trustLevel: skill.trustLevel,
      };
      if (skill.sourceType === "local_path" && skill.sourceLocator) {
        const ancillary = await readAncillarySkillFiles(skill.sourceLocator);
        if (ancillary.length > 0) entry.files = ancillary;
      }
      const catalogBundleInstallPath = asString(skill.metadata?.catalogBundleInstallPath);
      if (skill.sourceType === "catalog" && catalogBundleInstallPath) {
        const ancillary = await readAncillarySkillFiles(catalogBundleInstallPath);
        if (ancillary.length > 0) entry.files = ancillary;
      }
      entries.push(entry);
    }
    return entries;
  }

  async function listCompactSkillEntries(
    companyId: string,
    agentId: string,
  ): Promise<Array<{ key: string; name: string; description: string; triggerPhrases: string[] }>> {
    const agent = await agents.getById(agentId);
    if (!agent || agent.companyId !== companyId) return [];
    const skillKeys: string[] = Array.isArray((agent as any).skillKeys)
      ? (agent as any).skillKeys
      : [];
    if (skillKeys.length === 0) return [];
    const allSkills = await listFull(companyId);
    return allSkills
      .filter((skill) => skillKeys.includes(skill.key))
      .map((skill) => ({
        key: skill.key,
        name: skill.name,
        description: skill.description ?? skill.name,
        triggerPhrases: Array.isArray((skill as any).triggerPhrases)
          ? (skill as any).triggerPhrases
          : [],
      }));
  }

  /**
   * Returns full CompanySkillListItem rows scoped to an agent's skillKeys.
   * Empty skillKeys → empty list (explicit: no skills selected). Used by the
   * Commander skill picker so it shows exactly the curated selection.
   */
  async function listSkillListItemsForAgent(
    companyId: string,
    agentId: string,
  ): Promise<CompanySkillListItem[]> {
    const agent = await agents.getById(agentId);
    if (!agent || agent.companyId !== companyId) return [];
    const skillKeys: string[] = Array.isArray((agent as any).skillKeys)
      ? (agent as any).skillKeys
      : [];
    if (skillKeys.length === 0) return [];
    const keySet = new Set(skillKeys);
    const all = await list(companyId);
    return all.filter((s) => keySet.has(s.key));
  }

  // -----------------------------------------------------------------------
  // Upsert imported skills
  // -----------------------------------------------------------------------

  /**
   * Insert-or-update a batch of imported skills, matched on the canonical key.
   *
   * T2.9 — the update branch is the one shared primitive through which every
   * non-catalog install path overwrites an installed row, so the
   * `customized` decision lives HERE rather than in each caller. `policy` has
   * no default on purpose: a future install path cannot compile without saying
   * which side wins.
   *
   * `caller_is_authoritative` additionally clears `customized` on the rows it
   * overwrites: it just replaced the bytes, so the flag would otherwise be a
   * stale claim that permanently blocks every later install (T2.9 F1).
   *
   * Under `preserve_founder_edits` a refused row is skipped, reported in
   * `refused`, and absent from `skills`.
   *
   * `skills` is NOT positionally aligned with `imports` under EITHER policy —
   * `caller_is_authoritative` also drops a row whose UPDATE returns nothing
   * because it was concurrently deleted. It is merely far likelier to be aligned.
   * Callers must pair returned rows and refusals by canonical key.
   */
  async function upsertImportedSkills(
    companyId: string,
    imports: ImportedSkill[],
    policy: CustomizedSkillWritePolicy,
  ): Promise<UpsertImportedSkillsResult> {
    const existingRows = await listFullRows(companyId);
    const existing = existingRows.map(toCompanySkill);
    const customizedById = new Map(existingRows.map((row) => [row.id, row.customized === true]));
    const usedSlugs = new Set(existing.map((s) => s.slug));
    const usedKeys = new Set(existing.map((s) => s.key));
    const results: CompanySkill[] = [];
    const refused: CompanySkillRefusedImport[] = [];

    for (const imp of imports) {
      const safeMarkdown = sanitizeMarkdown(imp.markdown);

      // Determine the canonical key first (before slug deduplication) so we
      // can look up an existing skill and exclude its own slug from the pool.
      // Without this, re-importing "my-skill" would see "my-skill" as taken
      // (by itself) and rename it to "my-skill-2" on every update.
      const normalizedInputSlug = normalizeSkillSlug(imp.slug) ?? imp.slug;
      const prelimKey = imp.key ?? `company/${companyId}/${normalizedInputSlug}`;
      const normalizedPrelimKey = normalizeSkillKey(prelimKey) ?? prelimKey;
      const existingByKey =
        existing.find((s) => s.key === prelimKey)
        ?? existing.find((s) => normalizeSkillKey(s.key) === normalizedPrelimKey);

      // Exclude the existing skill's own slug so deduplication doesn't rename it.
      const slugPool = existingByKey
        ? new Set([...usedSlugs].filter((s) => s !== existingByKey.slug))
        : usedSlugs;
      const slug = uniqueSkillSlug(imp.slug, slugPool);
      const key = existingByKey?.key ?? (imp.key ?? uniqueImportedSkillKey(companyId, slug, usedKeys));
      if (existingByKey) {
        const preserve = policy === "preserve_founder_edits";

        // T2.9 — refuse before we write, then re-assert it as a predicate on the
        // UPDATE so a founder edit that commits between the two still wins.
        if (preserve && customizedById.get(existingByKey.id)) {
          refused.push(refusedCustomizedEntry(existingByKey));
          continue;
        }

        // Update existing
        const [updated] = await db
          .update(companySkills)
          .set({
            slug,
            name: imp.name,
            description: imp.description,
            markdown: safeMarkdown,
            sourceType: imp.sourceType,
            sourceLocator: imp.sourceLocator,
            sourceRef: imp.sourceRef,
            trustLevel: imp.trustLevel,
            compatibility: imp.compatibility,
            fileInventory: serializeFileInventory(imp.fileInventory),
            metadata: imp.metadata,
            // T2.9 F1 — `caller_is_authoritative` just replaced the markdown with
            // its own bytes, so any founder edit the flag was describing is gone.
            // Leaving `customized = true` here would make a TRUE statement before
            // this guard existed and a FALSE one after it: the row would be
            // permanently refused by `installUpdate` and by every later import,
            // told it has local edits it no longer has. Clearing it is what makes
            // the two policies mean what they say.
            ...(preserve ? {} : { customized: false }),
            updatedAt: new Date(),
          })
          .where(
            preserve
              ? and(eq(companySkills.id, existingByKey.id), eq(companySkills.customized, false))
              : eq(companySkills.id, existingByKey.id),
          )
          .returning();
        if (updated) {
          results.push(toCompanySkill(updated));
        } else if (preserve) {
          // Empty RETURNING under the optimistic lock: a concurrent founder edit
          // (or, rarely, a concurrent delete) won the race. Refuse either way —
          // same approximation the catalog path documents.
          refused.push(refusedCustomizedEntry(existingByKey));
        }
      } else {
        // Insert new
        const [inserted] = await db
          .insert(companySkills)
          .values({
            companyId,
            key,
            slug,
            name: imp.name,
            description: imp.description,
            markdown: safeMarkdown,
            sourceType: imp.sourceType,
            sourceLocator: imp.sourceLocator,
            sourceRef: imp.sourceRef,
            trustLevel: imp.trustLevel,
            compatibility: imp.compatibility,
            fileInventory: serializeFileInventory(imp.fileInventory),
            metadata: imp.metadata,
          })
          .returning();
        if (inserted) results.push(toCompanySkill(inserted));
        usedSlugs.add(slug);
        usedKeys.add(key);
      }
    }

    return { skills: results, refused };
  }

  // -----------------------------------------------------------------------
  // Presentation helpers
  // -----------------------------------------------------------------------

  function deriveSkillSourceInfo(skill: CompanySkill): {
    editable: boolean;
    editableReason: string | null;
    sourceLabel: string | null;
    sourceBadge: CompanySkillSourceBadge;
    sourcePath: string | null;
  } {
    const editable = skill.sourceType === "local_path" || skill.sourceType === "catalog";
    return {
      editable,
      editableReason: editable
        ? null
        : "GitHub-managed skills can only be edited via install-update",
      sourceLabel: deriveSourceLabel(skill),
      sourceBadge: deriveSourceBadge(skill),
      sourcePath: skill.sourceType === "local_path" ? skill.sourceLocator : null,
    };
  }

  function toCompanySkillListItem(
    skill: CompanySkill,
    attachedAgentCount: number,
  ): CompanySkillListItem {
    return {
      id: skill.id,
      companyId: skill.companyId,
      key: skill.key,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      sourceType: skill.sourceType,
      sourceLocator: skill.sourceLocator,
      sourceRef: skill.sourceRef,
      trustLevel: skill.trustLevel,
      compatibility: skill.compatibility,
      fileInventory: skill.fileInventory,
      metadata: skill.metadata,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      attachedAgentCount,
      ...deriveSkillSourceInfo(skill),
    };
  }

  function enrichSkill(
    skill: CompanySkill,
    attachedAgentCount: number,
    usedByAgents: CompanySkillUsageAgent[] = [],
  ): CompanySkillDetail {
    return {
      ...skill,
      attachedAgentCount,
      usedByAgents,
      ...deriveSkillSourceInfo(skill),
    };
  }

  function deriveSourceLabel(skill: CompanySkill): string | null {
    const meta = getSkillMeta(skill);
    if (meta.sourceKind === "github" || meta.sourceKind === "skills_sh") {
      const owner = asString(meta.owner);
      const repo = asString(meta.repo);
      if (owner && repo) return `${owner}/${repo}`;
    }
    if (skill.sourceType === "url" && skill.sourceLocator) {
      try {
        return new URL(skill.sourceLocator).host;
      } catch {
        return skill.sourceLocator;
      }
    }
    if (skill.sourceType === "local_path") return "Local";
    if (skill.sourceType === "catalog") {
      const metadata = skill.metadata;
      if (metadata && typeof metadata === "object") {
        const provider = (metadata as Record<string, unknown>).catalogProvider;
        if (provider && typeof provider === "object") {
          const name = (provider as Record<string, unknown>).name;
          if (typeof name === "string" && name.length > 0) return name;
        }
        const packageId = asString((metadata as Record<string, unknown>).catalogPackageId);
        if (packageId) return packageId;
      }
      return "Catalog";
    }
    return null;
  }

  function deriveSourceBadge(skill: CompanySkill): CompanySkillSourceBadge {
    const meta = getSkillMeta(skill);
    if (meta.sourceKind === "skills_sh") return "skills_sh";
    if (meta.sourceKind === "paperclip_bundled") return "paperclip";
    if (skill.sourceType === "github") return "github";
    if (skill.sourceType === "url") return "url";
    if (skill.sourceType === "local_path") return "local";
    if (skill.sourceType === "catalog") return "catalog";
    return "local";
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    list,
    listFull,
    listFullWithCustomization,
    getById,
    getByKey,
    detail,
    updateStatus,
    readFile,
    updateFile,
    createLocalSkill,
    importPackageFiles,
    deleteSkill,
    importFromSource,
    scanProjectWorkspaces,
    installUpdate,
    listRuntimeSkillEntries,
    listCompactSkillEntries,
    listSkillListItemsForAgent,
    resolveSkillKeys,
    upsertImportedSkills,
    usage,
  };
}
