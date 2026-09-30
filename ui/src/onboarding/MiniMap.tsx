import { Reveal } from "./motion";
import { MapDiagram } from "./mapDiagram";

export type MiniMapProps = {
  className?: string;
  /** Small caption above the diagram — defaults to the WS10 invited copy
   * ("the machine you're joining"). */
  caption?: string;
};

/**
 * WS9/WS10 — a slim, read-only variant of `Map` (no door band): used by the
 * invited-teammate journey to show "the machine you're joining" without any
 * persona fork (invited teammates don't pick a door — see WS10 scope note in
 * the implementation plan: invited flow = profile → mini-Map → Home).
 */
export function MiniMap({ className, caption = "The machine you're joining" }: MiniMapProps) {
  return (
    <div className={className}>
      <Reveal>
        <p className="m-0 mb-2 font-mono text-xs text-dim">{caption}</p>
      </Reveal>
      <Reveal delay={0.09}>
        <MapDiagram />
      </Reveal>
    </div>
  );
}
