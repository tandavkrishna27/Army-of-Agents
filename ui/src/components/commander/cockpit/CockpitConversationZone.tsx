import { MessagesSquare, FileText } from "lucide-react";
import type { ShowRef } from "@armyofagents/shared";
// NOTE: sibling cards (CockpitReviewCard etc.) use the inline section classes below
// (`rounded-lg border border-border bg-background p-2`), NOT the panel-level
// COMMANDER_PANEL_CARD (which is the rounded-xl PANEL wrapper). Mirror the cards.

export function CockpitConversationZone({
  refs,
  onOpen,
}: {
  refs: ShowRef[];
  // Pass the WHOLE ref (Codex #1): opening must preserve versionId, like the
  // viewer home does — a lossy (id,title) rebuild would open the latest version.
  onOpen?: (ref: ShowRef) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-background p-2" data-testid="cockpit-zone-conversation">
      <header className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <MessagesSquare className="size-3.5" aria-hidden />
        In this conversation
        <span className="ml-auto tabular-nums">{refs.length}</span>
      </header>
      <ul className="space-y-0.5">
        {refs.map((r) => {
          const title = r.title ?? `Artifact ${r.id.slice(0, 8)}`;
          return (
            <li key={`${r.id}:${r.versionId ?? "latest"}`}
                className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50">
              <button type="button" className="min-w-0 flex-1 truncate text-left"
                      onClick={() => onOpen?.(r)}>
                <FileText className="mr-1 inline size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-medium">{title}</span>
              </button>
              {r.action === "created" && (
                <span className="shrink-0 text-[10px] text-muted-foreground">created</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
