let disabledTypes = new Set<string>();

export function isAdapterTypeHidden(type: string): boolean {
  return disabledTypes.has(type);
}

export function getHiddenAdapterTypes(): Set<string> {
  return new Set(disabledTypes);
}

export function setDisabledAdapterTypes(types: string[]): void {
  disabledTypes = new Set(types);
}
