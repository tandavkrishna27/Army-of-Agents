import type { UniversePreferences } from "@armyofagents/shared";

export type MotionMode = UniversePreferences["motion"];
export type MotionTokens = { panel: number; camera: number; glow: number; pulse: boolean };

export function resolveMotionTokens(preference: MotionMode, osReduced: boolean): MotionTokens {
  if (osReduced || preference === "reduced") return { panel: 0, camera: 0, glow: 600, pulse: false };
  if (preference === "full") return { panel: 220, camera: 340, glow: 2000, pulse: true };
  return { panel: 180, camera: 280, glow: 1700, pulse: true };
}
