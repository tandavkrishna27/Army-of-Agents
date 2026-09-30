import type { CompanySkillListItem } from "@armyofagents/shared";

/**
 * Pure helpers for the Commander `/skill` picker.
 *
 * Extracted from the component so the slash-detection, filtering, and
 * directive-building logic can be unit-tested without the DOM.
 */

/**
 * Case-insensitive substring filter over a skill's `name` and `key`.
 * An empty (or whitespace-only) query returns all skills unchanged.
 */
export function filterSkills(
  skills: CompanySkillListItem[],
  query: string,
): CompanySkillListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q),
  );
}

export interface SlashMatch {
  /** Whether the text up to the caret ends in an open `/token`. */
  active: boolean;
  /** The captured word characters after the `/` (may be empty). */
  query: string;
  /**
   * Index in the original string where the `/` of the token begins.
   * -1 when there is no match. Used to splice in the directive.
   */
  start: number;
}

const NO_MATCH: SlashMatch = { active: false, query: "", start: -1 };

/**
 * Detect an in-progress slash command at the caret.
 *
 * Matches a `/` that sits at the very start of the input or immediately
 * after whitespace, followed by zero or more word characters, anchored to
 * the end of the supplied substring (which should be the text UP TO the
 * caret — not the whole textarea value). This means:
 *   - "/"            → active, query ""
 *   - "/spr"         → active, query "spr"
 *   - "hello /spr"   → active, query "spr"  (slash after a space)
 *   - "/foo bar"     → NOT active (token completed by the space)
 *   - "path/to/file" → NOT active (slash not at start / after whitespace)
 *   - "no slash"     → NOT active
 *
 * `start` points at the `/` so the caller can replace `[start, caret)`.
 */
export function matchSlashToken(textUpToCaret: string): SlashMatch {
  const m = /(^|\s)\/(\w*)$/.exec(textUpToCaret);
  if (!m) return NO_MATCH;
  // m[1] is the leading boundary ("" at string start, or the whitespace char).
  // The `/` therefore begins at the end of that boundary group.
  const start = m.index + m[1].length;
  return { active: true, query: m[2], start };
}

/**
 * Build the invocation directive inserted on skill selection.
 *
 * Includes BOTH the human name and the exact key so Commander reliably
 * resolves the skill: its prompt (`buildCompactSkillList`) lists skills by
 * name + key and instructs it to call `use_skill` with the key.
 */
export function buildSkillDirective(skill: {
  name: string;
  key: string;
}): string {
  return `Use the "${skill.name}" skill (${skill.key}).`;
}
