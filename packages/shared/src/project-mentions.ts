export const PROJECT_MENTION_SCHEME = "project://";

const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_RE = /^[0-9a-f]{3}$/i;
const HEX_COLOR_WITH_HASH_RE = /^#[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_WITH_HASH_RE = /^#[0-9a-f]{3}$/i;
const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
}

function normalizeHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (HEX_COLOR_WITH_HASH_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (HEX_COLOR_SHORT_WITH_HASH_RE.test(trimmed)) {
    const raw = trimmed.slice(1).toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (HEX_COLOR_SHORT_RE.test(trimmed)) {
    const raw = trimmed.toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  return null;
}

export function buildProjectMentionHref(projectId: string, color?: string | null): string {
  const trimmedProjectId = projectId.trim();
  const normalizedColor = normalizeHexColor(color ?? null);
  if (!normalizedColor) {
    return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}`;
  }
  return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}?c=${encodeURIComponent(normalizedColor.slice(1))}`;
}

export function parseProjectMentionHref(href: string): ParsedProjectMention | null {
  if (!href.startsWith(PROJECT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "project:") return null;

  const projectId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!projectId) return null;

  const color = normalizeHexColor(url.searchParams.get("c") ?? url.searchParams.get("color"));

  return {
    projectId,
    color,
  };
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Skill mentions  (skill://<skillId>?s=<slug>)
// ---------------------------------------------------------------------------

export const SKILL_MENTION_SCHEME = "skill://";

/** Matches `[label](skill://skillId?s=slug)` — the `?s=` part is optional. */
const SKILL_MENTION_LINK_RE =
  /\[[^\]]*\]\(skill:\/\/([0-9a-f-]+)(?:\?s=([a-z0-9-]+))?\)/gi;

/**
 * Build a `skill://` href from a skill id and optional slug.
 *
 * @example
 *   buildSkillMentionHref("abc-123", "my-skill") // "skill://abc-123?s=my-skill"
 *   buildSkillMentionHref("abc-123")              // "skill://abc-123"
 */
export function buildSkillMentionHref(skillId: string, slug?: string): string {
  const base = `${SKILL_MENTION_SCHEME}${skillId}`;
  return slug ? `${base}?s=${slug}` : base;
}

export interface ParsedSkillMention {
  skillId: string;
  slug: string | null;
}

/**
 * Parse a `skill://` href back into its parts.
 * Returns `null` for any non-skill href.
 */
export function parseSkillMentionHref(href: string): ParsedSkillMention | null {
  const m = href.match(/^skill:\/\/([0-9a-f-]+)(?:\?s=([a-z0-9-]+))?$/i);
  if (!m) return null;
  return { skillId: m[1], slug: m[2] ?? null };
}

/**
 * Extract all unique skill IDs referenced in a markdown string via
 * `[label](skill://id?s=slug)` links.
 */
export function extractSkillMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(SKILL_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

/**
 * Normalise a raw skill name or key into a URL-safe slug.
 *
 * @example
 *   normalizeSkillSlug("My Cool Skill!") // "my-cool-skill"
 */
export function normalizeSkillSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
