import { describe, expect, it } from "vitest";
import {
  extractRoutineVariableNames,
  syncRoutineVariablesWithTemplate,
  interpolateRoutineTemplate,
  isBuiltinRoutineVariable,
  routineVariableSchema,
  createRoutineSchema,
  type RoutineVariable,
} from "@armyofagents/shared";

describe("routine-variables helpers", () => {
  it("extractRoutineVariableNames finds placeholders", () => {
    const names = extractRoutineVariableNames("Hi {{name}}, review {{topic}}.");
    expect(names).toEqual(["name", "topic"]);
  });

  it("extractRoutineVariableNames deduplicates", () => {
    const names = extractRoutineVariableNames("{{x}} and {{x}} again");
    expect(names).toEqual(["x"]);
  });

  it("syncRoutineVariablesWithTemplate creates defaults for new placeholders", () => {
    const variables = syncRoutineVariablesWithTemplate(["Do {{thing}} for {{user}}"], []);
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({
      name: "thing",
      type: "text",
      required: true,
      defaultValue: null,
      options: [],
    });
  });

  it("syncRoutineVariablesWithTemplate preserves existing metadata", () => {
    const existing: RoutineVariable[] = [
      { name: "thing", label: "The Thing", type: "number", defaultValue: 42, required: false, options: [] },
    ];
    const variables = syncRoutineVariablesWithTemplate("Do {{thing}}", existing);
    expect(variables[0]).toEqual(existing[0]);
  });

  it("syncRoutineVariablesWithTemplate drops variables no longer referenced", () => {
    const existing: RoutineVariable[] = [
      { name: "gone", label: null, type: "text", defaultValue: null, required: false, options: [] },
    ];
    const variables = syncRoutineVariablesWithTemplate("no placeholders here", existing);
    expect(variables).toEqual([]);
  });

  it("syncRoutineVariablesWithTemplate ignores builtin names like {{date}}", () => {
    const variables = syncRoutineVariablesWithTemplate("daily digest {{date}} for {{topic}}", []);
    expect(variables.map((v) => v.name)).toEqual(["topic"]);
  });

  it("isBuiltinRoutineVariable recognizes date", () => {
    expect(isBuiltinRoutineVariable("date")).toBe(true);
    expect(isBuiltinRoutineVariable("topic")).toBe(false);
  });

  it("interpolateRoutineTemplate substitutes values", () => {
    const out = interpolateRoutineTemplate("Hi {{user}}", { user: "Alice" });
    expect(out).toBe("Hi Alice");
  });

  it("interpolateRoutineTemplate leaves unmatched placeholders intact", () => {
    const out = interpolateRoutineTemplate("{{a}} and {{b}}", { a: "one" });
    expect(out).toBe("one and {{b}}");
  });
});

describe("routine variable validator", () => {
  it("accepts a fully-formed variable", () => {
    const parsed = routineVariableSchema.parse({
      name: "priority_level",
      label: "Priority level",
      type: "select",
      defaultValue: "high",
      required: true,
      options: ["high", "medium", "low"],
    });
    expect(parsed.type).toBe("select");
  });

  it("rejects invalid variable name", () => {
    expect(() =>
      routineVariableSchema.parse({
        name: "1bad",
        label: null,
        type: "text",
        defaultValue: null,
        required: true,
        options: [],
      }),
    ).toThrow();
  });

  it("rejects unknown type", () => {
    expect(() =>
      routineVariableSchema.parse({
        name: "topic",
        label: null,
        type: "color",
        defaultValue: null,
        required: true,
        options: [],
      }),
    ).toThrow();
  });

  it("createRoutineSchema accepts variables array", () => {
    const parsed = createRoutineSchema.parse({
      title: "Weekly digest",
      assigneeAgentId: "11111111-1111-1111-1111-111111111111",
      variables: [
        { name: "topic", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });
    expect(parsed.variables).toHaveLength(1);
  });
});
