import { LLMProvidersSection } from "@/components/LLMProvidersSection";

/**
 * Embeddings/OpenAI-key config (CLAUDE.md Rule #11 — the only hosted key).
 *
 * `embedded`: rendered inside another section (e.g. MemorySettingsSection) — drops
 * the standalone "Memory." page header for a compact "Embeddings" sub-header so the
 * composed page has a single header hierarchy. Standalone (default) keeps the full
 * page header for any direct Settings-route use.
 */
export function LLMProvidersSectionWrapper({ embedded = false }: { embedded?: boolean } = {}) {
  if (embedded) {
    return (
      <div>
        <div className="px-8 pt-6 pb-3">
          <h3 className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
            Embeddings
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            API key for the embeddings model — used only for semantic memory search.
          </p>
        </div>
        <div className="px-8 pb-8">
          <LLMProvidersSection />
        </div>
      </div>
    );
  }
  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Memory<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          API key for the embeddings model — used only for semantic memory search.
        </p>
      </div>
      <div className="p-8">
        <LLMProvidersSection />
      </div>
    </div>
  );
}
