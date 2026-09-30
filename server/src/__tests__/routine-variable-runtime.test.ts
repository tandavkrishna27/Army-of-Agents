import { describe, expect, it } from "vitest";
import type { RoutineVariable } from "@armyofagents/shared";
import {
  mergeRoutineRunPayload,
  normalizeRoutineVariableValue,
  resolveRoutineVariableValues,
} from "../services/routine-variable-runtime.js";

function variable(overrides: Partial<RoutineVariable> & { name: string }): RoutineVariable {
  return {
    name: overrides.name,
    label: overrides.label ?? null,
    type: overrides.type ?? "text",
    defaultValue: overrides.defaultValue ?? null,
    required: overrides.required ?? true,
    options: overrides.options ?? [],
  };
}

describe("normalizeRoutineVariableValue", () => {
  it("returns null for nullish input", () => {
    expect(normalizeRoutineVariableValue(variable({ name: "n" }), null)).toBeNull();
    expect(normalizeRoutineVariableValue(variable({ name: "n" }), undefined)).toBeNull();
  });

  it("coerces strings to booleans for boolean type", () => {
    const v = variable({ name: "flag", type: "boolean" });
    expect(normalizeRoutineVariableValue(v, "true")).toBe(true);
    expect(normalizeRoutineVariableValue(v, "no")).toBe(false);
    expect(() => normalizeRoutineVariableValue(v, "maybe")).toThrow(/boolean/);
  });

  it("coerces strings to numbers for number type", () => {
    const v = variable({ name: "count", type: "number" });
    expect(normalizeRoutineVariableValue(v, "42")).toBe(42);
    expect(() => normalizeRoutineVariableValue(v, "not-a-number")).toThrow(/number/);
  });

  it("validates select options", () => {
    const v = variable({ name: "kind", type: "select", options: ["a", "b"] });
    expect(normalizeRoutineVariableValue(v, "a")).toBe("a");
    expect(() => normalizeRoutineVariableValue(v, "z")).toThrow(/match one of/);
  });
});

describe("resolveRoutineVariableValues", () => {
  it("returns empty object when routine has no variables", () => {
    expect(resolveRoutineVariableValues([], { source: "manual" })).toEqual({});
  });

  it("resolves provided values from variables input", () => {
    const vars = [variable({ name: "name" })];
    const result = resolveRoutineVariableValues(vars, {
      source: "manual",
      variables: { name: "alice" },
    });
    expect(result).toEqual({ name: "alice" });
  });

  it("falls back to defaultValue when not provided", () => {
    const vars = [variable({ name: "name", defaultValue: "bob" })];
    const result = resolveRoutineVariableValues(vars, { source: "manual" });
    expect(result).toEqual({ name: "bob" });
  });

  it("throws when required variable is missing and has no default", () => {
    const vars = [variable({ name: "name", required: true })];
    expect(() => resolveRoutineVariableValues(vars, { source: "manual" })).toThrow(
      /Missing routine variables: name/,
    );
  });

  it("silently drops unknown variable names", () => {
    const vars = [variable({ name: "name", defaultValue: "x" })];
    const result = resolveRoutineVariableValues(vars, {
      source: "manual",
      variables: { bogus: "ignored", name: "y" },
    });
    expect(result).toEqual({ name: "y" });
  });

  it("reads webhook payload at top-level when source is webhook", () => {
    const vars = [variable({ name: "repo" })];
    const result = resolveRoutineVariableValues(vars, {
      source: "webhook",
      payload: { repo: "aoa", other: "ignored" },
    });
    expect(result).toEqual({ repo: "aoa" });
  });
});

describe("mergeRoutineRunPayload", () => {
  it("returns null when no variables and no payload", () => {
    expect(mergeRoutineRunPayload(null, {})).toBeNull();
  });

  it("returns payload unchanged when no variables", () => {
    expect(mergeRoutineRunPayload({ hello: "world" }, {})).toEqual({ hello: "world" });
  });

  it("wraps variables into payload when payload is null", () => {
    expect(mergeRoutineRunPayload(null, { a: 1 })).toEqual({ variables: { a: 1 } });
  });

  it("merges into existing variables sub-object", () => {
    expect(
      mergeRoutineRunPayload({ variables: { a: 1 }, other: "x" }, { b: 2 }),
    ).toEqual({ variables: { a: 1, b: 2 }, other: "x" });
  });
});
