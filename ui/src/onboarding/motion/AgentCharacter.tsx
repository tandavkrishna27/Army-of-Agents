export type State = "idle" | "working" | "thinking" | "done";

/**
 * AgentCharacter — the little robot. Renders the DOM tree the `.agent*`
 * CSS in motion.css targets (ported from the mockup's `agent()` factory).
 * Decorative: role="img" + aria-label (falls back to the state) so the
 * internal spans/labels aren't individually exposed to assistive tech.
 */
export function AgentCharacter({
  state = "idle",
  eyeColor,
  size = "md",
  label,
}: {
  state?: State;
  eyeColor?: string;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const cls = ["agent", size !== "md" ? size : "", state !== "idle" ? `is-${state}` : ""]
    .filter(Boolean)
    .join(" ");
  const eye = eyeColor ? { background: eyeColor } : undefined;
  return (
    <div className={cls} role="img" aria-label={label ?? `agent ${state}`}>
      <div className="a-badge">✓</div>
      <div className="a-bubbles">
        <i />
        <i />
        <i />
      </div>
      <div className="a-antenna-tip" />
      <div className="a-antenna-pole" />
      <div className="a-head">
        <div className="a-visor">
          <span className="a-eye" style={eye} />
          <span className="a-eye" style={eye} />
        </div>
      </div>
      <div className="a-body">
        <div className="a-arm l" />
        <div className="a-arm r" />
        <div className="a-leds">
          <span className="a-led" />
          <span className="a-led" />
          <span className="a-led" />
        </div>
        <div className="a-progress">
          <i />
        </div>
      </div>
      <div className="a-legs">
        <div className="a-leg">
          <div className="a-leg-u" />
          <div className="a-foot" />
        </div>
        <div className="a-leg">
          <div className="a-leg-u" />
          <div className="a-foot" />
        </div>
      </div>
      {label && <div className="a-cap">{label}</div>}
    </div>
  );
}
