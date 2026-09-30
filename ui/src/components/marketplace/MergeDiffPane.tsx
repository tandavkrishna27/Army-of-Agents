import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SectionDiff } from "./types.js";

interface MergeDiffPaneProps {
  sections: SectionDiff[];
  onChange: (decisions: Record<string, "mine" | "theirs">) => void;
}

export function MergeDiffPane({ sections, onChange }: MergeDiffPaneProps) {
  const [decisions, setDecisions] = useState<Record<string, "mine" | "theirs">>(() => {
    const init: Record<string, "mine" | "theirs"> = {};
    for (const s of sections) {
      init[s.header] = s.state === "added" ? "theirs" : "mine";
    }
    return init;
  });

  useEffect(() => {
    onChange(decisions);
    // Only run on mount — decisions is stable from useState initializer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(header: string, choice: "mine" | "theirs") {
    const next = { ...decisions, [header]: choice };
    setDecisions(next);
    onChange(next);
  }

  /**
   * Bulk choice. "Accept all upstream" is not a convenience — it is the only
   * affordance that drains an agent whose customization state was merely
   * *unknown* (`instructions_customized IS NULL`, every crew agent installed
   * before migration 0182). Those bundles usually hold nothing but older
   * catalog content, and the per-section default of "mine" would otherwise
   * keep re-declaring them customized on every review, freezing them out of
   * auto-update forever.
   */
  function pickAll(choice: "mine" | "theirs") {
    const next: Record<string, "mine" | "theirs"> = {};
    for (const s of sections) next[s.header] = choice;
    setDecisions(next);
    onChange(next);
  }

  // Gated on `sections.length`, NOT on "has a section whose state is changed".
  // `computeSectionDiff` calls a section `unchanged` when the two sides are
  // TRIM-equal, while the merge only treats a file as wholesale-upstream when
  // they are BYTE-equal. So an all-`unchanged` review can still be a real
  // divergence — trailing whitespace — and unchanged sections render no
  // per-section buttons. Hiding the bar there left the founder with literally
  // no control that could resolve the update to upstream, and therefore no way
  // out of `instructions_customized = true`.
  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      {sections.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => pickAll("mine")}>
            Keep all mine
          </Button>
          <Button size="sm" variant="ghost" onClick={() => pickAll("theirs")}>
            Accept all upstream
          </Button>
        </div>
      )}
      {sections.map((section) => {
        const decision = decisions[section.header] ?? "mine";
        const unchanged = section.state === "unchanged";
        // Agent bundles send `file` + `section`; skills send neither and put the
        // bare heading in `header`.
        const heading = section.section ?? section.header;
        const label = heading === "__preamble__" ? "(Introduction)" : heading;

        return (
          <div key={section.header} className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between bg-muted px-3 py-1.5">
              <span className="text-sm font-medium">
                {section.file && (
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                    {section.file}
                    {section.virtual ? " (config)" : ""} ›
                  </span>
                )}
                {label}
              </span>
              <Badge
                variant={
                  section.state === "added"
                    ? "default"
                    : section.state === "removed"
                      ? "destructive"
                      : section.state === "changed"
                        ? "secondary"
                        : "outline"
                }
                className="text-xs capitalize"
              >
                {section.state}
              </Badge>
            </div>

            {unchanged ? (
              <p className="text-xs text-muted-foreground px-3 py-2">No changes in this section.</p>
            ) : (
              <div className="grid grid-cols-2 divide-x">
                {/* Mine */}
                <div
                  className={cn(
                    "p-3 cursor-pointer transition-colors",
                    decision === "mine" ? "bg-blue-50 dark:bg-blue-950" : "hover:bg-muted/50",
                  )}
                  onClick={() => pick(section.header, "mine")}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground">Mine</span>
                    {decision === "mine" && (
                      <span className="text-xs text-blue-600 dark:text-blue-400 font-semibold">
                        Selected
                      </span>
                    )}
                  </div>
                  <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80 max-h-40 overflow-y-auto">
                    {section.mine || (
                      <em className="text-muted-foreground not-italic">(none)</em>
                    )}
                  </pre>
                  <Button
                    size="sm"
                    variant={decision === "mine" ? "default" : "outline"}
                    className="mt-2 w-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(section.header, "mine");
                    }}
                  >
                    Keep mine
                  </Button>
                </div>

                {/* Theirs */}
                <div
                  className={cn(
                    "p-3 cursor-pointer transition-colors",
                    decision === "theirs" ? "bg-green-50 dark:bg-green-950" : "hover:bg-muted/50",
                  )}
                  onClick={() => pick(section.header, "theirs")}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground">Upstream</span>
                    {decision === "theirs" && (
                      <span className="text-xs text-green-600 dark:text-green-400 font-semibold">
                        Selected
                      </span>
                    )}
                  </div>
                  <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80 max-h-40 overflow-y-auto">
                    {section.theirs || (
                      <em className="text-muted-foreground not-italic">(none)</em>
                    )}
                  </pre>
                  <Button
                    size="sm"
                    variant={decision === "theirs" ? "default" : "outline"}
                    className="mt-2 w-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(section.header, "theirs");
                    }}
                  >
                    Accept upstream
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
