import type { TeamBox } from "./teamBoundingBox";

interface Props {
  boxes: TeamBox[];
}

export function TeamOrgOverlay({ boxes }: Props) {
  return (
    <>
      {boxes.map((b) => (
        <div
          key={b.teamId}
          style={{
            position: "absolute",
            left: b.x,
            top: b.y,
            width: b.width,
            height: b.height,
            background: `${b.color}11`, // 7% alpha hex (11 in hex = ~6.7%)
            border: `1.5px dashed ${b.color}80`, // 50% alpha
            borderRadius: 12,
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          <span
            style={{
              position: "absolute",
              top: -10,
              left: 12,
              background: b.color,
              color: "white",
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 4,
              letterSpacing: 0.3,
              pointerEvents: "auto",
            }}
          >
            ⭐ {b.name.toUpperCase()}
          </span>
        </div>
      ))}
    </>
  );
}
