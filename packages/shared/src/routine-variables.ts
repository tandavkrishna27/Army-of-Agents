import type { RoutineVariable } from "./types/routine.js";

/**
 * The grammar for a valid routine variable name: one ASCII letter followed
 * by letters / digits / underscores. Use `ROUTINE_VARIABLE_NAME_PATTERN` to
 * compose new RegExp instances (e.g., for split() with capture groups).
 */
export const ROUTINE_VARIABLE_NAME_PATTERN = "[A-Za-z][A-Za-z0-9_]*";
export const ROUTINE_VARIABLE_MATCHER = new RegExp(`\\{\\{\\s*(${ROUTINE_VARIABLE_NAME_PATTERN})\\s*\\}\\}`, "g");
type RoutineTemplateInput = string | null | undefined | Array<string | null | undefined>;

export const BUILTIN_ROUTINE_VARIABLE_NAMES = new Set(["date"]);

export function isBuiltinRoutineVariable(name: string): boolean {
  return BUILTIN_ROUTINE_VARIABLE_NAMES.has(name);
}

export function getBuiltinRoutineVariableValues(): Record<string, string> {
  return {
    date: new Date().toISOString().slice(0, 10),
  };
}

export function isValidRoutineVariableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function normalizeRoutineTemplateInput(input: RoutineTemplateInput): string[] {
  const templates = Array.isArray(input) ? input : [input];
  return templates.filter((template): template is string => typeof template === "string" && template.length > 0);
}

export function extractRoutineVariableNames(template: RoutineTemplateInput): string[] {
  const found = new Set<string>();
  for (const source of normalizeRoutineTemplateInput(template)) {
    for (const match of source.matchAll(ROUTINE_VARIABLE_MATCHER)) {
      const name = match[1];
      if (name && !found.has(name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

function defaultRoutineVariable(name: string): RoutineVariable {
  return {
    name,
    label: null,
    type: "text",
    defaultValue: null,
    required: true,
    options: [],
  };
}

export function syncRoutineVariablesWithTemplate(
  template: RoutineTemplateInput,
  existing: RoutineVariable[] | null | undefined,
): RoutineVariable[] {
  const names = extractRoutineVariableNames(template).filter((name) => !isBuiltinRoutineVariable(name));
  const existingByName = new Map((existing ?? []).map((variable) => [variable.name, variable]));
  return names.map((name) => existingByName.get(name) ?? defaultRoutineVariable(name));
}

export function stringifyRoutineVariableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function interpolateRoutineTemplate(
  template: string | null | undefined,
  values: Record<string, unknown> | null | undefined,
): string | null {
  if (template == null) return null;
  if (!values || Object.keys(values).length === 0) return template;
  return template.replace(ROUTINE_VARIABLE_MATCHER, (match, rawName: string) => {
    if (!(rawName in values)) return match;
    return stringifyRoutineVariableValue(values[rawName]);
  });
}
