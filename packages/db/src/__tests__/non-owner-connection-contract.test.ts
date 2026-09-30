import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("postgres");
  vi.resetModules();
});

describe("non-owner connection close contract", () => {
  it("requires the exact timeout input in the public TypeScript interface", () => {
    // Mutation caught: making the argument optional permits shutdown callers to silently
    // regain an unreviewed/default close bound.
    const sourceText = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("client.ts", sourceText, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "NonOwnerDbConnection");
    const close = declaration?.members.find((member): member is ts.MethodSignature =>
      ts.isMethodSignature(member) && member.name.getText(source) === "close");

    expect(declaration).toBeDefined();
    expect(close).toBeDefined();
    expect(close?.parameters).toHaveLength(1);
    expect(close?.parameters[0]?.questionToken).toBeUndefined();
    expect(close?.parameters[0]?.name.getText(source)).toBe("input");
    expect(close?.parameters[0]?.type?.getText(source).replaceAll(/\s+/g, " ")).toBe(
      "{ timeoutSeconds: number }",
    );
    expect(close?.type?.getText(source)).toBe("Promise<void>");
  });

  it("forwards the caller's exact timeout bound to postgres.js end", async () => {
    const end = vi.fn(async (_input: { timeout: number }) => undefined);
    const sqlClient = Object.assign(vi.fn(), {
      end,
      options: { parsers: {}, serializers: {} },
    });
    const postgresFactory = vi.fn(() => sqlClient);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.resetModules();

    const { createTenantAppDbConnection } = await import("../client.js");
    const connection = createTenantAppDbConnection(
      "postgres://bounded-role:fixture@127.0.0.1/example",
    );
    await connection.close({ timeoutSeconds: 2.75 });

    expect(postgresFactory).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ timeout: 2.75 });
  });

  it("rejects an omitted runtime input without invoking postgres.js end", async () => {
    // Mutation caught: retaining a default initializer after tightening the interface lets
    // untyped JavaScript callers silently regain the old implicit five-second close.
    const end = vi.fn(async (_input: { timeout: number }) => undefined);
    const sqlClient = Object.assign(vi.fn(), {
      end,
      options: { parsers: {}, serializers: {} },
    });
    vi.doMock("postgres", () => ({ default: vi.fn(() => sqlClient) }));
    vi.resetModules();

    const { createTenantAppDbConnection } = await import("../client.js");
    const connection = createTenantAppDbConnection(
      "postgres://bounded-role:fixture@127.0.0.1/example",
    );
    let failure: unknown;
    try {
      await (connection.close as unknown as () => Promise<void>)();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(end).not.toHaveBeenCalled();
  });
});
