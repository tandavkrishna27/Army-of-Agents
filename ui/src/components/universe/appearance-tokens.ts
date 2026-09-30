import type { UniversePreferences } from "@armyofagents/shared";

export const UNIVERSE_ACCENTS: Record<UniversePreferences["accent"], string> = {
  brand_red: "#c33f47",
  teal: "#247e76",
  indigo: "#5867c5",
  amber: "#956914",
};

const channel = (value: number) => {
  const normalized = value / 255;
  return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
};
export function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return .2126 * channel((value >> 16) & 255) + .7152 * channel((value >> 8) & 255) + .0722 * channel(value & 255);
  };
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + .05) / (dark + .05);
}
