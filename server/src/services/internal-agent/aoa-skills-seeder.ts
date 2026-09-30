import type { Db } from "@armyofagents/db";
import { companySkills } from "@armyofagents/db";
import catalog from "./generated/aoa-native-skills.json" with { type: "json" };

export interface AoaSkillDefinition {
  key: string;
  name: string;
  description: string;
  triggerPhrases: string[];
  markdown: string;
}

export const AOA_NATIVE_SKILLS: AoaSkillDefinition[] = catalog.skills;

/**
 * Seed AoA-native skills into a company's skill catalog.
 * Uses ON CONFLICT DO NOTHING so re-running is safe.
 */
export async function seedAoaNativeSkills(db: Db, companyId: string): Promise<void> {
  for (const skill of AOA_NATIVE_SKILLS) {
    // Derive slug from the key: strip "skill:aoa/" prefix
    const slug = skill.key.replace(/^skill:aoa\//, "aoa-");
    await db
      .insert(companySkills)
      .values({
        companyId,
        key: skill.key,
        slug,
        name: skill.name,
        description: skill.description,
        triggerPhrases: skill.triggerPhrases,
        markdown: skill.markdown,
        sourceType: "builtin",
      })
      .onConflictDoNothing();
  }
}
