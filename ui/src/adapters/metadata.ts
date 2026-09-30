import type { UIAdapterModule } from "./types";
import { listUIAdapters } from "./registry";
import { isAdapterTypeHidden } from "./disabled-store";
import { getAdapterDisplay, getAdapterLabel } from "./adapter-display-registry";

export interface AdapterOptionMetadata {
  value: string;
  label: string;
  comingSoon: boolean;
  hidden: boolean;
  experimental: boolean;
}

export function listKnownAdapterTypes(): string[] {
  return listUIAdapters().map((adapter) => adapter.type);
}

export function isEnabledAdapterType(type: string): boolean {
  return !getAdapterDisplay(type).comingSoon;
}

export function isValidAdapterType(type: string): boolean {
  return !getAdapterDisplay(type).comingSoon;
}

export function isVisualAdapterChoice(type: string): boolean {
  return !getAdapterDisplay(type).hideFromVisualSelection;
}

export function listAdapterOptions(
  labelFor?: (type: string) => string,
  adapters: UIAdapterModule[] = listUIAdapters(),
): AdapterOptionMetadata[] {
  const getLabel = labelFor ?? getAdapterLabel;
  return adapters.map((adapter) => ({
    value: adapter.type,
    label: getLabel(adapter.type),
    comingSoon: Boolean(getAdapterDisplay(adapter.type).comingSoon),
    hidden: isAdapterTypeHidden(adapter.type),
    experimental: Boolean(getAdapterDisplay(adapter.type).experimental),
  }));
}

export function listVisibleUIAdapters(): UIAdapterModule[] {
  return listUIAdapters().filter((adapter) => !isAdapterTypeHidden(adapter.type));
}

export function listVisibleAdapterTypes(): string[] {
  return listVisibleUIAdapters().map((adapter) => adapter.type);
}
