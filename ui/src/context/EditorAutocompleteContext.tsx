import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { buildSkillMentionHref, normalizeSkillSlug } from "@armyofagents/shared";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCommandOption {
  /** Unique key for React lists, e.g. `"skill:abc-123"`. */
  id: string;
  kind: "skill";
  skillId: string;
  /** Raw skill key (the aoa.* namespace key). */
  key: string;
  name: string;
  slug: string;
  description: string | null;
  /** Pre-built `skill://skillId?s=slug` href ready for insertion. */
  href: string;
  /** Strings to match user slash-query against (slug + name + key). */
  aliases: string[];
}

interface ContextValue {
  slashCommands: SkillCommandOption[];
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const EditorAutocompleteCtx = createContext<ContextValue>({
  slashCommands: [],
  isLoading: false,
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface EditorAutocompleteProviderProps {
  companyId: string | null;
  children: ReactNode;
}

export function EditorAutocompleteProvider({
  companyId,
  children,
}: EditorAutocompleteProviderProps) {
  const { data: skills = [], isLoading } = useQuery<CompanySkillListItem[]>({
    queryKey: companyId
      ? queryKeys.companySkills.list(companyId)
      : (["companySkills", "noop"] as const),
    queryFn: () =>
      companyId ? companySkillsApi.list(companyId) : Promise.resolve([]),
    enabled: Boolean(companyId),
  });

  const slashCommands = useMemo<SkillCommandOption[]>(
    () =>
      skills.map((s) => {
        // Prefer the stored slug; fall back to normalising the name or key.
        const slug =
          s.slug || normalizeSkillSlug(s.name ?? s.key ?? s.id);
        return {
          id: `skill:${s.id}`,
          kind: "skill" as const,
          skillId: s.id,
          key: s.key,
          name: s.name,
          slug,
          description: s.description ?? null,
          href: buildSkillMentionHref(s.id, slug),
          aliases: [slug, s.name, s.key].filter(Boolean) as string[],
        };
      }),
    [skills],
  );

  return (
    <EditorAutocompleteCtx.Provider value={{ slashCommands, isLoading }}>
      {children}
    </EditorAutocompleteCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function useEditorAutocomplete(): ContextValue {
  return useContext(EditorAutocompleteCtx);
}
