export const AUTONOMY_LEVELS = [
  { value: 0, name: "Manual", blurb: "You drive; crew acts only when you ask." },
  { value: 1, name: "Assist", blurb: "Crew researches/builds; you approve work." },
  { value: 2, name: "Drive",  blurb: "Crew proposes + the system auto-approves." },
] as const;

export type AutonomyValue = 0 | 1 | 2;

export function isValidAutonomy(v: unknown): v is AutonomyValue {
  return v === 0 || v === 1 || v === 2;
}

export function autonomyLabel(v: number | null | undefined): string {
  if (v === null || v === undefined) return "Off";
  return AUTONOMY_LEVELS.find(l => l.value === v)?.name ?? "Off";
}
