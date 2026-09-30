import { COMMANDER_SKILL_PREAMBLE } from "./commander-preamble.js";

interface RuntimeSkillEntry { key: string; name: string; markdown: string; trustLevel?: string; }
interface BuildArgs {
  companyId: string;
  agentId: string;
  resolve: (companyId: string, agentId: string) => Promise<RuntimeSkillEntry[]>;
  maxChars?: number;
}

/**
 * Build a "## Skills" prompt section from the agent's resolved skills.
 * Inlined into the assembled prompt (the chat path has no skillsDir/cwd
 * plumbing; inlining is adapter-uniform and keeps the spawn byte-stable).
 * Any resolution failure → empty string (never blocks the turn).
 * @deprecated Use buildCompactSkillList instead — avoids full markdown injection.
 */
export async function buildSkillsSection(args: BuildArgs): Promise<string> {
  try {
    const entries = await args.resolve(args.companyId, args.agentId);
    if (!entries || entries.length === 0) return "";
    const cap = args.maxChars ?? 12000;
    let body = "";
    for (const e of entries) {
      const block = `### ${e.name}\n${e.markdown}\n`;
      if (body.length + block.length > cap) break;
      body += block;
    }
    return body.trim() ? `## Skills\n${body.trim()}` : "";
  } catch {
    return "";
  }
}

const COMPACT_SKILL_LIST_MAX_TOKENS = 1000;
const CHARS_PER_TOKEN = 4;
const COMPACT_MAX_CHARS = COMPACT_SKILL_LIST_MAX_TOKENS * CHARS_PER_TOKEN;

interface CompactArgs {
  companyId: string;
  agentId: string;
  resolve: (
    companyId: string,
    agentId: string,
  ) => Promise<Array<{ key: string; name: string; description: string; triggerPhrases: string[] }>>;
}

export async function buildCompactSkillList(args: CompactArgs): Promise<string> {
  try {
    const entries = await args.resolve(args.companyId, args.agentId);
    if (!entries || entries.length === 0) return "";
    let rows = "";
    let overflow = false;
    for (const e of entries) {
      const triggers =
        e.triggerPhrases.length > 0
          ? `Triggers: ${e.triggerPhrases.slice(0, 5).join(", ")}`
          : "";
      const row = `| **${e.name}** (\`${e.key}\`) | ${e.description}${triggers ? ` — ${triggers}` : ""} |\n`;
      if (rows.length + row.length > COMPACT_MAX_CHARS) {
        overflow = true;
        break;
      }
      rows += row;
    }
    if (!rows.trim()) return "";
    return [
      COMMANDER_SKILL_PREAMBLE,
      "",
      "## Available Skills",
      "Call `use_skill` with the skill key to load full instructions before applying a skill.",
      "",
      "| Skill | When to use |",
      "|-------|------------|",
      rows.trimEnd(),
      overflow ? "\n_(additional skills configured — query with use_skill)_" : "",
    ]
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}
