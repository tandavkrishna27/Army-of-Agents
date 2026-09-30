import { useState } from "react";
import { STATUS_COLORS, MERGE_COLOR } from "./git-arc-draw";
import { NEUTRAL_GREY } from "./git-arc-layout";

/** Trunk LINE colour = default-branch blue. Same hex as MERGE_COLOR by default;
 * the legend distinguishes trunk vs merge by SHAPE (thick line vs diamond). */
const TRUNK_BLUE = "#6470DC";

/** Collapsible legend explaining the Map's glyphs and status colours.
 * Mirrors exactly what git-arc-draw renders (see ui/dev-harness/git-map-final.ts). */
export function GitGraphLegend() {
  // Default collapsed so the legend doesn't cover the graph on arrival.
  const [open, setOpen] = useState(false);

  // Active states render a coloured dot. Terminal states (done/cancelled)
  // render a slate glyph instead — see the rows after this map.
  const statusRows: Array<{ color: string; label: string }> = [
    { color: STATUS_COLORS.todo, label: "Todo" },
    { color: STATUS_COLORS.in_progress, label: "In progress" },
    { color: STATUS_COLORS.in_review, label: "In review" },
    { color: STATUS_COLORS.blocked, label: "Blocked" },
  ];

  return (
    <div className="absolute top-3 left-3 z-10 select-none">
      <button
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#1e1d1c]/90 border border-[#2e2c2a] text-[11px] text-[#7E8AA8] hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span> Legend
      </button>
      {open && (
        <div className="mt-1 p-2.5 rounded bg-[#141312]/95 border border-[#2e2c2a] text-[11px] text-[#ccc] space-y-2 w-52">
          {/* Structure */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Graph</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-[3px] rounded shrink-0" style={{ background: TRUNK_BLUE }} /> Trunk (main)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-[2px] rounded shrink-0" style={{ background: NEUTRAL_GREY }} /> Branch
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: NEUTRAL_GREY }} /> Commit
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> Branch head (no task)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rotate-45 shrink-0" style={{ background: MERGE_COLOR }} /> Merge
            </div>
          </div>

          {/* Tasks */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Task (status colour)</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 h-3 rounded-sm border shrink-0" style={{ borderColor: STATUS_COLORS.in_progress, background: "#0f0e0d" }} /> Task card
            </div>
            {statusRows.map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: r.color }} />
                {r.label}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="inline-flex w-2.5 justify-center shrink-0 text-[#9aa0aa]">✓</span> Done
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex w-2.5 justify-center shrink-0 text-[#9aa0aa]">✕</span> Cancelled
            </div>
          </div>

          {/* Stubs + sync */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Markers</div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 border-t border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> Open branch (more ahead)
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-5 border-t border-dashed shrink-0" style={{ borderColor: NEUTRAL_GREY }} /> From older history
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-medium" style={{ color: STATUS_COLORS.in_progress }}>↑</span>
              <span className="shrink-0 font-medium" style={{ color: STATUS_COLORS.in_review }}>↓</span>
              ahead / behind remote
            </div>
          </div>

          {/* Badges */}
          <div className="space-y-1 pt-1 border-t border-[#2e2c2a]">
            <div className="text-[10px] uppercase tracking-wide text-[#7E8AA8]">Badges</div>
            <div className="flex items-center gap-2"><span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[#4FB67E] text-[7px] text-white shrink-0">✓</span> CI passing</div>
            <div className="flex items-center gap-2"><span className="inline-flex items-center justify-center px-1 h-3.5 rounded bg-[#6470DC]/30 border border-[#6470DC] text-[7px] text-[#8490e8] shrink-0">PR</span> Pull request</div>
            <div className="flex items-center gap-2"><span className="text-[#ffa040] shrink-0">⚠</span> Conflicts</div>
          </div>
        </div>
      )}
    </div>
  );
}
