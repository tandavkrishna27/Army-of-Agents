#!/usr/bin/env tsx
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(
  repoRoot,
  "server/src/services/internal-agent/generated/aoa-native-skills.json",
);

/** skill:aoa-curated/aoa-<name>  →  skill:aoa/<name>  (deterministic; preserves live keys). */
function mapRepoKeyToSeederKey(repoKey: string): string {
  const m = /^skill:aoa-curated\/aoa-(.+)$/.exec(repoKey.trim());
  if (!m) throw new Error(`unexpected repo skill key (want skill:aoa-curated/aoa-<name>): ${repoKey}`);
  return `skill:aoa/${m[1]}`;
}

function parseFrontmatter(src: string): { fm: Record<string, string>; body: string } {
  // Normalize CRLF -> LF: the AoA-Skills repo checks out with Windows line endings.
  const normalized = src.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error("missing frontmatter");
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: match[2] };
}

function buildCatalog(skillsRoot: string) {
  const dir = resolve(skillsRoot, "skills");
  if (!existsSync(dir)) throw new Error(`skills dir not found: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const skills = files.map((f) => {
    const { fm, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
    if (!fm.key || !fm.name || !fm.description) throw new Error(`missing key/name/description in ${f}`);
    const key = mapRepoKeyToSeederKey(fm.key);
    const markdown = body.trim() + "\n";
    if (markdown.includes("create_memory")) {
      throw new Error(`phantom create_memory present in ${f} — fix the source skill (WS-0 Task 8)`);
    }
    const triggerPhrases = fm.triggerPhrases
      ? JSON.parse(fm.triggerPhrases) as string[]
      : [];
    return { key, name: fm.name, description: fm.description, triggerPhrases, markdown };
  });
  return { $generated: "DO NOT EDIT — run `pnpm gen:skills`. Source: AoA-Skills skills/*.md.", version: 1, skills };
}

const skillsRoot =
  process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ??
  resolve(repoRoot, "../../scratchpad/aoa-skills");
const next = JSON.stringify(buildCatalog(skillsRoot), null, 2) + "\n";
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== next) {
    console.error("ERROR: aoa-native-skills.json is stale. Run `pnpm gen:skills -- <skills-repo>` and commit.");
    process.exit(1);
  }
  console.log("aoa-native-skills.json is fresh.");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next, "utf8");
  console.log(`Wrote ${OUT}`);
}
