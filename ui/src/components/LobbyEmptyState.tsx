import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrewHero } from "@/components/lobby/CrewHero";

interface LobbyEmptyStateProps {
  onCreate: () => void;
  onImport: () => void;
}

/**
 * Crew-hero empty state shown when the lobby has zero companies.
 *
 * Dramatizes the product thesis (agents + humans) with an illustrative animated
 * crew ({@link CrewHero}), a thesis headline, and the create/import paths. The
 * crew is decorative — no company exists yet. Design-system §9.8 empty-state
 * pattern (brand-tinted radial wash bg); two CTAs so the single-action
 * EmptyState primitive is not used.
 */
export function LobbyEmptyState({ onCreate, onImport }: LobbyEmptyStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-16 bg-[radial-gradient(ellipse_60%_50%_at_50%_30%,var(--brand-wash)_0%,transparent_70%)]">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <CrewHero className="mb-7 sm:mb-9" />

        <h1 className="text-xl sm:text-2xl font-bold tracking-[-0.02em] text-foreground">
          Your team is bigger than your headcount<span className="text-brand">.</span>
        </h1>
        <p className="mt-2 max-w-md text-[0.82rem] sm:text-sm text-dim leading-relaxed">
          Create an organization and put your agents to work alongside you — humans
          and AI, one control room.
        </p>

        <div className="mt-6 sm:mt-8 flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
          <Button size="lg" onClick={onCreate}>
            <Plus />
            Create organization
          </Button>
          <Button size="lg" variant="secondary" onClick={onImport}>
            <Upload />
            Import organization
          </Button>
        </div>
      </div>
    </div>
  );
}
