import type { RoutineVariable } from "@armyofagents/shared";
import { stringifyRoutineVariableValue } from "@armyofagents/shared";
import { unprocessable } from "../errors.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanVariableValue(name: string, raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw unprocessable(`Variable "${name}" must be a boolean`);
}

function parseNumberVariableValue(name: string, raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw unprocessable(`Variable "${name}" must be a number`);
}

export function normalizeRoutineVariableValue(
  variable: RoutineVariable,
  raw: unknown,
): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);

  const normalized = stringifyRoutineVariableValue(raw);
  if (variable.type === "select") {
    if (!variable.options.includes(normalized)) {
      throw unprocessable(
        `Variable "${variable.name}" must match one of: ${variable.options.join(", ")}`,
      );
    }
  }
  return normalized;
}

function isMissingValue(value: string | number | boolean | null): boolean {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function collectProvidedRoutineVariables(
  source: "schedule" | "manual" | "api" | "webhook",
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const nestedVariables =
    isPlainRecord(payload) && isPlainRecord(payload.variables) ? payload.variables : {};
  const provided: Record<string, unknown> = {
    ...(source === "webhook" && payload ? payload : {}),
    ...nestedVariables,
    ...(variables ?? {}),
  };
  delete provided.variables;
  return provided;
}

export function resolveRoutineVariableValues(
  variables: RoutineVariable[],
  input: {
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
  },
): Record<string, string | number | boolean> {
  if (variables.length === 0) return {};
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    const candidate =
      provided[variable.name] !== undefined ? provided[variable.name] : variable.defaultValue;
    const normalized = normalizeRoutineVariableValue(variable, candidate);
    if (isMissingValue(normalized)) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = normalized as string | number | boolean;
  }

  if (missing.length > 0) {
    throw unprocessable(`Missing routine variables: ${missing.join(", ")}`);
  }

  return resolved;
}

/**
 * Merges caller-supplied variableOverrides (from the run request body) with
 * the routine's stored defaults.  Unknown override keys are rejected with an
 * error so the caller gets a clear 422.
 */
export function resolveRoutineRunVariables(
  routine: { variables: RoutineVariable[] },
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const v of routine.variables ?? []) {
    resolved[v.name] = v.defaultValue != null ? String(v.defaultValue) : "";
  }
  if (overrides) {
    for (const [k, val] of Object.entries(overrides)) {
      if (!(k in resolved)) {
        throw unprocessable(`Unknown routine variable: "${k}"`);
      }
      resolved[k] = val;
    }
  }
  return resolved;
}

export function mergeRoutineRunPayload(
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, string | number | boolean>,
): Record<string, unknown> | null {
  if (Object.keys(variables).length === 0) return payload ?? null;
  if (!payload) return { variables };
  const existingVariables = isPlainRecord(payload.variables) ? payload.variables : {};
  return {
    ...payload,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}
